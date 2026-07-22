"""Authorized, rate-limited asynchronous ZIP request/status endpoint."""

import os
import re
import json

import boto3

from audit_helpers import actor_context, emit_audit_event
from album_access import authorize_album
from auth_helpers import AuthError, auth_error_response, get_verified_claims, is_admin
from media_access import bucket_name, presigned_get_url
from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit
from validation_helpers import ValidationError, validate_uuid
from zip_helpers import get_album_record, raw_image_keys, zip_keys


s3 = boto3.client("s3")
lambda_client = boto3.client("lambda")
SHARE_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


def _object_metadata(bucket, key):
    """Check an exact temporary key with prefix-scoped ListBucket access.

    S3 intentionally returns 403, rather than 404, when HeadObject checks a
    missing key and the caller's ListBucket permission is prefix-constrained.
    Listing the exact server-generated key avoids that ambiguity without
    granting this request handler permission to enumerate album object names.
    """
    response = s3.list_objects_v2(Bucket=bucket, Prefix=key, MaxKeys=1)
    contents = response.get("Contents", [])
    if not isinstance(contents, list):
        raise RuntimeError("Malformed temporary object lookup")
    return next(
        (item for item in contents if isinstance(item, dict) and item.get("Key") == key),
        None,
    )


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

        if album.get("type", "photo") != "photo":
            return error_response(400, "ZIP downloads are available for photo albums", code="unsupported")
        image_keys = raw_image_keys(album)
        max_objects = max(1, min(int(os.environ.get("ZIP_MAX_OBJECTS", "1000")), 5000))
        if not image_keys:
            return error_response(400, "Album has no downloadable photos", code="empty_album")
        if len(image_keys) > max_objects:
            return error_response(413, "Album is too large for ZIP download", code="zip_too_large")

        ip = ((event or {}).get("requestContext", {}).get("http", {}).get("sourceIp") or "unknown")
        rate_identifier = f"{ip}:{album['albumId']}"
        if not check_rate_limit(rate_identifier, "zip_status", 30, 300, fail_closed=True):
            _audit(event, context, "denied", "rate_limited", actor_type=access_actor, auth_method=access_auth)
            return error_response(429, "Too many ZIP requests. Please try again later.", code="rate_limited")

        zip_key, lock_key = zip_keys(album)
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

        worker_running = False
        lock = _object_metadata(bucket, lock_key)
        if lock:
            import datetime

            age = (datetime.datetime.now(datetime.timezone.utc) - lock["LastModified"]).total_seconds()
            worker_running = age < 900

        if not worker_running:
            s3.put_object(
                Bucket=bucket,
                Key=lock_key,
                Body=b"locked",
                Tagging="visibility=pending",
                ContentType="application/octet-stream",
            )
            lambda_client.invoke(
                FunctionName=os.environ["WORKER_FUNCTION_NAME"],
                InvocationType="Event",
                Payload=json.dumps({"albumId": album_id, "shareCode": share_code}),
            )
        _audit(
            event, context, "success", "archive_processing", zip_state="processing",
            actor_type=access_actor, auth_method=access_auth,
        )
        return json_response(
            202,
            {"status": "processing", "retryAfterSeconds": 3},
            headers={"Retry-After": "3"},
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
