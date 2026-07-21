"""Issue short-lived, server-namespaced, pending-tagged S3 upload URLs."""

import os
import posixpath
import uuid

import boto3

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import require_admin
from media_access import PENDING_VISIBILITY, bucket_name
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, parse_json_body, require_string, validate_uuid


s3 = boto3.client("s3")

TYPE_POLICY = {
    "image/jpeg": ({".jpg", ".jpeg"}, 100 * 1024 * 1024),
    "image/png": ({".png"}, 100 * 1024 * 1024),
    "image/webp": ({".webp"}, 100 * 1024 * 1024),
    "image/heic": ({".heic"}, 100 * 1024 * 1024),
    "image/heif": ({".heif"}, 100 * 1024 * 1024),
    "video/mp4": ({".mp4"}, 5 * 1024 * 1024 * 1024),
    "video/quicktime": ({".mov"}, 5 * 1024 * 1024 * 1024),
    "video/webm": ({".webm"}, 5 * 1024 * 1024 * 1024),
    "video/x-m4v": ({".m4v"}, 5 * 1024 * 1024 * 1024),
}


def _audit(event, context, outcome, reason_code):
    actor_type, auth_method = actor_context(event)
    emit_audit_event(
        event_name="admin.upload_authorized",
        outcome=outcome,
        action="media.upload.authorize",
        resource_type="media",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
    )


def _validate_upload_intent(body):
    album_id = validate_uuid(body.get("albumId"))
    filename_hint = require_string(body.get("filename"), "filename", maximum=1024)
    # Compatibility: older backends expect the frontend to pass the complete
    # desired key. The secure backend treats it only as an extension hint and
    # ignores every caller-controlled directory/name component.
    filename = posixpath.basename(filename_hint.replace("\\", "/"))
    if not filename or filename in {".", ".."} or "\x00" in filename:
        raise ValidationError("filename is invalid")
    content_type = require_string(body.get("contentType"), "contentType", maximum=100).lower()
    kind = require_string(body.get("kind", "original"), "kind", maximum=20).lower()
    if kind not in {"original", "thumbnail"}:
        raise ValidationError("kind must be original or thumbnail")
    try:
        size = int(body.get("size"))
    except (TypeError, ValueError):
        raise ValidationError("size must be an integer") from None
    if size < 1:
        raise ValidationError("size must be positive")

    extension = posixpath.splitext(filename)[1].lower()
    if kind == "thumbnail":
        if content_type != "image/jpeg":
            raise ValidationError("thumbnails must use image/jpeg")
        extension = ".jpg"
        max_bytes = 10 * 1024 * 1024
    else:
        policy = TYPE_POLICY.get(content_type)
        if not policy or extension not in policy[0]:
            raise ValidationError("Unsupported file type or extension")
        max_bytes = policy[1]
    if size > max_bytes:
        raise ValidationError("File exceeds the allowed size")
    return album_id, content_type, kind, extension, size, max_bytes


from front_door import verify_front_door_request


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied
    try:
        body = parse_json_body(event, max_bytes=16 * 1024)
        album_id, content_type, kind, extension, size, max_bytes = _validate_upload_intent(body)
        key = f"albums/{album_id}/{kind}/{uuid.uuid4().hex}{extension}"
        tagging = f"visibility={PENDING_VISIBILITY}"
        expires_in = max(60, min(int(os.environ.get("UPLOAD_URL_TTL_SECONDS", "300")), 900))
        upload_url = s3.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": bucket_name(),
                "Key": key,
                "ContentType": content_type,
                "ContentLength": size,
                "Tagging": tagging,
            },
            ExpiresIn=expires_in,
        )
        _audit(event, context, "success", "upload_authorized")
        return json_response(
            200,
            {
                "uploadUrl": upload_url,
                "key": key,
                "requiredHeaders": {
                    "Content-Type": content_type,
                    "x-amz-tagging": tagging,
                },
                "expiresIn": expires_in,
                "maxBytes": max_bytes,
            },
        )
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_upload")
        return error_response(400, str(error), code="invalid_upload")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "create_upload_url")
