"""Anonymous public album JSON plus safe server-rendered social metadata."""

import html
import logging
import os
import re
import secrets
import threading
import time
import urllib.request

import boto3
from boto3.dynamodb.conditions import Attr, Key

from media_access import (
    album_media_prefixes,
    bucket_name,
    load_preview_metadata_for_albums,
    serialize_album_detail,
    serialize_images,
)
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_uuid


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
s3 = boto3.client("s3")

logger = logging.getLogger("photography_api.public_album")
SITE_ORIGIN = "https://iantruongphotography.com"
SITE_TITLE = "Ian Truong Photography"
SITE_DESCRIPTION = (
    "Ian Truong Photography — a portfolio of wildlife, portraits, sports, travel, and landscapes."
)
HERO_IMAGE_URL = "https://{}/site/hero/current/hero.jpg"
MAX_SHELL_BYTES = 512 * 1024
SHELL_CACHE_SECONDS = 60
_shell_cache = {"html": None, "expires_at": 0.0}
_shell_lock = threading.Lock()
_SOCIAL_META_PATTERN = re.compile(
    r"\s*<meta\s+(?:property|name)=[\"'](?:og:[^\"']+|twitter:[^\"']+)[\"'][^>]*?/?>",
    re.IGNORECASE,
)
_CANONICAL_PATTERN = re.compile(
    r"<link\s+rel=[\"']canonical[\"']\s+href=[\"'][^\"']*[\"']\s*/?>",
    re.IGNORECASE,
)
_TITLE_PATTERN = re.compile(r"<title>.*?</title>", re.IGNORECASE | re.DOTALL)
_DESCRIPTION_PATTERN = re.compile(
    r"<meta\s+name=[\"']description[\"']\s+content=[\"'][^\"']*[\"']\s*/?>",
    re.IGNORECASE,
)
RANDOM_PHOTO_LIMIT = 80


def _legacy_images(album):
    images = []
    seen = set()
    remaining = 1000
    paginator = s3.get_paginator("list_objects_v2")
    for prefix in album_media_prefixes(album):
        if remaining <= 0:
            break
        for page in paginator.paginate(
            Bucket=bucket_name(),
            Prefix=prefix,
            PaginationConfig={"MaxItems": remaining},
        ):
            for obj in page.get("Contents", []):
                key = obj.get("Key", "")
                basename = key.rsplit("/", 1)[-1]
                if (
                    not key
                    or key in seen
                    or key.endswith("/")
                    or "_hls/" in key
                    or "/thumbnail/" in key
                    or "/preview/" in key
                    or basename.startswith("thumb_")
                ):
                    continue
                seen.add(key)
                images.append({"rawKey": key})
            remaining = 1000 - len(images)
            if remaining <= 0:
                break
    return images


def _random_photo_albums():
    albums = []
    cursor = None
    while True:
        query = {
            "IndexName": os.environ["VISIBILITY_CREATED_AT_INDEX"],
            "KeyConditionExpression": Key("visibility").eq("public"),
            "FilterExpression": (
                (Attr("status").not_exists() | Attr("status").eq("active"))
                & (Attr("type").not_exists() | Attr("type").eq("photo"))
            ),
            "ScanIndexForward": False,
        }
        if cursor:
            query["ExclusiveStartKey"] = cursor
        response = table.query(**query)
        albums.extend(response.get("Items", []))
        cursor = response.get("LastEvaluatedKey")
        if not cursor:
            return albums


def _random_photos_response(event):
    if (event or {}).get("queryStringParameters"):
        return error_response(400, "Random photos does not accept query parameters", code="invalid_request")

    sample = []
    total_photos = 0
    for album in _random_photo_albums():
        media = album.get("images") or _legacy_images(album)
        for image in media:
            if not isinstance(image, dict) or not isinstance(image.get("rawKey"), str):
                continue
            total_photos += 1
            candidate = (album, image)
            if len(sample) < RANDOM_PHOTO_LIMIT:
                sample.append(candidate)
                continue
            replacement = secrets.randbelow(total_photos)
            if replacement < RANDOM_PHOTO_LIMIT:
                sample[replacement] = candidate

    grouped = {}
    for album, image in sample:
        group = grouped.setdefault(album["albumId"], {"album": album, "images": []})
        group["images"].append(image)

    images = []
    metadata_by_album = load_preview_metadata_for_albums(
        [(group["album"], group["images"]) for group in grouped.values()]
    )
    for group in grouped.values():
        album = group["album"]
        serialized = serialize_images(
            {**album, "images": group["images"]},
            preview_metadata_by_id=metadata_by_album.get(album["albumId"], {}),
        )
        images.extend(
            {
                **image,
                "albumId": album.get("albumId", ""),
                "albumTitle": album.get("title", ""),
                "albumCategory": album.get("category", "Uncategorized"),
            }
            for image in serialized
        )

    secrets.SystemRandom().shuffle(images)
    return json_response(
        200,
        {"images": images, "totalPhotos": total_photos},
        cache_control="public, max-age=0, s-maxage=300, stale-while-revalidate=600",
    )


