"""Active-share-only album retrieval with protected media URLs."""

import os
import re

import boto3
from boto3.dynamodb.conditions import Key

from album_access import authorize_album
from auth_helpers import AuthError, auth_error_response
from media_access import serialize_album_detail, serialize_images
from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit, verify_turnstile
from validation_helpers import ValidationError


SHARE_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])


def handler(event, context):
    try:
        ip = ((event or {}).get("requestContext", {}).get("http", {}).get("sourceIp") or "unknown")
        share_code = (((event or {}).get("pathParameters") or {}).get("shareCode") or "").strip()
        if not SHARE_CODE_PATTERN.fullmatch(share_code):
            return error_response(404, "Shared album not found", code="not_found")
        headers = {str(key).lower(): value for key, value in ((event or {}).get("headers") or {}).items()}
        turnstile_token = headers.get("x-turnstile-token", "")
        if not verify_turnstile(turnstile_token, ip, expected_action="shared_album"):
            return error_response(403, "Security verification failed", code="captcha_failed")
        if not check_rate_limit(ip, "shared_album", max_requests=30, window_seconds=300, fail_closed=True):
            return error_response(429, "Too many requests. Please try again later.", code="rate_limited")

        response = table.query(
            IndexName=os.environ.get("SHARE_CODE_INDEX", "ShareCodeIndex"),
            KeyConditionExpression=Key("shareCode").eq(share_code),
            Limit=2,
        )
        items = response.get("Items", [])
        if len(items) != 1:
            return error_response(404, "Shared album not found", code="not_found")
        album = items[0]
        authorize_album(album, share_code=share_code)

        # Compatibility shape: current shared frontend expects album fields and
        # images at the top level.
        body = serialize_album_detail(album)
        body["images"] = serialize_images(album)
        return json_response(200, body, cache_control="private, no-store")
    except AuthError as error:
        # Do not distinguish revoked/forbidden share codes from missing codes.
        if error.status_code in {401, 403, 404}:
            return error_response(404, "Shared album not found", code="not_found")
        return auth_error_response(error)
    except ValidationError:
        return error_response(404, "Shared album not found", code="not_found")
    except Exception as error:
        return internal_error(context, error, "get_shared_album")
