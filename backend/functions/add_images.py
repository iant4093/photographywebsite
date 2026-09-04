"""Validated, idempotent admin append of pending uploads to an album."""

import json
import logging
import os

import boto3

from audit_helpers import actor_context, emit_audit_event
from album_media_store import append_album_media, deactivate_album_media
from auth_helpers import require_admin
from cache_invalidation import request_public_api_invalidation
from create_album import _extract_exif, _normalize_images, _start_video_jobs
from media_access import album_known_keys, serialize_album_summary, serialize_images, tag_keys_visibility
from preview_jobs import enqueue_preview_jobs
from original_comparison_jobs import request_original_comparisons
from random_pool_refresh import request_random_photo_pool_refresh
from response_helpers import error_response, internal_error, json_response
from dynamodb_helpers import ensure_album_item_budget
from validation_helpers import ValidationError, parse_json_body, validate_uuid


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
logger = logging.getLogger("photography_api.album_write")


def _audit(event, context, outcome, reason_code, *, media_count=None):
    actor_type, auth_method = actor_context(event)
    emit_audit_event(
        event_name="admin.media_added",
        outcome=outcome,
        action="album.media.add",
        resource_type="media",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        details={"media_count": media_count} if media_count is not None else None,
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
        body = parse_json_body(event)
        album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not album or album.get("status", "active") != "active":
            _audit(event, context, "denied", "album_not_found")
            return error_response(404, "Album not found", code="not_found")
        album_type = album.get("type", "photo")
        images = _normalize_images(body.get("images"), album_id, album_type, album=album)

        existing_keys = {
            image.get("rawKey") or image.get("key")
            for image in album.get("images", [])
            if isinstance(image, dict)
        }
        fresh_images = [image for image in images if image.get("rawKey") not in existing_keys]
        existing_images = album.get("images", []) if isinstance(album.get("images", []), list) else []
        maximum = 50 if album_type == "video" else 500
        if len(existing_images) + len(fresh_images) > maximum:
            raise ValidationError(f"Album cannot contain more than {maximum} media items")
        candidate = dict(album)
        candidate["images"] = existing_images + fresh_images
        candidate["imageCount"] = len(candidate["images"])
        ensure_album_item_budget(candidate)
        if fresh_images:
            if album_type == "photo":
                _extract_exif(fresh_images)
            else:
                _start_video_jobs(fresh_images)

            table.update_item(
                Key={"albumId": album_id},
                UpdateExpression=(
                    "SET images = list_append(if_not_exists(images, :empty), :images), "
                    "imageCount = if_not_exists(imageCount, :existing_count) + :added"
                ),
                ConditionExpression="attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status = :active)",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={
                    ":empty": [],
                    ":images": fresh_images,
                    ":existing_count": len(existing_images),
                    ":added": len(fresh_images),
                    ":active": "active",
                },
            )
            if album.get("mediaStoreVersion") == 1:
                try:
                    if not append_album_media(album_id, fresh_images, len(existing_images)):
                        deactivate_album_media(table, album_id)
                except Exception as error:
                    logger.error("album_media_append_failed error_type=%s", type(error).__name__)
                    deactivate_album_media(table, album_id)
        # Always retag the requested keys so a retry can repair a prior partial
        # failure after the DynamoDB append succeeded.
        requested_key_holder = {
            "albumId": album_id,
            "legacyS3Prefix": album.get("legacyS3Prefix", ""),
            "images": images,
        }
        tag_keys_visibility(album_known_keys(requested_key_holder), album["visibility"])

        if album_type == "photo" and fresh_images:
            request_original_comparisons(album_id, fresh_images)
            try:
                enqueue_preview_jobs(album_id, fresh_images)
            except Exception as error:
                logger.error("preview_dispatch_failed error_type=%s", type(error).__name__)

        # The durable album setting is authoritative. A per-request value must
        # neither disable required backup nor opt an album into backup.
        backup_to_drive = album.get("backupToGoogleDrive") is True
        if backup_to_drive and fresh_images and os.environ.get("GOOGLE_DRIVE_SYNC_FUNCTION_NAME"):
            try:
                boto3.client("lambda").invoke(
                    FunctionName=os.environ["GOOGLE_DRIVE_SYNC_FUNCTION_NAME"],
                    InvocationType="Event",
                    Payload=json.dumps(
                        {
                            "albumId": album_id,
                            "albumType": album_type,
                            "albumTitle": album.get("title", "Album"),
                            "bucket": os.environ["IMAGES_BUCKET"],
                            "keys": [image["rawKey"] for image in fresh_images],
                        }
                    ),
                )
            except Exception as error:
                logger.error("drive_backup_dispatch_failed error_type=%s", type(error).__name__)
                emit_audit_event(
                    event_name="provider.drive_backup", outcome="failure", action="provider.backup.dispatch",
                    resource_type="provider", reason_code="dispatch_failed", event=event,
                    context=context, actor_type="service", auth_method="service",
                )
        if album.get("visibility") == "public" and fresh_images:
            request_public_api_invalidation(
                album_id=album_id,
                catalog=True,
                reason="album-media-added",
            )
            if album_type == "photo":
                request_random_photo_pool_refresh()
        _audit(event, context, "success", "media_added", media_count=len(fresh_images))
        return json_response(200, {
            "message": "Images appended successfully",
            "added": len(fresh_images),
            "album": serialize_album_summary(candidate, include_admin=True),
            "items": serialize_images(
                {**candidate, "images": fresh_images},
                include_internal=True,
            ),
        })
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_media")
        return error_response(400, str(error), code="invalid_images")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "add_images")
