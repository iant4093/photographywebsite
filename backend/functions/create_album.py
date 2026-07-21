"""Validated, admin-only album creation with pending-to-visible media tagging."""

import concurrent.futures
import decimal
import html
import json
import logging
import os
import secrets

import boto3
from botocore.exceptions import ClientError

from audit_helpers import actor_context, emit_audit_event
from album_mutation_helpers import resolve_owner as _resolve_owner
from album_mutation_helpers import validate_created_at as _validate_created_at
from auth_helpers import get_caller_claims, require_admin
from dynamodb_helpers import ensure_album_item_budget
from email_helpers import send_email
from media_access import serialize_album_summary, tag_album_visibility, validate_album_media_key
from media_helpers import extract_exif_data, start_mediaconvert_job
from preview_jobs import enqueue_preview_jobs
from response_helpers import error_response, internal_error, json_response
from validation_helpers import (
    ValidationError,
    optional_string,
    parse_json_body,
    require_string,
    validate_album_type,
    validate_bool,
    validate_list,
    validate_uuid,
    validate_visibility,
)


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
logger = logging.getLogger("photography_api.album_write")


def _audit(event, context, outcome, reason_code, *, media_count=None, visibility=None):
    actor_type, auth_method = actor_context(event)
    details = {}
    if media_count is not None:
        details["media_count"] = media_count
    if visibility is not None:
        details["visibility"] = visibility if visibility in {"public", "private", "unlisted"} else "unknown"
    emit_audit_event(
        event_name="admin.album_created",
        outcome=outcome,
        action="album.create",
        resource_type="album",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        details=details or None,
    )


def _normalize_images(value, album_id, album_type, *, album=None):
    maximum = 50 if album_type == "video" else 500
    images = validate_list(value, "images", maximum=maximum, required=True)
    normalized = []
    prefix = f"albums/{album_id}/"
    for index, image in enumerate(images):
        if not isinstance(image, dict):
            raise ValidationError(f"images[{index}] must be an object")
        key_scope = {"album": album} if album is not None else {"album_id": album_id}
        raw_key = validate_album_media_key(image.get("rawKey") or image.get("key"), **key_scope)
        thumb_key = image.get("thumbKey")
        if thumb_key:
            thumb_key = validate_album_media_key(thumb_key, **key_scope)
        item = {"rawKey": raw_key}
        if thumb_key:
            item["thumbKey"] = thumb_key
        for dimension in ("width", "height"):
            if image.get(dimension) is not None:
                try:
                    number = int(image[dimension])
                except (TypeError, ValueError):
                    raise ValidationError(f"images[{index}].{dimension} must be an integer") from None
                if number < 1 or number > 100000:
                    raise ValidationError(f"images[{index}].{dimension} is out of range")
                item[dimension] = number
        if image.get("blurhash"):
            item["blurhash"] = require_string(image["blurhash"], f"images[{index}].blurhash", maximum=200)
        if album_type == "video":
            base_name = raw_key.rsplit(".", 1)[0]
            filename = raw_key.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            # Matches MediaConvert's configured `_1080p5m` NameModifier.
            item["hlsUrl"] = f"{base_name}_hls/{filename}_1080p5m.m3u8"
            if image.get("thumbnailTime") is not None:
                try:
                    numeric_time = max(0, min(float(image["thumbnailTime"]), 86400))
                    item["thumbnailTime"] = decimal.Decimal(str(numeric_time))
                except (TypeError, ValueError):
                    raise ValidationError(f"images[{index}].thumbnailTime must be numeric") from None
        normalized.append(item)
    return normalized


def _extract_exif(images):
    bucket = os.environ["IMAGES_BUCKET"]

    def extract(image):
        try:
            result = extract_exif_data(bucket, image["rawKey"])
            if result:
                image["exif"] = result
        except Exception:
            # EXIF is optional; never log the client object key.
            return

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(images))) as executor:
        list(executor.map(extract, images))


def _start_video_jobs(images):
    bucket = os.environ["IMAGES_BUCKET"]
    for image in images:
        raw_key = image["rawKey"]
        output_prefix = raw_key.rsplit(".", 1)[0] + "_hls/"
        try:
            image["mediaConvertJobId"] = start_mediaconvert_job(
                f"s3://{bucket}/{raw_key}",
                f"s3://{bucket}/{output_prefix}",
            )
        except Exception:
            # Keep the raw protected video usable if transcoding is unavailable.
            image.pop("hlsUrl", None)


