"""Generate deterministic, visibility-tagged QR assets for eligible albums."""

import hashlib
import io
import os
import re
import urllib.parse

import segno

from media_access import PENDING_VISIBILITY, bucket_name, get_s3_client
from validation_helpers import ValidationError, validate_uuid


SHARE_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
QR_VERSION = 1


def frontend_origin(value=None):
    raw = (value if value is not None else os.environ.get("FRONTEND_URL", "")).strip()
    parsed = urllib.parse.urlsplit(raw)
    try:
        port = parsed.port
    except ValueError as error:
        raise ValidationError("Frontend URL is invalid") from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or (port not in {None, 443})
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValidationError("Frontend URL must be an HTTPS origin")
    return f"https://{parsed.hostname.lower()}"


def album_qr_target_url(album, *, origin=None, require_active=False):
    if not isinstance(album, dict):
        return None
    if require_active and album.get("status", "active") != "active":
        return None
    album_id = validate_uuid(album.get("albumId"))
    album_type = album.get("type", "photo")
    if album_type not in {"photo", "video"}:
        raise ValidationError("Album has an invalid type")
    base = frontend_origin(origin)
    visibility = album.get("visibility")
    if visibility == "public":
        route = "video" if album_type == "video" else "album"
        return f"{base}/{route}/{album_id}"
    if visibility == "unlisted" and bool(album.get("isShared")):
        share_code = album.get("shareCode")
        if isinstance(share_code, str) and SHARE_CODE_PATTERN.fullmatch(share_code):
            return f"{base}/sharedalbum/{share_code}"
    return None


def album_qr_key(album, *, origin=None, require_active=False):
    target = album_qr_target_url(album, origin=origin, require_active=require_active)
    if not target:
        return None
    album_id = validate_uuid(album.get("albumId"))
    digest = hashlib.sha256(target.encode("utf-8")).hexdigest()[:24]
    return f"albums/{album_id}/qr/v{QR_VERSION}/{digest}.svg"


def render_album_qr_svg(target):
    if not isinstance(target, str) or len(target) > 512:
        raise ValidationError("Album QR target is invalid")
    parsed = urllib.parse.urlsplit(target)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValidationError("Album QR target must use HTTPS")
    output = io.BytesIO()
    segno.make(target, error="h", micro=False).save(
        output,
        kind="svg",
        scale=8,
        border=4,
        dark="#2f2a24",
        light="#ffffff",
        xmldecl=False,
        svgns=True,
    )
    return output.getvalue()


def write_album_qr(album, *, origin=None, s3_client=None, bucket=None):
    target = album_qr_target_url(album, origin=origin)
    if not target:
        return None
    key = album_qr_key(album, origin=origin)
    visibility = album.get("visibility")
    cache_control = (
        "public, max-age=31536000, immutable"
        if visibility == "public"
        else "private, max-age=300"
    )
    (s3_client or get_s3_client()).put_object(
        Bucket=bucket or bucket_name(),
        Key=key,
        Body=render_album_qr_svg(target),
        ContentType="image/svg+xml",
        CacheControl=cache_control,
        ContentDisposition="inline",
        Tagging=f"visibility={PENDING_VISIBILITY}",
    )
    return key
