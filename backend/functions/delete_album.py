"""Admin-only album deletion with canonical, version-aware S3 cleanup."""

import os
import logging

import boto3

from audit_helpers import actor_context, emit_audit_event
from album_media_store import delete_album_media
from auth_helpers import require_admin
from cache_invalidation import invalidate_album_media, request_public_api_invalidation
from deletion_helpers import DeletionTooLargeError, delete_prefix_all_versions, preflight_deletion
from explore_index import index_entry_keys
from media_access import album_media_prefixes, delete_preview_metadata, load_preview_metadata
from random_pool_refresh import request_random_photo_pool_refresh
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_uuid


table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])
logger = logging.getLogger("photography_api.album_write")


def _audit(event, context, outcome, reason_code, *, deleted_version_count=None):
    actor_type, auth_method = actor_context(event)
    emit_audit_event(
        event_name="admin.album_deleted",
        outcome=outcome,
        action="album.delete",
        resource_type="album",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        details={"deleted_version_count": deleted_version_count} if deleted_version_count is not None else None,
    )


from front_door import verify_front_door_request


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied
    try:
        album_id = validate_uuid(((event or {}).get("pathParameters") or {}).get("albumId"))
        album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not album:
            _audit(event, context, "denied", "album_not_found")
            return error_response(404, "Album not found", code="not_found")

        album["albumId"] = album_id
        # Strictly resolve external derivative state before the first mutation.
        # A metadata outage must not leave an anonymously readable derivative
        # behind while its album is deleted.
        preview_metadata = load_preview_metadata(album, strict=True)
        prefixes = (*album_media_prefixes(album), f"temp-zips/{album_id}/")
        preflight_deletion(prefixes=prefixes)
        deleted_versions = 0
        for prefix in prefixes:
            deleted_versions += delete_prefix_all_versions(prefix)
        if album.get("visibility") == "public":
            # Purge after origin deletion so a cache miss cannot refill with
            # the old media. Keep the album record until the purge is accepted
            # so a provider failure can be retried with the same namespaces.
            invalidate_album_media(album, reason="album-deleted", strict=True)
        delete_preview_metadata(
            album_id,
            preview_metadata.keys(),
            {media_id: index_entry_keys(metadata) for media_id, metadata in preview_metadata.items()},
        )
        table.delete_item(
            Key={"albumId": album_id},
            ConditionExpression="attribute_exists(albumId)",
        )
        try:
            delete_album_media(album_id)
        except Exception as error:
            # The album authorization record is gone, so orphaned normalized
            # rows are inaccessible and can be retried by maintenance safely.
            logger.error("album_media_cleanup_failed error_type=%s", type(error).__name__)
        if album.get("visibility") == "public":
            request_public_api_invalidation(
                album_id=album_id,
                catalog=True,
                reason="album-deleted",
            )
            if album.get("type", "photo") == "photo":
                request_random_photo_pool_refresh()
        _audit(event, context, "success", "album_deleted", deleted_version_count=deleted_versions)
        return json_response(
            200,
            {"message": "Album deleted", "deletedObjectVersions": deleted_versions},
        )
    except DeletionTooLargeError:
        _audit(event, context, "denied", "deletion_too_large")
        return error_response(
            409,
            "Album is too large for synchronous deletion; use the maintenance deletion workflow",
            code="deletion_too_large",
        )
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_request")
        return error_response(400, str(error), code="invalid_request")
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        _audit(event, context, "denied", "album_not_found")
        return error_response(404, "Album not found", code="not_found")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "delete_album")
