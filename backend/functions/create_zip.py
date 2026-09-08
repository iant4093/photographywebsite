"""Authorized, rate-limited asynchronous ZIP request/status endpoint."""

import os
import re
import json

import boto3
from botocore.exceptions import ClientError

from audit_helpers import actor_context, emit_audit_event
from album_access import authorize_album
from auth_helpers import AuthError, auth_error_response, get_verified_claims, is_admin
from media_access import bucket_name, presigned_get_url
from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit
from validation_helpers import ValidationError, validate_uuid
from zip_helpers import get_album_record, raw_image_keys, zip_keys
from zip_jobs import enqueue_zip, object_metadata


s3 = boto3.client("s3")
SHARE_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


def _object_metadata(bucket, key):
    """Check an exact archive/status key with prefix-scoped ListBucket access.

    S3 intentionally returns 403, rather than 404, when HeadObject checks a
    missing key and the caller's ListBucket permission is prefix-constrained.
    Listing the exact server-generated key avoids that ambiguity without
    granting this request handler permission to enumerate album object names.
    """
    return object_metadata(s3, bucket, key)


def _not_found():
    return error_response(404, "Album not found", code="not_found")


def _audit(event, context, outcome, reason_code, *, zip_state=None, actor_type=None, auth_method=None):
    classified_actor, classified_auth = actor_context(event)
    emit_audit_event(
        event_name="archive.zip_requested",
        outcome=outcome,
        action="album.archive.request",
        resource_type="archive",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type or classified_actor,
        auth_method=auth_method or classified_auth,
        details={"zip_state": zip_state} if zip_state else None,
    )


from front_door import verify_front_door_request


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    access_actor = access_auth = None
    try:
        path = (event or {}).get("pathParameters") or {}
        album_id = path.get("albumId")
        share_code = path.get("shareCode")
        claims = None
        if album_id:
            album_id = validate_uuid(album_id)
            claims = get_verified_claims(event, required=False)
            album = get_album_record(album_id=album_id)
            if not album:
                return _not_found()
            authorize_album(album, claims=claims)
            access_actor = "admin" if is_admin(claims) else "user" if claims else "anonymous"
            access_auth = "jwt" if claims else "none"
        elif share_code and SHARE_CODE_PATTERN.fullmatch(share_code):
            album = get_album_record(share_code=share_code)
            if not album:
                return _not_found()
            authorize_album(album, share_code=share_code)
            access_actor, access_auth = "anonymous", "share_grant"
        else:
            return _not_found()

        if album.get("type", "photo") not in {"photo", "video"}:
            return error_response(400, "ZIP downloads are unavailable for this album type", code="unsupported")
        image_keys = raw_image_keys(album)
        max_objects = max(1, min(int(os.environ.get("ZIP_MAX_OBJECTS", "1000")), 5000))
        if not image_keys:
            return error_response(400, "Album has no downloadable media", code="empty_album")
        if len(image_keys) > max_objects:
            return error_response(413, "Album is too large for ZIP download", code="zip_too_large")

        ip = ((event or {}).get("requestContext", {}).get("http", {}).get("sourceIp") or "unknown")
        rate_identifier = f"{ip}:{album['albumId']}"
        if not check_rate_limit(rate_identifier, "zip_status", 120, 300, fail_closed=True):
            _audit(event, context, "denied", "rate_limited", actor_type=access_actor, auth_method=access_auth)
            return error_response(429, "Too many ZIP requests. Please try again later.", code="rate_limited")

        zip_key, failure_key = zip_keys(album)
        bucket = bucket_name()
        if _object_metadata(bucket, zip_key):
            _audit(
                event, context, "success", "archive_ready", zip_state="ready",
                actor_type=access_actor, auth_method=access_auth,
            )
            return json_response(
                200,
                {
                    "status": "ready",
                    "url": presigned_get_url(zip_key, download_filename=f"{album.get('title', 'album')}.zip", expiration=600),
                },
            )

        if _object_metadata(bucket, failure_key):
            try:
                response = s3.get_object(Bucket=bucket, Key=failure_key)
            except ClientError as error:
                # A retry may clear the error between the lookup and the read.
                if error.response.get("Error", {}).get("Code") not in {"NoSuchKey", "404", "NotFound"}:
                    raise
            else:
                try:
                    failure = json.loads(response["Body"].read())
                finally:
                    response["Body"].close()
                _audit(
                    event, context, "failure", "archive_failed", zip_state="failed",
                    actor_type=access_actor, auth_method=access_auth,
                )
                return json_response(200, failure)
        enqueue_zip(album["albumId"], album)
        _audit(
            event, context, "success", "archive_processing", zip_state="processing",
            actor_type=access_actor, auth_method=access_auth,
        )
        return json_response(
            202,
            {"status": "processing", "retryAfterSeconds": 2},
            headers={"Retry-After": "2"},
        )
    except AuthError as error:
        _audit(event, context, "denied", "access_denied", actor_type=access_actor, auth_method=access_auth)
        return auth_error_response(error)
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_request", actor_type=access_actor, auth_method=access_auth)
        return error_response(400, str(error), code="invalid_request")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error", actor_type=access_actor, auth_method=access_auth)
        return internal_error(context, error, "create_zip")
