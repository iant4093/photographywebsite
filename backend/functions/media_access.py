"""Protected media URL, DTO, key-validation, and S3 visibility-tag helpers."""

import hashlib
import datetime
import os
import posixpath
import re
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from validation_helpers import ALLOWED_VISIBILITIES, ValidationError, validate_uuid


VISIBILITY_TAG_KEY = "visibility"
PENDING_VISIBILITY = "pending"
ALLOWED_TAG_VALUES = ALLOWED_VISIBILITIES | {PENDING_VISIBILITY}
PROTECTED_VISIBILITIES = {"private", "unlisted", PENDING_VISIBILITY}
LEGACY_PREFIX_SEGMENT = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,198}[a-z0-9])?$")

_s3 = None


def get_s3_client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client(
            "s3",
            config=Config(
                connect_timeout=3,
                read_timeout=10,
                max_pool_connections=16,
                retries={"mode": "standard", "max_attempts": 3},
            ),
        )
    return _s3


def bucket_name():
    bucket = os.environ.get("IMAGES_BUCKET", "").strip()
    if not bucket:
        raise RuntimeError("Media bucket is not configured")
    return bucket


def cdn_domain():
    return os.environ.get("CLOUDFRONT_DOMAIN", "").strip().removeprefix("https://").rstrip("/")


def _ttl_seconds():
    try:
        return max(60, min(int(os.environ.get("MEDIA_URL_TTL_SECONDS", "600")), 3600))
    except ValueError:
        return 600


def url_expiry_metadata(expiration=None):
    ttl = expiration or _ttl_seconds()
    expires = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=ttl)
    return {"expiresIn": ttl, "expiresAt": expires.isoformat().replace("+00:00", "Z")}


def normalize_object_key(key):
    if not isinstance(key, str):
        raise ValidationError("Invalid media key")
    key = key.strip().lstrip("/")
    if not key or len(key) > 1024 or "\x00" in key or "\\" in key:
        raise ValidationError("Invalid media key")
    normalized = posixpath.normpath(key)
    if normalized in {".", ".."} or normalized.startswith("../"):
        raise ValidationError("Invalid media key")
    return normalized


def canonical_album_prefix(album_id):
    return f"albums/{validate_uuid(album_id)}/"


def approved_legacy_prefix(album):
    """Return an immutable, migration-approved legacy prefix or None.

    The mutable historical `s3Prefix` field is intentionally ignored. Approval
    requires a separate backfilled field and a normalized, single safe segment.
    """
    if not isinstance(album, dict):
        return None
    raw = album.get("legacyS3Prefix")
    if not isinstance(raw, str) or len(raw) > 220 or raw != raw.strip():
        return None
    parts = raw.split("/")
    if len(parts) != 3 or parts[0] != "albums" or parts[2] != "":
        return None
    segment = parts[1]
    if not LEGACY_PREFIX_SEGMENT.fullmatch(segment) or segment in {".", ".."}:
        return None
    # The album ID still has to be a valid record key. This binds approval to
    # the exact fetched record even though historic prefixes did not encode it.
    canonical_album_prefix(album.get("albumId"))
    return raw


def album_media_prefixes(album):
    canonical = canonical_album_prefix((album or {}).get("albumId"))
    legacy = approved_legacy_prefix(album)
    return tuple(dict.fromkeys(prefix for prefix in (canonical, legacy) if prefix))


def validate_album_media_key(key, album_id=None, album=None):
    key = normalize_object_key(key)
    if album is not None:
        allowed_prefixes = album_media_prefixes(album)
    elif album_id:
        allowed_prefixes = (canonical_album_prefix(album_id),)
    else:
        allowed_prefixes = ()
    if not allowed_prefixes or not any(key.startswith(item) for item in allowed_prefixes):
        raise ValidationError("Media key is outside the album namespace")
    return key


def validate_media_key_under_prefix(key, trusted_prefix):
    """Validate internal worker input against a code-controlled broad prefix."""
    key = normalize_object_key(key)
    prefix = normalize_object_key(trusted_prefix).rstrip("/") + "/"
    if not key.startswith(prefix):
        raise ValidationError("Media key is outside the trusted namespace")
    return key


def public_url(key):
    key = normalize_object_key(key)
    domain = cdn_domain()
    if not domain:
        raise RuntimeError("Media CDN is not configured")
    encoded = urllib.parse.quote(key, safe="/~")
    return f"https://{domain}/{encoded}"


