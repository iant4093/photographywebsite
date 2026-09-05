"""Authorize on-demand media downloads and camera-original comparisons."""

import os
import posixpath
import re

from audit_helpers import actor_context, emit_audit_event
from album_access import authorize_album
from auth_helpers import AuthError, auth_error_response, get_verified_claims, is_admin
from media_access import (
    find_image_by_media_id,
    presigned_get_url,
    url_expiry_metadata,
    validate_album_media_key,
)
from original_comparison_access import load_original_comparisons_for_albums, serialize_original_comparison
from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit
from validation_helpers import ValidationError, parse_json_body, require_string, validate_uuid
from zip_helpers import get_album_record


MEDIA_ID_PATTERN = re.compile(r"^[a-f0-9]{24}$")
SHARE_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


def _not_found():
    return error_response(404, "Media not found", code="not_found")


def _is_original_comparison(event):
    request = event or {}
    route_key = request.get("routeKey") or (request.get("requestContext") or {}).get("routeKey") or ""
    return str(request.get("rawPath") or "").endswith("/original-comparison") or str(route_key).endswith("/original-comparison")


def _audit(event, context, outcome, reason_code, *, actor_type=None, auth_method=None):
    classified_actor, classified_auth = actor_context(event)
    comparison = _is_original_comparison(event)
    emit_audit_event(
        event_name="media.original_authorized" if comparison else "media.download_authorized",
        outcome=outcome,
        action="media.original.authorize" if comparison else "media.download.authorize",
        resource_type="media" if comparison else "download",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type or classified_actor,
        auth_method=auth_method or classified_auth,
    )


from front_door import verify_front_door_request


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    access_actor = access_auth = None
    comparison = _is_original_comparison(event)
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
            access_actor = "admin" if is_admin(claims) else "user" if claims else "anonymous"
            access_auth = "jwt" if claims else "none"
            action = "album_original_comparison" if comparison else "album_download"
            limit = 100
        elif isinstance(share_code, str) and SHARE_CODE_PATTERN.fullmatch(share_code):
            album = get_album_record(share_code=share_code)
            if not album:
                return _not_found()
            if comparison:
                # The share index can lag revocation. Recheck the current album
                # before issuing fresh access to private original previews.
                album = get_album_record(album_id=album["albumId"])
            authorize_album(album, share_code=share_code)
            access_actor, access_auth = "anonymous", "share_grant"
            action = "shared_original_comparison" if comparison else "shared_download"
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
            _audit(event, context, "denied", "rate_limited", actor_type=access_actor, auth_method=access_auth)
            kind = "comparison" if comparison else "download"
            return error_response(429, f"Too many {kind} requests. Please try again later.", code="rate_limited")

        if comparison:
            metadata = load_original_comparisons_for_albums([(album, [image])])
            before = serialize_original_comparison(image, album, metadata.get(album["albumId"], {}).get(media_id))
            _audit(event, context, "success", "original_authorized", actor_type=access_actor, auth_method=access_auth)
            return json_response(200, {"before": before})

        filename = posixpath.basename(raw_key) or "download"
        expires_in = max(60, min(int(os.environ.get("MEDIA_URL_TTL_SECONDS", "600")), 3600))
        _audit(event, context, "success", "download_authorized", actor_type=access_actor, auth_method=access_auth)
        return json_response(
            200,
            {
                "downloadUrl": presigned_get_url(raw_key, download_filename=filename, expiration=expires_in),
                **url_expiry_metadata(expires_in),
            },
        )
    except AuthError as error:
        _audit(event, context, "denied", "access_denied", actor_type=access_actor, auth_method=access_auth)
        # Share lookups never reveal whether a code exists but is inactive.
        if ((event or {}).get("pathParameters") or {}).get("shareCode"):
            return _not_found()
        return auth_error_response(error)
    except ValidationError:
        _audit(event, context, "denied", "invalid_request", actor_type=access_actor, auth_method=access_auth)
        return _not_found()
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error", actor_type=access_actor, auth_method=access_auth)
        return internal_error(context, error, "get_original_comparison" if comparison else "get_download_url")
