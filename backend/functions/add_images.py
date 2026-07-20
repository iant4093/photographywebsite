"""Validated, idempotent admin append of pending uploads to an album."""

import json
import logging
import os

import boto3

from auth_helpers import require_admin
from create_album import _extract_exif, _normalize_images, _start_video_jobs
from media_access import album_known_keys, tag_keys_visibility
from response_helpers import error_response, internal_error, json_response
from dynamodb_helpers import ensure_album_item_budget
from validation_helpers import ValidationError, parse_json_body, validate_uuid


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
logger = logging.getLogger("photography_api.album_write")


def handler(event, context):
    denied = require_admin(event)
    if denied:
        return denied
    try:
        album_id = validate_uuid(((event or {}).get("pathParameters") or {}).get("albumId"))
        body = parse_json_body(event)
        album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not album or album.get("status", "active") != "active":
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
        # Always retag the requested keys so a retry can repair a prior partial
        # failure after the DynamoDB append succeeded.
        requested_key_holder = {
            "albumId": album_id,
            "legacyS3Prefix": album.get("legacyS3Prefix", ""),
            "images": images,
        }
        tag_keys_visibility(album_known_keys(requested_key_holder), album["visibility"])

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
        return json_response(200, {"message": "Images appended successfully", "added": len(fresh_images)})
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_images")
    except Exception as error:
        return internal_error(context, error, "add_images")