from front_door import verify_front_door_request


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied
    try:
        claims = get_caller_claims(event)
        body = parse_json_body(event)
        album_id = validate_uuid(body.get("albumId"))
        album_type = validate_album_type(body.get("type"))
        visibility = validate_visibility(body.get("visibility"), default="public")
        title = require_string(body.get("title"), "title", maximum=200)
        description = optional_string(body.get("description"), "description", maximum=5000)
        category = optional_string(body.get("category"), "category", maximum=100, default="Uncategorized") or "Uncategorized"
        created_at = _validate_created_at(body.get("createdAt"))
        images = _normalize_images(body.get("images"), album_id, album_type)
        backup_to_drive = validate_bool(body.get("backupToGoogleDrive"), "backupToGoogleDrive")

        owner_email = owner_sub = ""
        if visibility == "private":
            owner_email, owner_sub = _resolve_owner(body)
        is_shared = visibility == "unlisted" and validate_bool(body.get("isShared"), "isShared", default=True)

        if album_type == "photo":
            _extract_exif(images)

        prefix = f"albums/{album_id}/"
        cover_key = body.get("coverImageUrl") or images[0]["rawKey"]
        cover_key = validate_album_media_key(cover_key, album_id=album_id)
        cover_thumb = body.get("coverThumbKey") or images[0].get("thumbKey", "")
        if cover_thumb:
            cover_thumb = validate_album_media_key(cover_thumb, album_id=album_id)
        item = {
            "albumId": album_id,
            "type": album_type,
            "title": title,
            "description": description,
            "category": category,
            "coverImageUrl": cover_key,
            "coverThumbKey": cover_thumb,
            "coverBlurhash": optional_string(body.get("coverBlurhash"), "coverBlurhash", maximum=200),
            "images": images,
            "imageCount": len(images),
            "s3Prefix": prefix,
            "createdAt": created_at,
            "visibility": visibility,
            "ownerEmail": owner_email,
            "ownerSub": owner_sub,
            "isShared": is_shared,
            "backupToGoogleDrive": backup_to_drive,
            "status": "pending",
            "createdBySub": claims["sub"],
        }
        if is_shared:
            item["shareCode"] = secrets.token_urlsafe(24)

        ensure_album_item_budget(item)

        try:
            table.put_item(Item=item, ConditionExpression="attribute_not_exists(albumId)")
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            existing = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
            if (
                not existing
                or existing.get("status") not in {"pending", "active"}
                or existing.get("createdBySub") != claims["sub"]
            ):
                _audit(event, context, "denied", "album_conflict")
                return error_response(409, "Album already exists", code="conflict")
            item = existing
            images = item.get("images", [])

        if album_type == "video" and not any(image.get("mediaConvertJobId") for image in images):
            _start_video_jobs(images)
            table.update_item(
                Key={"albumId": album_id},
                UpdateExpression="SET images = :images, imageCount = :count",
                ExpressionAttributeValues={":images": images, ":count": len(images)},
            )
            item["images"] = images

        # Releasing media to anonymous CDN access happens only after an active
        # album record exists. Restrictive visibilities are tagged first. Both
        # orders fail unavailable rather than accidentally public.
        if visibility == "public" and item.get("status") == "pending":
            table.update_item(
                Key={"albumId": album_id},
                UpdateExpression="SET #status = :active",
                ConditionExpression="#status = :pending AND createdBySub = :creator",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":active": "active", ":pending": "pending", ":creator": claims["sub"]},
            )
            item["status"] = "active"
        tag_album_visibility(item, visibility, include_derivatives=False)
        table.update_item(
            Key={"albumId": album_id},
            UpdateExpression="SET #status = :active REMOVE createdBySub",
            ConditionExpression="createdBySub = :creator AND (#status = :pending OR #status = :active)",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":active": "active", ":pending": "pending", ":creator": claims["sub"]},
        )
        item["status"] = "active"
        item.pop("createdBySub", None)

        if album_type == "photo":
            try:
                enqueue_preview_jobs(album_id, images)
            except Exception as error:
                # V1 JPEG thumbnails remain authoritative until asynchronous
                # V2 generation succeeds, so queue outages cannot break upload.
                logger.error("preview_dispatch_failed error_type=%s", type(error).__name__)

        if visibility == "private" and owner_email:
            portal_url = html.escape(os.environ.get("FRONTEND_URL", "https://iantruongphotography.com"), quote=True)
            safe_title = html.escape(title, quote=True)
            try:
                send_email(
                    owner_email,
                    f"Your New Photos Are Ready: {title.replace(chr(13), ' ').replace(chr(10), ' ')}",
                    (
                        '<div style="font-family:sans-serif;max-width:600px;margin:auto">'
                        '<h2 style="color:#4a4a4a">Your gallery is ready!</h2>'
                        f"<p>A new private album is ready: <strong>{safe_title}</strong>.</p>"
                        f'<p><a href="{portal_url}/login">View Album</a></p></div>'
                    ),
                )
            except Exception as error:
                # The album is already committed. Do not turn an auxiliary
                # notification outage into an unsafe, non-idempotent retry.
                logger.error("album_notification_failed error_type=%s", type(error).__name__)
                emit_audit_event(
                    event_name="provider.email", outcome="failure", action="provider.email.dispatch",
                    resource_type="provider", reason_code="album_notification_failed", event=event,
                    context=context, actor_type="service", auth_method="service",
                )

        if backup_to_drive and os.environ.get("GOOGLE_DRIVE_SYNC_FUNCTION_NAME"):
            payload = {
                "albumId": album_id,
                "albumType": album_type,
                "albumTitle": title,
                "bucket": os.environ["IMAGES_BUCKET"],
                "keys": [image["rawKey"] for image in images],
            }
            try:
                boto3.client("lambda").invoke(
                    FunctionName=os.environ["GOOGLE_DRIVE_SYNC_FUNCTION_NAME"],
                    InvocationType="Event",
                    Payload=json.dumps(payload),
                )
            except Exception as error:
                logger.error("drive_backup_dispatch_failed error_type=%s", type(error).__name__)
                emit_audit_event(
                    event_name="provider.drive_backup", outcome="failure", action="provider.backup.dispatch",
                    resource_type="provider", reason_code="dispatch_failed", event=event,
                    context=context, actor_type="service", auth_method="service",
                )

        _audit(event, context, "success", "album_created", media_count=len(images), visibility=visibility)
        return json_response(201, serialize_album_summary(item, include_admin=True))
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_album")
        return error_response(400, str(error), code="invalid_album")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "create_album")
