"""Admin-only, manifest-authorized media deletion."""

import os
import logging
import uuid

import boto3
import drive_backup_jobs

from audit_helpers import actor_context, emit_audit_event
from album_media_store import deactivate_album_media, delete_album_media
from auth_helpers import require_admin
from cache_invalidation import invalidate_album_media, request_public_api_invalidation
from deletion_helpers import (
    DeletionTooLargeError,
    delete_keys_all_versions,
    delete_prefix_all_versions,
    preflight_deletion,
)
from explore_index import index_entry_keys
from dynamodb_helpers import ensure_album_item_budget
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
        if not album or album.get("status", "active") != "active":
            _audit(event, context, "denied", "album_not_found")
            return error_response(404, "Album not found", code="not_found")

        pending = album.get("pendingMediaDeletion")
        if pending:
            if set(pending.get("requested", [])) != requested:
                return error_response(409, "A previous deletion is still being completed. Retry that deletion first.", code="deletion_pending")
            return _complete_deletion(album, pending, event, context)

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

        # Preflight is read-only. Commit the manifest and durable cleanup intent
        # before touching any object, so a concurrent edit cannot leave dangling
        # references to files that this request already deleted.
        preflight_deletion(keys=exact_keys, prefixes=hls_prefixes)
        pending = {
            "id": uuid.uuid4().hex,
            "requested": sorted(requested),
            "keys": sorted(exact_keys),
            "prefixes": sorted(hls_prefixes),
            "mediaIds": sorted(removed_media_ids),
            "indexKeys": {media_id: index_entry_keys(preview_metadata.get(media_id, {})) for media_id in removed_media_ids},
            "wasPublic": album.get("visibility") == "public",
        }
        updated_album = {**album, "images": retained, "imageCount": len(retained),
                         "coverImageUrl": cover_raw, "coverThumbKey": cover_thumb,
                         "coverBlurhash": cover_blurhash, "pendingMediaDeletion": pending}
        ensure_album_item_budget(updated_album)
        drive_backup_jobs.update_album(
            table, album, removed_keys=removed_raw_keys,
            Key={"albumId": album_id},
            UpdateExpression=(
                "SET images = :images, imageCount = :count, coverImageUrl = :cover, "
                "coverThumbKey = :coverThumb, coverBlurhash = :coverBlurhash, pendingMediaDeletion = :pending"
            ),
            ConditionExpression="attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status = :active) AND images = :previous_images AND attribute_not_exists(pendingMediaDeletion) AND (attribute_not_exists(#visibility) OR #visibility = :visibility) AND (attribute_not_exists(coverImageUrl) OR coverImageUrl = :previous_cover) AND (attribute_not_exists(coverThumbKey) OR coverThumbKey = :previous_thumb)",
            ExpressionAttributeNames={"#visibility": "visibility", "#status": "status"},
            ExpressionAttributeValues={
                ":active": "active",
                ":pending": pending,
                ":visibility": album.get("visibility", "private"),
                ":previous_cover": album.get("coverImageUrl", ""),
                ":previous_thumb": album.get("coverThumbKey", ""),
                ":images": retained,
                ":previous_images": album.get("images", []),
                ":count": len(retained),
                ":cover": cover_raw,
                ":coverThumb": cover_thumb,
                ":coverBlurhash": cover_blurhash,
            },
        )
        return _complete_deletion(updated_album, pending, event, context)
    except DeletionTooLargeError:
        _audit(event, context, "denied", "deletion_too_large")
        return error_response(
            413,
            "Media deletion is too large for synchronous processing; use the maintenance deletion workflow",
            code="deletion_too_large",
        )
    except drive_backup_jobs.DriveBackupBusy as error:
        return error_response(409, str(error), code="backup_busy")
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_request")
        return error_response(400, str(error), code="invalid_request")
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        _audit(event, context, "denied", "album_conflict")
        return error_response(409, "Album changed while media was being deleted", code="conflict")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "delete_images")


def _complete_deletion(album, pending, event, context):
    album_id = album["albumId"]
    removed_media_ids = set(pending["mediaIds"])
    # Validate the durable server-written scope again before destructive work.
    keys = [validate_album_media_key(key, album=album) for key in pending["keys"]]
    prefixes = [validate_album_media_key(key, album=album).rstrip("/") + "/" for key in pending["prefixes"]]
    deleted_versions = delete_keys_all_versions(keys)
    for prefix in prefixes:
        deleted_versions += delete_prefix_all_versions(prefix)
    if pending["wasPublic"]:
        invalidate_album_media(album, reason="album-media-deleted", strict=True)
    delete_preview_metadata(album_id, removed_media_ids, pending["indexKeys"])
    if album.get("mediaStoreVersion") == 1:
        try:
            if not delete_album_media(album_id, removed_media_ids):
                deactivate_album_media(table, album_id)
        except Exception as error:
            logger.error("album_media_delete_failed error_type=%s", type(error).__name__)
            deactivate_album_media(table, album_id)
    if pending["wasPublic"]:
        request_public_api_invalidation(album_id=album_id, catalog=True, reason="album-media-deleted")
        if album.get("type", "photo") == "photo":
            request_random_photo_pool_refresh()
    try:
        table.update_item(
            Key={"albumId": album_id}, UpdateExpression="REMOVE pendingMediaDeletion",
            ConditionExpression="pendingMediaDeletion.id = :id",
            ExpressionAttributeValues={":id": pending["id"]},
        )
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        # A concurrent retry already completed this exact idempotent cleanup,
        # or the entire album was deleted. Never recreate its record.
        pass
    try:
        response_album = serialize_album_summary(album, include_admin=True)
    except ValidationError:
        response_album = {key: album.get(key) for key in (
            "albumId", "imageCount", "coverImageUrl", "coverThumbKey", "coverBlurhash")}
    _audit(event, context, "success", "media_deleted", deleted_count=len(removed_media_ids),
           deleted_version_count=deleted_versions)
    return json_response(200, {"message": "Media deleted", "deletedCount": len(removed_media_ids),
                               "deletedObjectVersions": deleted_versions, "album": response_album})
