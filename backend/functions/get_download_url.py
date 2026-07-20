"""Authorize a media identifier and issue a short-lived attachment URL."""

import os
import posixpath
import re

from album_access import authorize_album
from auth_helpers import AuthError, auth_error_response, get_verified_claims
from media_access import (
    find_image_by_media_id,
    presigned_get_url,
    url_expiry_metadata,
    validate_album_media_key,
)
from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit
from validation_helpers import ValidationError, parse_json_body, require_string, validate_uuid
from zip_helpers import get_album_record


MEDIA_ID_PATTERN = re.compile(r"^[a-f0-9]{24}$")
SHARE_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


def _not_found():
    return error_response(404, "Media not found", code="not_found")


def handler(event, context):
    try:
        path = (event or {}).get("pathParameters") or {}
        album_id = path.get("albumId")
        share_code = path.get("shareCode")
        if album_id:
            album_id = validate_uuid(album_id)
            album = get_album_record(album_id=album_id)
            if not album:
                return _not_found()
            claims = get_verified_claims(event, required=False)
            authorize_album(album, claims=claims)
            action = "album_download"
            limit = 100
        elif isinstance(share_code, str) and SHARE_CODE_PATTERN.fullmatch(share_code):
            album = get_album_record(share_code=share_code)
            if not album:
                return _not_found()
            authorize_album(album, share_code=share_code)
            action = "shared_download"
            limit = 40
        else:
            return _not_found()

        body = parse_json_body(event, max_bytes=8 * 1024)
        media_id = require_string(body.get("mediaId"), "mediaId", maximum=24).lower()
        if not MEDIA_ID_PATTERN.fullmatch(media_id):
            return _not_found()
        image = find_image_by_media_id(album, media_id)
        if not image:
            return _not_found()
        raw_key = image.get("rawKey") or image.get("key") if isinstance(image, dict) else image
        raw_key = validate_album_media_key(raw_key, album=album)

        ip = ((event or {}).get("requestContext", {}).get("http", {}).get("sourceIp") or "unknown")
        if not check_rate_limit(f"{ip}:{album['albumId']}", action, limit, 300, fail_closed=True):
            return error_response(429, "Too many download requests. Please try again later.", code="rate_limited")

        filename = posixpath.basename(raw_key) or "download"
        expires_in = max(60, min(int(os.environ.get("MEDIA_URL_TTL_SECONDS", "600")), 3600))
        return json_response(
            200,
            {
                "downloadUrl": presigned_get_url(raw_key, download_filename=filename, expiration=expires_in),
                **url_expiry_metadata(expires_in),
            },
        )
    except AuthError as error:
        # Share lookups never reveal whether a code exists but is inactive.
        if ((event or {}).get("pathParameters") or {}).get("shareCode"):
            return _not_found()
        return auth_error_response(error)
    except ValidationError:
        return _not_found()
    except Exception as error:
        return internal_error(context, error, "get_download_url")
