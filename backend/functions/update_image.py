"""Admin-only update of bounded media display metadata."""

import os
import logging
import re

import boto3

from audit_helpers import actor_context, emit_audit_event
from album_media_store import deactivate_album_media, update_album_media
from auth_helpers import require_admin
from cache_invalidation import request_public_api_invalidation
from deletion_helpers import DeletionTooLargeError, delete_keys_all_versions, preflight_deletion
from media_access import media_id_for_key, serialize_images, tag_keys_visibility, validate_album_media_key
from random_pool_refresh import request_random_photo_pool_refresh
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, optional_string, parse_json_body, require_string, validate_uuid


table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])
logger = logging.getLogger("photography_api.album_write")
ACCESSIBILITY_LIMITS = {"altText": 500, "captionVtt": 16000, "captionLanguage": 35, "transcript": 8000}


def _audit(event, context, outcome, reason_code):
    actor_type, auth_method = actor_context(event)
    emit_audit_event(
        event_name="admin.media_updated",
        outcome=outcome,
        action="album.media.update",
        resource_type="media",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
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
        body = parse_json_body(event, max_bytes=32 * 1024)
        raw_key = require_string(body.get("rawKey"), "rawKey", maximum=1024)
        if not ({"thumbKey", "blurhash", "isFavorite", *ACCESSIBILITY_LIMITS} & body.keys()):
            _audit(event, context, "denied", "empty_update")
            return error_response(400, "Provide thumbnail, favorite, or accessibility metadata", code="invalid_request")

        album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not album or album.get("status", "active") != "active":
            _audit(event, context, "denied", "album_not_found")
            return error_response(404, "Album not found", code="not_found")
        if album.get("pendingMediaDeletion"):
            return error_response(409, "Media deletion is still being completed. Please retry shortly.", code="deletion_pending")
        raw_key = validate_album_media_key(raw_key, album=album)
        images = album.get("images", []) if isinstance(album.get("images", []), list) else []
        target_index = next(
            (index for index, image in enumerate(images) if isinstance(image, dict) and (image.get("rawKey") or image.get("key")) == raw_key),
            None,
        )
        if target_index is None:
            _audit(event, context, "denied", "media_not_found")
            return error_response(404, "Media not found", code="not_found")

        accessibility = {}
        if "isFavorite" in body:
            if not isinstance(body["isFavorite"], bool):
                raise ValidationError("isFavorite must be a boolean")
            if album.get("type") == "video":
                raise ValidationError("Favorites are available for photo albums only")
            accessibility["isFavorite"] = body["isFavorite"]
        for field, limit in ACCESSIBILITY_LIMITS.items():
            if field in body:
                accessibility[field] = optional_string(body[field], field, maximum=limit)
        if any(field in accessibility for field in ("captionVtt", "captionLanguage", "transcript")) and album.get("type") != "video":
            raise ValidationError("Captions and transcripts are available for video albums only")
        language = accessibility.get("captionLanguage", "")
        if language and not re.fullmatch(r"[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*", language):
            raise ValidationError("Use a language tag such as en or en-US")
        captions = accessibility.get("captionVtt", "").lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
        if captions:
            timestamp = r"(?:\d{2,}:)?[0-5]\d:[0-5]\d\.\d{3}"
            if not re.match(r"^WEBVTT(?:[ \t][^\n]*)?\n\n", captions) or not re.search(rf"(?m)^{timestamp}[ \t]+-->[ \t]+{timestamp}(?:[ \t][^\n]*)?$", captions):
                raise ValidationError("Captions must be a WebVTT file with a WEBVTT header and timed cues")
            accessibility["captionVtt"] = captions

        update_parts = []
        values = {}
        old_thumb = images[target_index].get("thumbKey", "")
        obsolete_thumb = ""
        is_cover = album.get("coverImageUrl") == raw_key
        if "thumbKey" in body:
            thumb_key = require_string(body.get("thumbKey"), "thumbKey", maximum=1024)
            thumb_key = validate_album_media_key(thumb_key, album=album)
            update_parts.append(f"images[{target_index}].thumbKey = :thumbKey")
            values[":thumbKey"] = thumb_key
            if is_cover:
                update_parts.append("coverThumbKey = :thumbKey")
            if old_thumb and old_thumb != thumb_key:
                referenced_elsewhere = any(
                    index != target_index
                    and isinstance(image, dict)
                    and image.get("thumbKey") == old_thumb
                    for index, image in enumerate(images)
                )
                retained_as_cover = album.get("coverThumbKey") == old_thumb and not is_cover
                if not referenced_elsewhere and not retained_as_cover:
                    try:
                        obsolete_thumb = validate_album_media_key(old_thumb, album=album)
                    except ValidationError:
                        # Never turn malformed stored metadata into an S3 target.
                        obsolete_thumb = ""
        if "blurhash" in body:
            blurhash = optional_string(body.get("blurhash"), "blurhash", maximum=200)
            update_parts.append(f"images[{target_index}].blurhash = :blurhash")
            values[":blurhash"] = blurhash
            if is_cover:
                update_parts.append("coverBlurhash = :blurhash")
        for field, value in accessibility.items():
            update_parts.append(f"images[{target_index}].{field} = :{field}")
            values[f":{field}"] = value

        if obsolete_thumb:
            preflight_deletion(keys=[obsolete_thumb], max_versions=100)
        if "thumbKey" in body:
            tag_keys_visibility([values[":thumbKey"]], album.get("visibility"))

        table.update_item(
            Key={"albumId": album_id},
            UpdateExpression="SET " + ", ".join(update_parts),
            # Refuse to attach descriptions/captions to a different image if
            # another administrator removed or reordered the manifest meanwhile.
            ConditionExpression=f"attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status = :active) AND attribute_not_exists(pendingMediaDeletion) AND images[{target_index}].#expectedMediaKey = :expectedKey",
            ExpressionAttributeNames={"#status": "status", "#expectedMediaKey": "rawKey" if images[target_index].get("rawKey") else "key"},
            ExpressionAttributeValues={**values, ":active": "active", ":expectedKey": raw_key},
        )
        if album.get("mediaStoreVersion") == 1:
            normalized_fields = dict(accessibility)
            if ":thumbKey" in values:
                normalized_fields["thumbKey"] = values[":thumbKey"]
            if ":blurhash" in values:
                normalized_fields["blurhash"] = values[":blurhash"]
            try:
                if not update_album_media(
                    album_id,
                    media_id_for_key(raw_key),
                    normalized_fields,
                ):
                    deactivate_album_media(table, album_id)
            except Exception as error:
                logger.error("album_media_update_failed error_type=%s", type(error).__name__)
                deactivate_album_media(table, album_id)
        if obsolete_thumb:
            delete_keys_all_versions([obsolete_thumb])
        if album.get("visibility") == "public":
            if "isFavorite" in accessibility:
                request_random_photo_pool_refresh()
            request_public_api_invalidation(
                album_id=album_id,
                catalog=True,
                reason="album-media-updated",
            )
        updated_image = {**images[target_index], **accessibility}
        if ":thumbKey" in values:
            updated_image["thumbKey"] = values[":thumbKey"]
        if ":blurhash" in values:
            updated_image["blurhash"] = values[":blurhash"]
        serialized = serialize_images(
            {**album, "images": [updated_image]},
            include_internal=True,
        )
        _audit(event, context, "success", "media_updated")
        return json_response(200, {
            "message": "Media metadata updated",
            "mediaId": raw_key,
            "item": serialized[0] if serialized else None,
        })
    except DeletionTooLargeError:
        _audit(event, context, "denied", "deletion_too_large")
        return error_response(
            409,
            "The obsolete thumbnail has too many versions for synchronous cleanup",
            code="deletion_too_large",
        )
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_request")
        return error_response(400, str(error), code="invalid_request")
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        _audit(event, context, "denied", "album_conflict")
        return error_response(409, "Album changed while media was being updated", code="conflict")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "update_image")
