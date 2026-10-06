"""Validated, admin-only album creation with pending-to-visible media tagging."""

from performance_observation import measure_handler

import datetime
import html
import hashlib
import json
import logging
import os
import secrets
import uuid
import upload_followup
import upload_media
import video_jobs
import ownership_guard
import scheduled_publish
from visibility_change import enqueue as enqueue_album_work

import boto3
from media_mutation import album_lease, enabled as mutation_protocol_enabled, MediaMutationBusy, MediaAlbumMissing
import drive_backup_jobs
from botocore.exceptions import ClientError

from audit_helpers import actor_context, emit_audit_event
from album_media_store import activate_album_media, replace_album_media
from album_mutation_helpers import resolve_owner as _resolve_owner
from album_mutation_helpers import validate_created_at as _validate_created_at
from auth_helpers import get_caller_claims, require_admin
from cache_invalidation import request_public_api_invalidation
from dynamodb_helpers import AlbumManifestTooLarge, ensure_album_item_budget
from email_helpers import send_email
from media_access import serialize_album_summary, tag_album_visibility, validate_album_media_key
from media_helpers import extract_exif_data, start_mediaconvert_job
from preview_jobs import enqueue_preview_jobs
from original_comparison_jobs import request_original_comparisons
from random_pool_refresh import request_random_photo_pool_refresh
from response_helpers import error_response, internal_error, json_response
from validation_helpers import (
    ValidationError,
    optional_string,
    parse_json_body,
    require_string,
    validate_album_type,
    validate_bool,
    validate_uuid,
    validate_visibility,
)


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
logger = logging.getLogger("photography_api.album_write")


def _ensure_album_qr(item, creator_sub):
    # Load the QR renderer only when creating an album.
    from album_qr import write_album_qr

    key = write_album_qr(item)
    if not key:
        item.pop("qrCodeKey", None)
        return None
    candidate = dict(item)
    candidate["qrCodeKey"] = key
    ensure_album_item_budget(candidate)
    table.update_item(
        Key={"albumId": item["albumId"]},
        UpdateExpression="SET qrCodeKey = :key",
        ConditionExpression="createdBySub = :creator AND (#status = :pending OR #status = :active)",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":key": key,
            ":creator": creator_sub,
            ":pending": "pending",
            ":active": "active",
        },
    )
    item["qrCodeKey"] = key
    return key


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
    return upload_media.normalize_images(value, album_id, album_type, album=album)


def _extract_exif(images):
    return upload_media.extract_exif(images, extractor=extract_exif_data)


def _start_video_jobs(images):
    return upload_media.start_video_jobs(images, submit=start_mediaconvert_job)


from front_door import verify_front_door_request


def _complete_followup(album, context):
    try:
        enqueue_album_work(album["albumId"], "album-upload-followup")
        upload_followup.complete(table, album, context)
    except Exception as error:
        # A committed upload remains usable. The queued delivery and durable
        # stage receipt repair secondary work without another album or upload.
        logger.error("album_followup_pending error_type=%s", type(error).__name__)