def presigned_get_url(key, *, download_filename=None, expiration=None):
    key = normalize_object_key(key)
    params = {"Bucket": bucket_name(), "Key": key}
    if download_filename:
        safe_name = posixpath.basename(str(download_filename)).replace("\r", "").replace("\n", "")[:180]
        encoded = urllib.parse.quote(safe_name or "download", safe="")
        params["ResponseContentDisposition"] = f"attachment; filename*=UTF-8''{encoded}"
    return get_s3_client().generate_presigned_url(
        "get_object",
        Params=params,
        ExpiresIn=expiration or _ttl_seconds(),
    )


def media_url(key, visibility, *, download_filename=None):
    if not key:
        return ""
    if visibility == "public" and download_filename is None:
        return public_url(key)
    return presigned_get_url(key, download_filename=download_filename)


def media_id_for_key(key):
    return hashlib.sha256(normalize_object_key(key).encode("utf-8")).hexdigest()[:24]


def _raw_key(image):
    if isinstance(image, str):
        return image
    if not isinstance(image, dict):
        return ""
    return image.get("rawKey") or image.get("key") or ""


def find_image_by_media_id(album, media_id):
    if not isinstance(media_id, str) or len(media_id) != 24:
        return None
    for image in album.get("images", []):
        key = _raw_key(image)
        if key and media_id_for_key(key) == media_id:
            return image
    return None


def serialize_image(image, visibility, *, include_internal=False):
    key = normalize_object_key(_raw_key(image))
    source = image if isinstance(image, dict) else {}
    thumb_key = source.get("thumbKey") or ""
    hls_key = source.get("hlsUrl") or ""
    result = {
        "id": media_id_for_key(key),
        "url": media_url(key, visibility),
        "thumbnailUrl": media_url(thumb_key, visibility) if thumb_key else media_url(key, visibility),
    }
    if visibility == "public":
        result["downloadUrl"] = public_url(key)
    else:
        result.update(url_expiry_metadata())
        result["freshDownloadRequired"] = True
    for field in ("width", "height", "blurhash", "exif", "thumbnailTime"):
        if field in source:
            result[field] = source[field]

    # Relative HLS manifests cannot propagate an S3 signature to segment requests.
    # Protected videos therefore use the signed raw URL until signed-cookie CDN
    # delivery is available. Public videos keep CDN HLS playback.
    if visibility == "public" and hls_key:
        result["hlsUrl"] = media_url(hls_key, visibility)
    if include_internal:
        result.update({"rawKey": key, "thumbKey": thumb_key, "hlsKey": hls_key})
        if "mediaConvertJobId" in source:
            result["mediaConvertJobId"] = source["mediaConvertJobId"]
    return result


def serialize_images(album, *, include_internal=False):
    visibility = album.get("visibility")
    if visibility not in ALLOWED_VISIBILITIES:
        raise ValidationError("Album has an invalid visibility")
    results = []
    for image in album.get("images", []):
        try:
            source = image if isinstance(image, dict) else {"rawKey": image}
            validated = dict(source)
            raw_key = validate_album_media_key(
                _raw_key(source),
                album=album,
            )
            validated["rawKey"] = raw_key
            validated.pop("key", None)
            for field in ("thumbKey", "hlsUrl"):
                if source.get(field):
                    validated[field] = validate_album_media_key(
                        source[field],
                        album=album,
                    )
            results.append(serialize_image(validated, visibility, include_internal=include_internal))
        except ValidationError:
            # A malformed stored key must not cause an out-of-namespace URL leak.
            continue
    return results


def serialize_album_summary(album, *, include_admin=False):
    visibility = album.get("visibility")
    if visibility not in ALLOWED_VISIBILITIES:
        raise ValidationError("Album has an invalid visibility")
    cover_key = album.get("coverImageUrl", "")
    cover_url = ""
    if isinstance(cover_key, str) and cover_key.startswith("https://"):
        parsed = urllib.parse.urlsplit(cover_key)
        # Retain only legacy absolute URLs served by this configured CDN.
        if visibility == "public" and parsed.scheme == "https" and parsed.netloc == cdn_domain():
            cover_url = cover_key
    elif cover_key:
        cover_key = validate_album_media_key(cover_key, album=album)
        cover_url = media_url(cover_key, visibility)
    thumb_key = album.get("coverThumbKey", "")
    if thumb_key:
        thumb_key = validate_album_media_key(thumb_key, album=album)
    summary = {
        "albumId": album.get("albumId", ""),
        "type": album.get("type", "photo"),
        "title": album.get("title", ""),
        "description": album.get("description", ""),
        "category": album.get("category", "Uncategorized"),
        "createdAt": album.get("createdAt", ""),
        "visibility": visibility,
        "imageCount": len(album.get("images", [])),
        "coverImageUrl": cover_url,
        "coverThumbnailUrl": media_url(thumb_key, visibility) if thumb_key else cover_url,
        "coverBlurhash": album.get("coverBlurhash", ""),
    }
    if visibility in PROTECTED_VISIBILITIES:
        summary.update(url_expiry_metadata())
    if include_admin:
        summary.update(
            {
                "ownerEmail": album.get("ownerEmail", ""),
                "ownerSub": album.get("ownerSub", ""),
                "isShared": bool(album.get("isShared", False)),
                "shareCode": album.get("shareCode", ""),
                "s3Prefix": approved_legacy_prefix(album) or canonical_album_prefix(album.get("albumId")),
                "legacyS3Prefix": approved_legacy_prefix(album) or "",
            }
        )
    return summary


