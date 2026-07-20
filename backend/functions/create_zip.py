"""Authorized, rate-limited asynchronous ZIP request/status endpoint."""

import os
import re
import json

import boto3
from botocore.exceptions import ClientError

from album_access import authorize_album
from auth_helpers import AuthError, auth_error_response, get_verified_claims
from media_access import bucket_name, presigned_get_url
from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit
from validation_helpers import ValidationError, validate_uuid
from zip_helpers import get_album_record, raw_image_keys, zip_keys


s3 = boto3.client("s3")
lambda_client = boto3.client("lambda")
SHARE_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


def _not_found():
    return error_response(404, "Album not found", code="not_found")


def handler(event, context):
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
        elif share_code and SHARE_CODE_PATTERN.fullmatch(share_code):
            album = get_album_record(share_code=share_code)
            if not album:
                return _not_found()
            authorize_album(album, share_code=share_code)
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
            return error_response(429, "Too many ZIP requests. Please try again later.", code="rate_limited")

        zip_key, lock_key = zip_keys(album)
        bucket = bucket_name()
        try:
            s3.head_object(Bucket=bucket, Key=zip_key)
            return json_response(
                200,
                {
                    "status": "ready",
                    "url": presigned_get_url(zip_key, download_filename=f"{album.get('title', 'album')}.zip", expiration=600),
                },
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") not in {"404", "NoSuchKey", "NotFound"}:
                raise

        worker_running = False
        try:
            lock = s3.head_object(Bucket=bucket, Key=lock_key)
            import datetime

            age = (datetime.datetime.now(datetime.timezone.utc) - lock["LastModified"]).total_seconds()
            worker_running = age < 900
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") not in {"404", "NoSuchKey", "NotFound"}:
                raise

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
        return json_response(
            202,
            {"status": "processing", "retryAfterSeconds": 3},
            headers={"Retry-After": "3"},
        )
    except AuthError as error:
        return auth_error_response(error)
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_request")
    except Exception as error:
        return internal_error(context, error, "create_zip")