@measure_handler("create_album")
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
        upload_request_id = validate_uuid(body["uploadRequestId"]) if "uploadRequestId" in body else None
        upload_request_hash = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

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
        publish_at = None
        if body.get("publishAt") not in (None, ""):
            if visibility != "unlisted":
                raise ValidationError("Only link-only albums can be scheduled for publishing")
            publish_at = scheduled_publish.validate_publish_at(body["publishAt"])

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
            "uploadedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "visibility": visibility,
            "ownerEmail": owner_email,
            "isShared": is_shared,
            "backupToGoogleDrive": backup_to_drive,
            "status": "pending",
            "createdBySub": claims["sub"],
        }
        if upload_request_id:
            item.update(uploadRequestId=upload_request_id, uploadRequestHash=upload_request_hash,
                        uploadActorSub=claims["sub"])
        # ownerSub is the partition key of OwnerSubCreatedAtIndex. DynamoDB
        # rejects empty strings for any table or index key, so non-private
        # albums must omit this attribute rather than persisting "".
        if owner_sub:
            item["ownerSub"] = owner_sub
        if is_shared:
            item["shareCode"] = secrets.token_urlsafe(24)
        if publish_at:
            item["publishAt"] = publish_at

        if mutation_protocol_enabled():
            item["pendingMediaUpload"] = {"id": uuid.uuid4().hex, "keys": [image["rawKey"] for image in images], "done": []}
            if os.environ.get("ALBUM_MEDIA_TABLE"):
                item["mediaStoreDirty"] = True
            if album_type == "video":
                item["videoJobs"] = video_jobs.prepare(item, images)
        ensure_album_item_budget(item)
        if publish_at:
            # Before the album exists: the publisher drops an entry without a
            # matching album, but an album time without an entry never publishes.
            scheduled_publish.record(album_id, publish_at)

        try:
            ownership_guard.write(table, "Put", item.get("ownerSub"), Item=item, ConditionExpression="attribute_not_exists(albumId)")
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            existing = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
            matching_retry = bool(
                existing and upload_request_id
                and existing.get("uploadRequestId") == upload_request_id
                and existing.get("uploadRequestHash") == upload_request_hash
                and existing.get("uploadActorSub") == claims["sub"]
            )
            if matching_retry and existing.get("status") == "active" and not existing.get("createdBySub"):
                # A lost HTTP response must not create another album, rerun
                # media jobs, or resend a private-album notification.
                if mutation_protocol_enabled() and (existing.get("pendingMediaUpload") or existing.get("videoJobs")):
                    with album_lease(table, album_id, context):
                        # A manifest can change between the conflict read and
                        # acquiring the lease. Never repair from that snapshot.
                        existing = table.get_item(Key={"albumId": album_id}, ConsistentRead=True)["Item"]
                        if existing.get("uploadRequestHash") != upload_request_hash or existing.get("uploadActorSub") != claims["sub"]:
                            return error_response(409, "Album changed. Reload and retry.", code="conflict")
                        _complete_followup(existing, context)
                _audit(event, context, "success", "album_created", media_count=len(existing.get("images", [])),
                       visibility=existing.get("visibility"))
                return json_response(201, serialize_album_summary(existing, include_admin=True))
            if (
                not existing
                or existing.get("status") not in {"pending", "active"}
                or existing.get("createdBySub") != claims["sub"]
                or (upload_request_id and not matching_retry)
            ):
                _audit(event, context, "denied", "album_conflict")
                return error_response(409, "Album already exists", code="conflict")
            item = existing
            images = item.get("images", [])

        with album_lease(table, album_id, context, creating=True):
            if album_type == "video" and not mutation_protocol_enabled() and not any(image.get("mediaConvertJobId") for image in images):
                _start_video_jobs(images)
                table.update_item(
                    Key={"albumId": album_id},
                    UpdateExpression="SET images = :images, imageCount = :count",
                    ExpressionAttributeValues={":images": images, ":count": len(images)},
                )
                item["images"] = images

            _ensure_album_qr(item, claims["sub"])

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
            if mutation_protocol_enabled():
                # Dispatch before commit: a crash just after saving an active
                # album cannot lose the durable after-commit continuation.
                enqueue_album_work(album_id, "album-upload-followup")
            drive_backup_jobs.update_album(
                table, item,
                Key={"albumId": album_id},
                UpdateExpression="SET #status = :active REMOVE createdBySub",
                ConditionExpression="createdBySub = :creator AND (#status = :pending OR #status = :active)",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":active": "active", ":pending": "pending", ":creator": claims["sub"]},
            )
            item["status"] = "active"
            item.pop("createdBySub", None)

            if mutation_protocol_enabled():
                _complete_followup(item, context)
            else:
                # Populate the normalized media store only after the legacy manifest is
                # committed and visible. The version marker is the read cutover: if the
                # secondary write fails, readers continue using the complete manifest.
                try:
                    if replace_album_media(album_id, images):
                        activate_album_media(table, album_id, images)
                        item["mediaStoreVersion"] = 1
                except Exception as error:
                    logger.error("album_media_normalization_failed error_type=%s", type(error).__name__)

                if album_type == "photo":
                    request_original_comparisons(album_id, images)
                    try:
                        enqueue_preview_jobs(album_id, images)
                    except Exception as error:
                        # V1 JPEG thumbnails remain authoritative until asynchronous
                        # Responsive preview generation succeeds, so queue outages cannot break upload.
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

            if backup_to_drive and not drive_backup_jobs.state_table() and os.environ.get("GOOGLE_DRIVE_SYNC_FUNCTION_NAME"):
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

            if visibility == "public" and not mutation_protocol_enabled():
                request_public_api_invalidation(catalog=True, reason="album-created")
                if album_type == "photo":
                    request_random_photo_pool_refresh()
            _audit(event, context, "success", "album_created", media_count=len(images), visibility=visibility)
            return json_response(201, serialize_album_summary(item, include_admin=True))
    except (MediaMutationBusy, MediaAlbumMissing) as error:
        return error_response(409, str(error), code="media_busy")
    except drive_backup_jobs.DriveBackupBusy as error:
        return error_response(409, str(error), code="backup_busy")
    except AlbumManifestTooLarge as error:
        _audit(event, context, "denied", "manifest_too_large")
        return error_response(413, str(error), code="album_manifest_too_large")
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_album")
        return error_response(400, str(error), code="invalid_album")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "create_album")