def _base_shell():
    """Read the current deployed shell without coupling Lambda to Vite hashes."""
    now = time.monotonic()
    with _shell_lock:
        if _shell_cache["html"] and now < _shell_cache["expires_at"]:
            return _shell_cache["html"]
        try:
            request = urllib.request.Request(
                f"{SITE_ORIGIN}/index.html",
                headers={"User-Agent": "IanTruongPhotography-SocialPreview/1.0"},
            )
            with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310 - fixed HTTPS origin
                content_type = response.headers.get_content_type()
                payload = response.read(MAX_SHELL_BYTES + 1)
            if content_type != "text/html" or len(payload) > MAX_SHELL_BYTES:
                raise ValueError("Invalid frontend shell response")
            shell = payload.decode("utf-8")
            if "<head" not in shell.lower() or "</head>" not in shell.lower():
                raise ValueError("Invalid frontend shell document")
        except Exception:
            if _shell_cache["html"]:
                return _shell_cache["html"]
            raise
        _shell_cache.update(html=shell, expires_at=now + SHELL_CACHE_SECONDS)
        return shell


def _safe_text(value, fallback, maximum):
    if not isinstance(value, str):
        return fallback
    normalized = " ".join(value.split())[:maximum].strip()
    return normalized or fallback


def _social_metadata(album, route_kind):
    media_domain = os.environ.get("CLOUDFRONT_DOMAIN", "").strip().removeprefix("https://").rstrip("/")
    hero_url = HERO_IMAGE_URL.format(media_domain)
    generic = {
        "title": SITE_TITLE,
        "description": SITE_DESCRIPTION,
        "url": SITE_ORIGIN + "/",
        "image": hero_url,
        "image_alt": "Ian Truong Photography portfolio cover",
        "image_dimensions": (1280, 853),
    }
    if route_kind not in {"album", "video"} or not album:
        return generic
    stored_type = "video" if album.get("type") == "video" else "photo"
    expected_type = "video" if route_kind == "video" else "photo"
    if stored_type != expected_type:
        return generic
    try:
        summary = serialize_album_detail(album)
    except ValidationError:
        return generic
    album_title = _safe_text(summary.get("title"), "Untitled Album", 160)
    category = _safe_text(summary.get("category"), "Photography", 80)
    fallback_description = (
        f"{category} video album by Ian Truong."
        if stored_type == "video"
        else f"{category} photography album by Ian Truong."
    )
    route_name = "video" if stored_type == "video" else "album"
    album_id = summary.get("albumId")
    cover_url = summary.get("coverThumbnailUrl") or ""
    if "/thumbnail/" not in cover_url:
        cover_url = hero_url
    return {
        "title": f"{album_title} — {SITE_TITLE}",
        "description": _safe_text(summary.get("description"), fallback_description, 240),
        "url": f"{SITE_ORIGIN}/{route_name}/{album_id}",
        "image": cover_url,
        "image_alt": f"Cover photograph for {album_title}",
        "image_dimensions": None,
    }


def _meta_tag(attribute, key, value):
    return f'<meta {attribute}="{key}" content="{html.escape(str(value), quote=True)}" />'


