"""Authorize one photograph and stage opaque Fotomoto pickup objects.

The public application never gives Fotomoto an album URL, share code, Cognito
token, or protected S3 URL.  The first request creates a short-lived signed
capability.  A separate browser origin redeems that capability and receives
only an unguessable low-resolution reference URL.  The corresponding original
is copied to a private, prefix-restricted Auto Pickup namespace.
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import time
import urllib.parse

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from album_access import authorize_album
from audit_helpers import actor_context, emit_audit_event
from auth_helpers import AuthError, auth_error_response, get_verified_claims, is_admin
from front_door import verify_front_door_request
from media_access import find_image_by_media_id, public_url, validate_album_media_key
from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit
from validation_helpers import ValidationError, parse_json_body, require_string, validate_uuid
from zip_helpers import get_album_record


MEDIA_ID_PATTERN = re.compile(r"^[a-f0-9]{24}$")
SHARE_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
TOKEN_PATTERN = re.compile(r"^v1\.[A-Za-z0-9_-]{80,1536}\.[A-Za-z0-9_-]{43}$")
PRINT_PREFIX = "fotomoto"
REFERENCE_SUFFIX = "_web.jpg"
ORIGINAL_SUFFIX = "_print.jpg"
TOKEN_LIFETIME_SECONDS = 300
MAX_CLOCK_SKEW_SECONDS = 30

_secrets = None
_s3 = None
_cached_secret = None


def _secrets_client():
    global _secrets
    if _secrets is None:
        _secrets = boto3.client(
            "secretsmanager",
            config=Config(connect_timeout=3, read_timeout=5, retries={"mode": "standard", "max_attempts": 3}),
        )
    return _secrets


def _s3_client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client(
            "s3",
            config=Config(connect_timeout=3, read_timeout=15, retries={"mode": "standard", "max_attempts": 3}),
        )
    return _s3


def _signing_secret():
    global _cached_secret
    if _cached_secret is not None:
        return _cached_secret
    secret_arn = os.environ.get("PRINT_SESSION_SECRET_ARN", "").strip()
    if not secret_arn:
        raise RuntimeError("Print session secret is not configured")
    value = _secrets_client().get_secret_value(SecretId=secret_arn).get("SecretString", "")
    if not isinstance(value, str) or not 32 <= len(value) <= 512:
        raise RuntimeError("Print session secret is invalid")
    _cached_secret = value.encode("utf-8")
    return _cached_secret


def _b64encode(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _signature(value):
    return _b64encode(hmac.new(_signing_secret(), value.encode("ascii"), hashlib.sha256).digest())


def _issue_token(album, media_id, access_mode):
    now = int(time.time())
    payload = {
        "a": album["albumId"],
        "e": now + TOKEN_LIFETIME_SECONDS,
        "i": now,
        "m": media_id,
        "v": album.get("visibility"),
        "x": access_mode,
    }
    if access_mode == "share":
        payload["g"] = hashlib.sha256(album.get("shareCode", "").encode("utf-8")).hexdigest()[:32]
    encoded = _b64encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    unsigned = f"v1.{encoded}"
    return f"{unsigned}.{_signature(unsigned)}", payload["e"]


def _verify_token(token):
    if not isinstance(token, str) or not TOKEN_PATTERN.fullmatch(token):
        raise ValidationError("Invalid print session")
    version, encoded, supplied_signature = token.split(".", 2)
    unsigned = f"{version}.{encoded}"
    if not hmac.compare_digest(supplied_signature, _signature(unsigned)):
        raise ValidationError("Invalid print session")
    try:
        payload = json.loads(_b64decode(encoded).decode("utf-8"))
    except (UnicodeDecodeError, ValueError, TypeError):
        raise ValidationError("Invalid print session") from None
    expected_keys = {"a", "e", "i", "m", "v", "x"} | ({"g"} if payload.get("x") == "share" else set())
    if not isinstance(payload, dict) or set(payload) != expected_keys:
        raise ValidationError("Invalid print session")
    validate_uuid(payload.get("a"))
    if not isinstance(payload.get("m"), str) or not MEDIA_ID_PATTERN.fullmatch(payload["m"]):
        raise ValidationError("Invalid print session")
    if payload.get("v") not in {"public", "private", "unlisted"}:
        raise ValidationError("Invalid print session")
    if payload.get("x") not in {"public", "admin", "owner", "share"}:
        raise ValidationError("Invalid print session")
    issued = payload.get("i")
    expires = payload.get("e")
    now = int(time.time())
    if (
        isinstance(issued, bool)
        or not isinstance(issued, int)
        or isinstance(expires, bool)
        or not isinstance(expires, int)
        or issued > now + MAX_CLOCK_SKEW_SECONDS
        or expires <= now
        or expires - issued != TOKEN_LIFETIME_SECONDS
    ):
        raise ValidationError("Expired print session")
    if payload.get("x") == "share" and not re.fullmatch(r"[a-f0-9]{32}", str(payload.get("g", ""))):
        raise ValidationError("Invalid print session")
    return payload


def _source_key(image, album, field):
    if not isinstance(image, dict):
        raise ValidationError("Photograph is not print ready")
    raw = image.get(field)
    if field == "rawKey":
        raw = raw or image.get("key")
    if not raw:
        raise ValidationError("Photograph is not print ready")
    return validate_album_media_key(raw, album=album)


def _require_jpeg(key):
    response = _s3_client().head_object(Bucket=os.environ["IMAGES_BUCKET"], Key=key)
    content_type = str(response.get("ContentType", "")).lower()
    if content_type not in {"image/jpeg", "image/jpg"} or int(response.get("ContentLength", 0)) < 1:
        raise ValidationError("Only JPEG photographs can currently be printed")
    return str(response.get("ETag", "")).strip('"')


def _print_identifier(album_id, media_id):
    material = f"fotomoto-object\x00{album_id}\x00{media_id}".encode("utf-8")
    return hmac.new(_signing_secret(), material, hashlib.sha256).hexdigest()[:48]


def _copy_if_needed(source_key, destination_key, *, visibility, cache_control, print_id, source_etag):
    bucket = os.environ["IMAGES_BUCKET"]
    try:
        current = _s3_client().head_object(Bucket=bucket, Key=destination_key)
        if (
            int(current.get("ContentLength", 0)) > 0
            and current.get("ContentType") == "image/jpeg"
            and current.get("Metadata", {}).get("print-id") == print_id
            and current.get("Metadata", {}).get("source-etag") == source_etag
        ):
            return
    except ClientError as error:
        # S3 intentionally returns 403 for HEAD on a missing object when the
        # caller has object access but no bucket-wide ListBucket permission.
        # Keep the Lambda least-privileged and let the scoped PutObject call
        # distinguish a missing destination from a real write denial.
        if error.response.get("Error", {}).get("Code") not in {
            "403",
            "AccessDenied",
            "404",
            "NoSuchKey",
            "NotFound",
        }:
            raise
    _s3_client().copy_object(
        Bucket=bucket,
        Key=destination_key,
        CopySource={"Bucket": bucket, "Key": source_key},
        ContentType="image/jpeg",
        CacheControl=cache_control,
        Metadata={"print-id": print_id, "source-etag": source_etag},
        MetadataDirective="REPLACE",
        Tagging=urllib.parse.urlencode({"visibility": visibility}),
        TaggingDirective="REPLACE",
        ServerSideEncryption="AES256",
    )


def _stage_print(album, image, media_id):
    raw_key = _source_key(image, album, "rawKey")
    thumb_key = _source_key(image, album, "thumbKey")
    raw_etag = _require_jpeg(raw_key)
    thumb_etag = _require_jpeg(thumb_key)
    print_id = _print_identifier(album["albumId"], media_id)
    reference_key = f"{PRINT_PREFIX}/references/{print_id}{REFERENCE_SUFFIX}"
    original_key = f"{PRINT_PREFIX}/originals/{print_id}{ORIGINAL_SUFFIX}"
    _copy_if_needed(
        thumb_key,
        reference_key,
        visibility="public",
        cache_control="public,max-age=86400,s-maxage=86400",
        print_id=print_id,
        source_etag=thumb_etag,
    )
    _copy_if_needed(
        raw_key,
        original_key,
        visibility="private",
        cache_control="private,no-store",
        print_id=print_id,
        source_etag=raw_etag,
    )
    return public_url(reference_key)


def _not_found():
    return error_response(404, "Photograph not found", code="not_found")


def _audit(event, context, outcome, reason_code, *, actor_type=None, auth_method=None):
    classified_actor, classified_auth = actor_context(event)
    emit_audit_event(
        event_name="media.print_authorized",
        outcome=outcome,
        action="media.print.authorize",
        resource_type="media",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type or classified_actor,
        auth_method=auth_method or classified_auth,
    )


def _prepare(event, context, body):
    path = (event or {}).get("pathParameters") or {}
    album_id = path.get("albumId")
    share_code = path.get("shareCode")
    access_actor = access_auth = None
    if album_id:
        album = get_album_record(album_id=validate_uuid(album_id))
        if not album:
            return _not_found()
        claims = get_verified_claims(event, required=False)
        access_mode = authorize_album(album, claims=claims)
        access_actor = "admin" if is_admin(claims) else "user" if claims else "anonymous"
        access_auth = "jwt" if claims else "none"
        rate_action, rate_limit = "album_print", 30
    elif isinstance(share_code, str) and SHARE_CODE_PATTERN.fullmatch(share_code):
        album = get_album_record(share_code=share_code)
        if not album:
            return _not_found()
        access_mode = authorize_album(album, share_code=share_code)
        access_actor, access_auth = "anonymous", "share_grant"
        rate_action, rate_limit = "shared_print", 20
    else:
        return _not_found()
    if album.get("type", "photo") == "video":
        return _not_found()
    media_id = require_string(body.get("mediaId"), "mediaId", maximum=24).lower()
    if not MEDIA_ID_PATTERN.fullmatch(media_id) or not find_image_by_media_id(album, media_id):
        return _not_found()
    ip = ((event or {}).get("requestContext", {}).get("http", {}).get("sourceIp") or "unknown")
    if not check_rate_limit(f"{ip}:{album['albumId']}", rate_action, rate_limit, 300, fail_closed=True):
        _audit(event, context, "denied", "rate_limited", actor_type=access_actor, auth_method=access_auth)
        return error_response(429, "Too many print requests. Please try again later.", code="rate_limited")
    token, expires = _issue_token(album, media_id, access_mode)
    _audit(event, context, "success", "print_session_issued", actor_type=access_actor, auth_method=access_auth)
    expires_at = datetime.datetime.fromtimestamp(expires, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    return json_response(200, {"sessionToken": token, "expiresAt": expires_at})


def _redeem(event, context, body):
    payload = _verify_token(require_string(body.get("sessionToken"), "sessionToken", maximum=2048))
    album = get_album_record(album_id=payload["a"])
    if (
        not album
        or album.get("status", "active") != "active"
        or album.get("visibility") != payload["v"]
        or album.get("type", "photo") == "video"
    ):
        return _not_found()
    if payload["x"] == "share":
        grant = hashlib.sha256(album.get("shareCode", "").encode("utf-8")).hexdigest()[:32]
        if album.get("isShared") is not True or not hmac.compare_digest(grant, payload["g"]):
            return _not_found()
    image = find_image_by_media_id(album, payload["m"])
    if not image:
        return _not_found()
    ip = ((event or {}).get("requestContext", {}).get("http", {}).get("sourceIp") or "unknown")
    if not check_rate_limit(f"{ip}:{album['albumId']}", "print_redeem", 30, 300, fail_closed=True):
        _audit(event, context, "denied", "rate_limited", actor_type="anonymous", auth_method="service")
        return error_response(429, "Too many print requests. Please try again later.", code="rate_limited")
    image_url = _stage_print(album, image, payload["m"])
    _audit(event, context, "success", "print_media_staged", actor_type="anonymous", auth_method="service")
    return json_response(200, {"imageUrl": image_url})


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    try:
        body = parse_json_body(event, max_bytes=4 * 1024)
        raw_path = str((event or {}).get("rawPath") or "")
        route_key = str((event or {}).get("routeKey") or "")
        if raw_path.endswith("/print/session") or route_key.endswith(" /print/session"):
            return _redeem(event, context, body)
        return _prepare(event, context, body)
    except AuthError as error:
        _audit(event, context, "denied", "access_denied")
        if ((event or {}).get("pathParameters") or {}).get("shareCode"):
            return _not_found()
        return auth_error_response(error)
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_request")
        message = str(error)
        if message in {"Photograph is not print ready", "Only JPEG photographs can currently be printed"}:
            return error_response(409, message, code="print_not_ready")
        return error_response(400, "The print session is invalid or expired.", code="invalid_print_session")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "prepare_print")


def reset_caches_for_tests():
    global _cached_secret, _secrets, _s3
    _cached_secret = None
    _secrets = None
    _s3 = None
