"""Authorize and activate an unmodified admin-managed homepage hero image."""

from __future__ import annotations

import os
import posixpath
import re

import boto3
from botocore.exceptions import ClientError

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import require_admin
from front_door import verify_front_door_request
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, parse_json_body, require_string


s3 = boto3.client("s3")
cloudfront = boto3.client("cloudfront")

HERO_KEY = "site/hero/home"
PENDING_KEY = "temp-zips/hero-pending"
PUBLIC_TAGGING = "visibility=public"
PENDING_TAGGING = "visibility=pending"
HERO_CACHE_CONTROL = "public,max-age=86400"
MAX_HERO_BYTES = 50 * 1024 * 1024
MIN_HERO_BYTES = 1024
ETAG_PATTERN = re.compile(r"^[a-fA-F0-9]{32}$")
TYPE_POLICY = {
    "image/jpeg": {".jpg", ".jpeg"},
    "image/png": {".png"},
    "image/webp": {".webp"},
    "image/avif": {".avif"},
}


def _audit(event, context, operation, outcome, reason_code):
    actor_type, auth_method = actor_context(event)
    event_name = (
        "admin.hero_upload_authorized"
        if operation == "upload-url"
        else "admin.hero_cover_updated"
    )
    action = (
        "hero.upload.authorize"
        if operation == "upload-url"
        else "hero.cover.update"
    )
    emit_audit_event(
        event_name=event_name,
        outcome=outcome,
        action=action,
        resource_type="media",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
    )


def _operation(event):
    value = str(((event or {}).get("pathParameters") or {}).get("operation") or "").strip()
    if value not in {"upload-url", "complete"}:
        raise ValidationError("Unsupported hero operation")
    return value


def _validate_upload_intent(body):
    filename_hint = require_string(body.get("filename"), "filename", maximum=1024)
    filename = posixpath.basename(filename_hint.replace("\\", "/"))
    if not filename or filename in {".", ".."} or "\x00" in filename:
        raise ValidationError("filename is invalid")

    content_type = require_string(body.get("contentType"), "contentType", maximum=100).lower()
    extension = posixpath.splitext(filename)[1].lower()
    if content_type not in TYPE_POLICY or extension not in TYPE_POLICY[content_type]:
        raise ValidationError("Use a JPEG, PNG, WebP, or AVIF image with a matching extension")

    try:
        size = int(body.get("size"))
    except (TypeError, ValueError):
        raise ValidationError("size must be an integer") from None
    if size < MIN_HERO_BYTES:
        raise ValidationError("The hero image is too small")
    if size > MAX_HERO_BYTES:
        raise ValidationError("The hero image must be 50 MB or smaller")
    return content_type, size


def _normalize_etag(value):
    etag = require_string(value, "etag", maximum=128).strip().strip('"')
    if not ETAG_PATTERN.fullmatch(etag):
        raise ValidationError("The upload receipt is invalid")
    return etag.lower()


def _matches_content_type(content_type, prefix):
    if content_type == "image/jpeg":
        return prefix.startswith(b"\xff\xd8\xff")
    if content_type == "image/png":
        return prefix.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/webp":
        return prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP"
    if content_type == "image/avif":
        return prefix[4:8] == b"ftyp" and any(
            brand in prefix[8:32] for brand in (b"avif", b"avis")
        )
    return False


def _tag_value(response, name):
    for tag in response.get("TagSet") or []:
        if tag.get("Key") == name:
            return tag.get("Value")
    return None


