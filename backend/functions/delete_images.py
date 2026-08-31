"""Admin-only, manifest-authorized media deletion."""

import os
import logging

import boto3

from audit_helpers import actor_context, emit_audit_event
from album_media_store import deactivate_album_media, delete_album_media
from auth_helpers import require_admin
from cache_invalidation import invalidate_public_previews, request_public_api_invalidation
from deletion_helpers import (
    DeletionTooLargeError,
    delete_keys_all_versions,
    delete_prefix_all_versions,
    preflight_deletion,
)
from explore_index import index_entry_keys
from media_access import (
    delete_preview_metadata,
    load_preview_metadata,
    media_id_for_key,
    serialize_album_summary,
    validate_album_media_key,
    validated_preview_keys,
)
from response_helpers import error_response, internal_error, json_response
from random_pool_refresh import request_random_photo_pool_refresh
from validation_helpers import ValidationError, parse_json_body, require_string, validate_list, validate_uuid


table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])
logger = logging.getLogger("photography_api.album_write")


def _audit(event, context, outcome, reason_code, *, deleted_count=None, deleted_version_count=None):
    actor_type, auth_method = actor_context(event)
    details = {}
    if deleted_count is not None:
        details["deleted_count"] = deleted_count
    if deleted_version_count is not None:
        details["deleted_version_count"] = deleted_version_count
    emit_audit_event(
        event_name="admin.media_deleted",
        outcome=outcome,
        action="album.media.delete",
        resource_type="media",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        details=details or None,
    )


def _raw_key(image):
    return image.get("rawKey") or image.get("key") if isinstance(image, dict) else ""


def _cover_fields(image):
    if not isinstance(image, dict):
        return _raw_key(image), "", ""
    return _raw_key(image), image.get("thumbKey", ""), image.get("blurhash", "")


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
        body = parse_json_body(event, max_bytes=64 * 1024)
        requested = {
            require_string(key, "keys[]", maximum=1024)
            for key in validate_list(body.get("keys"), "keys", maximum=250, required=True)
        }
        album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not album:
            _audit(event, context, "denied", "album_not_found")
            return error_response(404, "Album not found", code="not_found")

        images = album.get("images", []) if isinstance(album.get("images", []), list) else []
        removed = []
        retained = []
        exact_keys = set()
        removed_media_ids = set()
        preview_metadata = load_preview_metadata(album, strict=True)
        hls_prefixes = set()
        for image in images:
            raw_key = _raw_key(image)
            if raw_key in requested:
                raw_key = validate_album_media_key(raw_key, album=album)
                removed.append(image)
                exact_keys.add(raw_key)
                media_id = media_id_for_key(raw_key)
                removed_media_ids.add(media_id)
                if isinstance(image, dict) and image.get("thumbKey"):
                    exact_keys.add(validate_album_media_key(image["thumbKey"], album=album))
                if isinstance(image, dict):
                    exact_keys.update(validated_preview_keys(
                        image,
                        album,
                        preview_metadata.get(media_id),
                        allow_pending=True,
                    ).values())
                if "." in raw_key:
                    hls_prefixes.add(
                        validate_album_media_key(raw_key.rsplit(".", 1)[0] + "_hls/", album=album).rstrip("/") + "/"
                    )
            else:
                retained.append(image)

        if not removed:
            _audit(event, context, "denied", "media_not_found")
            return error_response(404, "Requested media was not found in this album", code="not_found")
        if requested - {_raw_key(image) for image in removed}:
            _audit(event, context, "denied", "media_not_in_album")
            return error_response(400, "One or more media keys are not in this album", code="invalid_media")

        cover_raw = album.get("coverImageUrl", "")
        cover_thumb = album.get("coverThumbKey", "")
        removed_raw_keys = {_raw_key(image) for image in removed}
        cover_needs_replacement = cover_raw in removed_raw_keys or cover_thumb in exact_keys
        if cover_needs_replacement:
            cover_source = next(
                (image for image in retained if _raw_key(image) == cover_raw),
                retained[0] if retained else None,
            )
            cover_raw, cover_thumb, cover_blurhash = _cover_fields(cover_source)
        else:
            cover_blurhash = album.get("coverBlurhash", "")

        # Enumerate and bound every affected object version before the first
        # mutation. If S3 then fails, the manifest remains intact and retryable.
        preflight_deletion(keys=exact_keys, prefixes=hls_prefixes)
        if album.get("visibility") == "public":
            invalidate_public_previews(
                album_id,
                reason="album-media-deleted",
                strict=True,
            )
        deleted_versions = delete_keys_all_versions(exact_keys)
        for hls_prefix in hls_prefixes:
            deleted_versions += delete_prefix_all_versions(hls_prefix)

        delete_preview_metadata(
            album_id,
            removed_media_ids,
            {
                media_id: index_entry_keys(preview_metadata.get(media_id, {}))
                for media_id in removed_media_ids
            },
        )
        table.update_item(
            Key={"albumId": album_id},
            UpdateExpression=(
                "SET images = :images, imageCount = :count, coverImageUrl = :cover, "
                "coverThumbKey = :coverThumb, coverBlurhash = :coverBlurhash"
            ),
            ConditionExpression="attribute_exists(albumId)",
            ExpressionAttributeValues={
                ":images": retained,
                ":count": len(retained),
                ":cover": cover_raw,
                ":coverThumb": cover_thumb,
                ":coverBlurhash": cover_blurhash,
            },
        )
        if album.get("mediaStoreVersion") == 1:
            try:
                if not delete_album_media(album_id, removed_media_ids):
                    deactivate_album_media(table, album_id)
            except Exception as error:
                logger.error("album_media_delete_failed error_type=%s", type(error).__name__)
                deactivate_album_media(table, album_id)
        if album.get("visibility") == "public":
            request_public_api_invalidation(
                album_id=album_id,
                catalog=True,
                reason="album-media-deleted",
            )
            if album.get("type", "photo") == "photo":
                request_random_photo_pool_refresh()
        updated_album = {
            "albumId": album_id,
            "imageCount": len(retained),
            "coverImageUrl": cover_raw,
            "coverThumbKey": cover_thumb,
            "coverBlurhash": cover_blurhash,
        }
        try:
            response_album = serialize_album_summary(
                {**album, "images": retained, **updated_album},
                include_admin=True,
            )
        except ValidationError:
            # Compatibility for malformed legacy metadata: the destructive
            # operation already succeeded, so return only validated raw fields.
            response_album = updated_album
        _audit(
            event,
            context,
            "success",
            "media_deleted",
            deleted_count=len(removed),
            deleted_version_count=deleted_versions,
        )
        return json_response(
            200,
            {
                "message": "Media deleted",
                "deletedCount": len(removed),
                "deletedObjectVersions": deleted_versions,
                "album": response_album,
            },
        )
    except DeletionTooLargeError:
        _audit(event, context, "denied", "deletion_too_large")
        return error_response(
            413,
            "Media deletion is too large for synchronous processing; use the maintenance deletion workflow",
            code="deletion_too_large",
        )
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_request")
        return error_response(400, str(error), code="invalid_request")
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        _audit(event, context, "denied", "album_conflict")
        return error_response(409, "Album changed while media was being deleted", code="conflict")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "delete_images")