def serialize_album_detail(album, *, include_admin=False):
    summary = serialize_album_summary(album, include_admin=include_admin)
    summary.pop("imageCount", None)
    if include_admin:
        summary["backupToGoogleDrive"] = bool(album.get("backupToGoogleDrive", False))
    return summary


def _merge_visibility_tag(key, visibility):
    if visibility not in ALLOWED_TAG_VALUES:
        raise ValidationError("Invalid media visibility tag")
    key = normalize_object_key(key)
    s3 = get_s3_client()
    existing = []
    try:
        existing = s3.get_object_tagging(Bucket=bucket_name(), Key=key).get("TagSet", [])
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code", "")
        if code in {"NoSuchKey", "404", "NotFound"}:
            return False
        raise
    tags = {item.get("Key"): item.get("Value") for item in existing if item.get("Key")}
    tags[VISIBILITY_TAG_KEY] = visibility
    tag_set = [{"Key": tag_key, "Value": value} for tag_key, value in sorted(tags.items())]
    s3.put_object_tagging(Bucket=bucket_name(), Key=key, Tagging={"TagSet": tag_set})
    return True


def tag_keys_visibility(keys, visibility):
    seen = set()
    normalized_keys = []
    for key in keys:
        if not key:
            continue
        normalized = normalize_object_key(key)
        if normalized in seen:
            continue
        seen.add(normalized)
        normalized_keys.append(normalized)
    if not normalized_keys:
        return 0

    try:
        configured_workers = int(os.environ.get("MEDIA_TAG_WORKERS", "12"))
    except ValueError:
        configured_workers = 12
    max_workers = max(1, min(configured_workers, 16, len(normalized_keys)))
    # executor.map yields in input order. Any S3 error propagates deterministically
    # and callers leave the album pending (or otherwise unavailable) for retry.
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="media-tag") as executor:
        results = list(executor.map(lambda key: _merge_visibility_tag(key, visibility), normalized_keys))
    return sum(bool(result) for result in results)


def album_known_keys(album):
    keys = [album.get("coverImageUrl", ""), album.get("coverThumbKey", "")]
    for image in album.get("images", []):
        if isinstance(image, dict):
            keys.extend((image.get("rawKey", ""), image.get("key", ""), image.get("thumbKey", ""), image.get("hlsUrl", "")))
        elif isinstance(image, str):
            keys.append(image)
    validated = []
    for key in keys:
        if not isinstance(key, str) or not key or key.startswith("http"):
            continue
        try:
            validated.append(validate_album_media_key(key, album=album))
        except ValidationError:
            continue
    return validated


def _hls_prefixes(album):
    prefixes = []
    for image in album.get("images", []):
        raw_key = _raw_key(image)
        if not raw_key:
            continue
        try:
            raw_key = validate_album_media_key(raw_key, album=album)
        except ValidationError:
            continue
        prefixes.append(raw_key.rsplit(".", 1)[0] + "_hls/")
    return prefixes


def tag_album_visibility(album, visibility, *, include_derivatives=False, max_derivatives=5000):
    if visibility not in ALLOWED_VISIBILITIES:
        raise ValidationError("Invalid album visibility")
    tagged = tag_keys_visibility(album_known_keys(album), visibility)
    if not include_derivatives:
        return tagged

    s3 = get_s3_client()
    remaining = max_derivatives
    derivative_keys = []
    for prefix in _hls_prefixes(album):
        if remaining <= 0:
            break
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket_name(), Prefix=prefix, PaginationConfig={"MaxItems": remaining}):
            page_keys = [item["Key"] for item in page.get("Contents", []) if item.get("Key")]
            derivative_keys.extend(page_keys)
            remaining -= len(page_keys)
            if remaining <= 0:
                break
    return tagged + tag_keys_visibility(derivative_keys, visibility)