def _authorize_upload(event, context, body):
    content_type, size = _validate_upload_intent(body)
    try:
        configured_ttl = int(os.environ.get("UPLOAD_URL_TTL_SECONDS", "300"))
    except (TypeError, ValueError):
        configured_ttl = 300
    expires_in = max(60, min(configured_ttl, 900))
    upload_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": os.environ["IMAGES_BUCKET"],
            "Key": PENDING_KEY,
            "ContentType": content_type,
            "ContentLength": size,
            "Tagging": PENDING_TAGGING,
        },
        ExpiresIn=expires_in,
    )
    _audit(event, context, "upload-url", "success", "upload_authorized")
    return json_response(
        200,
        {
            "uploadUrl": upload_url,
            "requiredHeaders": {
                "Content-Type": content_type,
                "x-amz-tagging": PENDING_TAGGING,
            },
            "expiresIn": expires_in,
            "maxBytes": MAX_HERO_BYTES,
        },
    )


def _activate_upload(event, context, body):
    expected_etag = _normalize_etag(body.get("etag"))
    bucket = os.environ["IMAGES_BUCKET"]
    try:
        head = s3.head_object(Bucket=bucket, Key=PENDING_KEY)
        actual_etag = str(head.get("ETag") or "").strip('"').lower()
        content_type = str(head.get("ContentType") or "").lower()
        size = int(head.get("ContentLength") or 0)
        tags = s3.get_object_tagging(Bucket=bucket, Key=PENDING_KEY)
        prefix_response = s3.get_object(Bucket=bucket, Key=PENDING_KEY, Range="bytes=0-31")
        stream = prefix_response["Body"]
        try:
            prefix = stream.read(32)
        finally:
            stream.close()
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            _audit(event, context, "complete", "denied", "pending_upload_missing")
            return error_response(409, "The uploaded hero image could not be found", code="upload_missing")
        raise

    if actual_etag != expected_etag:
        _audit(event, context, "complete", "denied", "upload_receipt_mismatch")
        return error_response(409, "The upload receipt does not match the pending image", code="upload_mismatch")
    if content_type not in TYPE_POLICY or not MIN_HERO_BYTES <= size <= MAX_HERO_BYTES:
        _audit(event, context, "complete", "denied", "uploaded_object_invalid")
        return error_response(400, "The uploaded hero image is invalid", code="invalid_upload")
    if _tag_value(tags, "visibility") != "pending" or not _matches_content_type(content_type, prefix):
        _audit(event, context, "complete", "denied", "uploaded_object_invalid")
        return error_response(400, "The uploaded hero image is invalid", code="invalid_upload")

    s3.copy_object(
        Bucket=bucket,
        Key=HERO_KEY,
        CopySource={"Bucket": bucket, "Key": PENDING_KEY},
        ContentType=content_type,
        CacheControl=HERO_CACHE_CONTROL,
        MetadataDirective="REPLACE",
        Tagging=PUBLIC_TAGGING,
        TaggingDirective="REPLACE",
    )
    cloudfront.create_invalidation(
        DistributionId=os.environ["IMAGES_DISTRIBUTION_ID"],
        InvalidationBatch={
            "Paths": {"Quantity": 1, "Items": [f"/{HERO_KEY}"]},
            "CallerReference": f"hero-{expected_etag}",
        },
    )
    # Keep the validated source available until CloudFront accepts the
    # invalidation. A transient CDN failure can then be retried without asking
    # the admin to upload the original again.
    s3.delete_object(Bucket=bucket, Key=PENDING_KEY)
    domain = os.environ["CLOUDFRONT_DOMAIN"].strip().removeprefix("https://").rstrip("/")
    _audit(event, context, "complete", "success", "hero_updated")
    return json_response(200, {"heroUrl": f"https://{domain}/{HERO_KEY}"})


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied
    operation = "unknown"
    try:
        operation = _operation(event)
        body = parse_json_body(event, max_bytes=16 * 1024)
        if operation == "upload-url":
            return _authorize_upload(event, context, body)
        return _activate_upload(event, context, body)
    except ValidationError as error:
        if operation in {"upload-url", "complete"}:
            _audit(event, context, operation, "denied", "invalid_request")
        return error_response(400, str(error), code="invalid_request")
    except Exception as error:
        if operation in {"upload-url", "complete"}:
            _audit(event, context, operation, "failure", "unexpected_error")
        return internal_error(context, error, "hero_cover")