def _render_shell(shell, metadata):
    """Replace generic social tags with one escaped, deterministic metadata set."""
    escaped_title = html.escape(metadata["title"])
    escaped_url = html.escape(metadata["url"], quote=True)
    rendered = _SOCIAL_META_PATTERN.sub("", shell)
    rendered = _TITLE_PATTERN.sub(
        lambda _match: f"<title>{escaped_title}</title>", rendered, count=1
    )
    escaped_description = html.escape(metadata["description"], quote=True)
    rendered = _DESCRIPTION_PATTERN.sub(
        lambda _match: f'<meta name="description" content="{escaped_description}" />',
        rendered,
        count=1,
    )
    rendered = _CANONICAL_PATTERN.sub(
        lambda _match: f'<link rel="canonical" href="{escaped_url}" />', rendered, count=1
    )
    tags = [
        _meta_tag("property", "og:type", "website"),
        _meta_tag("property", "og:site_name", SITE_TITLE),
        _meta_tag("property", "og:locale", "en_US"),
        _meta_tag("property", "og:title", metadata["title"]),
        _meta_tag("property", "og:description", metadata["description"]),
        _meta_tag("property", "og:url", metadata["url"]),
        _meta_tag("property", "og:image", metadata["image"]),
        _meta_tag("property", "og:image:secure_url", metadata["image"]),
        _meta_tag("property", "og:image:type", "image/jpeg"),
        _meta_tag("property", "og:image:alt", metadata["image_alt"]),
        _meta_tag("name", "twitter:card", "summary_large_image"),
        _meta_tag("name", "twitter:title", metadata["title"]),
        _meta_tag("name", "twitter:description", metadata["description"]),
        _meta_tag("name", "twitter:image", metadata["image"]),
        _meta_tag("name", "twitter:image:alt", metadata["image_alt"]),
    ]
    if metadata["image_dimensions"]:
        width, height = metadata["image_dimensions"]
        tags.extend((
            _meta_tag("property", "og:image:width", width),
            _meta_tag("property", "og:image:height", height),
        ))
    block = "\n  " + "\n  ".join(tags) + "\n"
    return re.sub(r"</head>", block + "</head>", rendered, count=1, flags=re.IGNORECASE)


def _html_response(body):
    media_domain = os.environ.get("CLOUDFRONT_DOMAIN", "").strip().removeprefix("https://").rstrip("/")
    media_origin = f"https://{media_domain}"
    bucket = bucket_name()
    s3_origins = (
        f"https://{bucket}.s3.amazonaws.com "
        f"https://{bucket}.s3.{os.environ.get('AWS_REGION', 'us-west-2')}.amazonaws.com"
    )
    content_security_policy = (
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
        "form-action 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' data: https://fonts.gstatic.com; "
        f"img-src 'self' data: blob: {media_origin} {s3_origins}; "
        f"media-src 'self' blob: {media_origin} {s3_origins}; "
        f"connect-src 'self' https://cognito-idp.us-west-2.amazonaws.com {media_origin} "
        f"{s3_origins} https://challenges.cloudflare.com; "
        "frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; "
        "manifest-src 'self'; upgrade-insecure-requests"
    )
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, max-age=0, must-revalidate",
            "Content-Security-Policy": content_security_policy,
        },
        "body": body,
    }


def _social_preview_response(event):
    try:
        shell = _base_shell()
    except Exception as error:
        return internal_error(None, error, "load_social_preview_shell")

    params = (event or {}).get("pathParameters") or {}
    route_kind = params.get("albumType")
    album = None
    if route_kind in {"album", "video"}:
        try:
            album_id = validate_uuid(params.get("albumId"))
            candidate = table.get_item(Key={"albumId": album_id}).get("Item")
            if (
                candidate
                and candidate.get("visibility") == "public"
                and candidate.get("status", "active") == "active"
            ):
                album = candidate
        except ValidationError:
            pass
        except Exception as error:
            # Preserve direct-navigation availability without leaking provider or record details.
            logger.warning("social_preview_album_lookup_failed error_type=%s", type(error).__name__)
    metadata = _social_metadata(album, route_kind)
    return _html_response(_render_shell(shell, metadata))


from front_door import verify_front_door_request


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    path_parameters = (event or {}).get("pathParameters") or {}
    if isinstance(path_parameters, dict) and "albumType" in path_parameters:
        return _social_preview_response(event)
    route_key = ((event or {}).get("requestContext") or {}).get("routeKey", "")
    raw_path = (event or {}).get("rawPath", "")
    if route_key == "GET /public/random-photos" or raw_path.endswith("/public/random-photos"):
        try:
            return _random_photos_response(event)
        except Exception as error:
            return internal_error(context, error, "get_random_photos")
    try:
        if (event or {}).get("queryStringParameters"):
            raise ValidationError("Public album detail does not accept query parameters")
        album_id = validate_uuid(((event or {}).get("pathParameters") or {}).get("albumId"))
        album = table.get_item(Key={"albumId": album_id}).get("Item")
        # Hide the existence and state of every non-public or malformed record.
        if (
            not album
            or album.get("visibility") != "public"
            or album.get("status", "active") != "active"
        ):
            return error_response(404, "Album not found", code="not_found")
        if not album.get("images"):
            album = {**album, "images": _legacy_images(album)}
        body = {
            "album": serialize_album_detail(album),
            "images": serialize_images(album),
        }
        return json_response(
            200,
            body,
            cache_control="public, max-age=60, s-maxage=300, stale-while-revalidate=60",
        )
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_request")
    except Exception as error:
        return internal_error(context, error, "get_public_album")
