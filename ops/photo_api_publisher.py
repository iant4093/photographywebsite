"""Build immutable public catalog objects before advancing the edge selector."""

import base64
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import secrets
import time
from urllib.parse import quote

import boto3
from boto3.dynamodb.types import TypeDeserializer
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

SELECTOR = Path(__file__).with_name("photo_api_selector.js")
STATE_KEY = "state/catalog.json"
SIGNING_KEY = "state/signing-key"
CACHE_CONTROL = "public, max-age=0, s-maxage=86400"
MAX_FUNCTION_BYTES = 10 * 1024
MAX_ALBUMS = 250
MAX_PHOTOS = 10_000
MAX_PAGES = 20
LIST_PAGE_SIZE = 200
CATALOG_FORMAT_VERSION = "preview-v3"
PREVIEW_VERSION = 3
PREVIEW_WIDTHS = ("640", "960", "1440", "1920")
HEARTBEAT_SECONDS = 3600
EXPIRY_SECONDS = 3 * 3600
ROTATION_SECONDS = 14 * 86400
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
ALBUM_ID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
LEGACY_PREFIX = re.compile(r"albums/[a-z0-9](?:[a-z0-9._-]{0,198}[a-z0-9])?/")
IMAGE_TYPE = re.compile(r"\.(?:jpe?g|png|webp)$", re.IGNORECASE)
UNSAFE_SEGMENT = re.compile(r"[\\\x00-\x1f\x7f]")
MISSING = {"403", "404", "AccessDenied", "NoSuchKey", "NotFound"}
CLIENT_CONFIG = Config(connect_timeout=3, read_timeout=12, max_pool_connections=32,
                       retries={"mode": "standard", "total_max_attempts": 3})
logger = logging.getLogger(__name__)


def encoded(data):
    return json.dumps(data, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode()


def digest(data):
    return base64.urlsafe_b64encode(hashlib.sha256(encoded(data)).digest()[:12]).decode()


def deserialize(row):
    deserializer = TypeDeserializer()
    return {key: deserializer.deserialize(value) for key, value in row.items()}


def query_items(ddb, **query):
    for _ in range(MAX_PAGES):
        result = ddb.query(**query)
        yield from map(deserialize, result["Items"])
        cursor = result.get("LastEvaluatedKey")
        if not cursor:
            return
        query["ExclusiveStartKey"] = cursor
    raise RuntimeError("Catalog query exceeds its page limit")


def public_album(album):
    return (
        album.get("visibility") == "public"
        and album.get("status", "active") == "active"
        and album.get("type", "photo") == "photo"
        and not album.get("pendingVisibilityChange")
    )


def dimensions(image, field):
    value = image.get(field)
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    return int(value) if 0 < value <= 100_000 and int(value) == value else None


def eligible_images(album, images):
    prefix = f"albums/{album['albumId']}/"
    legacy = album.get("legacyS3Prefix")
    prefixes = (prefix, legacy) if isinstance(legacy, str) and LEGACY_PREFIX.fullmatch(legacy) else (prefix,)
    result = {}
    for image in images:
        if not isinstance(image, dict):
            continue
        key = image.get("rawKey") or image.get("key")
        if (not isinstance(key, str) or not key.startswith(prefixes) or
                len(key.encode()) > 1024 or not IMAGE_TYPE.search(key) or
                any(part in {"", ".", ".."} or UNSAFE_SEGMENT.search(part) for part in key.split("/"))):
            continue
        result[key] = [key, image.get("isFavorite") is True, dimensions(image, "width"), dimensions(image, "height")]
    return [result[key] for key in sorted(result)]


def preview_descriptors(ddb, table, album_id, images):
    if not images:
        return {}
    try:
        rows = {
            row["mediaId"]: row for row in query_items(
                ddb, TableName=table, KeyConditionExpression="albumId = :album",
                ExpressionAttributeValues={":album": {"S": album_id}},
                ProjectionExpression="mediaId,#status,previewVersion,previewKeys,dimensions,sourceSha256",
                ExpressionAttributeNames={"#status": "status"},
            )
        }
    except (BotoCoreError, ClientError, RuntimeError) as error:
        logger.warning("photo_api_preview_metadata_unavailable error_type=%s", type(error).__name__)
        return {}

    descriptors = {}
    for key, *_ in images:
        media_id = photo_id(key)
        row = rows.get(media_id)
        if not row or row.get("status") != "ready" or row.get("previewVersion") != PREVIEW_VERSION:
            continue
        preview_keys = row.get("previewKeys")
        sizes = row.get("dimensions")
        source_hash = row.get("sourceSha256")
        if (not isinstance(preview_keys, dict) or not isinstance(sizes, dict) or
                not isinstance(source_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", source_hash)):
            continue
        for width in PREVIEW_WIDTHS:
            expected = f"albums/{album_id}/preview/v{PREVIEW_VERSION}/{media_id}-w{width}.webp"
            size = sizes.get(width)
            if (preview_keys.get(width) != expected or not isinstance(size, dict) or
                    dimensions(size, "width") != int(width)):
                continue
            height = dimensions(size, "height")
            if height:
                descriptors.setdefault(media_id, {})[width] = [expected, height, source_hash]
    return descriptors


def load_album(ddb, albums, media, previews, album_id):
    album = deserialize(ddb.get_item(TableName=albums, Key={"albumId": {"S": album_id}},
                                     ConsistentRead=True).get("Item", {}))
    slug = album.get("slug")
    if not public_album(album) or not isinstance(slug, str) or len(slug) > 60 or not SLUG.fullmatch(slug):
        return None
    images = album.get("images") or []
    if album.get("mediaStoreVersion") == 1:
        images = query_items(ddb, TableName=media, KeyConditionExpression="albumId = :album",
                             ExpressionAttributeValues={":album": {"S": album_id}}, ConsistentRead=True)
    eligible = eligible_images(album, images)
    return slug, eligible, preview_descriptors(ddb, previews, album_id, eligible)


def read_private(s3, bucket, key):
    try:
        with s3.get_object(Bucket=bucket, Key=key)["Body"] as body:
            return body.read()
    except ClientError as error:
        # The publisher can list the exact state key prefix, so absence is a 404.
        if error.response["Error"]["Code"] in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise


def signing_key(s3, bucket):
    current = read_private(s3, bucket, SIGNING_KEY)
    if current is None:
        current = secrets.token_hex(32).encode()
        s3.put_object(Bucket=bucket, Key=SIGNING_KEY, Body=current, IfNoneMatch="*")
    if not re.fullmatch(rb"[a-f0-9]{64}", current):
        raise RuntimeError("Photo API signing key is invalid")
    return current


def photo_id(key):
    return hashlib.sha256(key.encode()).hexdigest()[:24]


def image_url(domain, secret, key):
    key_token = base64.urlsafe_b64encode(key.encode()).rstrip(b"=")
    signature = hmac.new(secret, key_token, hashlib.sha256).hexdigest()
    return f"https://{domain}/v1/images/{signature}/{key_token.decode()}"


def head_image(s3, bucket, key):
    try:
        return s3.head_object(Bucket=bucket, Key=key)
    except ClientError as error:
        if error.response["Error"]["Code"] in MISSING:
            return {}
        raise


def build_photo(s3, bucket, domain, secret, slug, image):
    key, featured, width, height = image
    metadata = head_image(s3, bucket, key)
    if metadata.get("ContentType", "").split(";", 1)[0] not in {"image/jpeg", "image/png", "image/webp"}:
        return None
    if metadata.get("ContentLength", 0) <= 0:
        return None
    return {
        "id": photo_id(key),
        "albumSlug": slug,
        "albumUrl": "https://iantruongphotography.com/album/" + quote(slug),
        "imageUrl": image_url(domain, secret, key),
        "width": width,
        "height": height,
        "bytes": metadata["ContentLength"],
        "featured": featured,
        "fallbackUsed": False,
    }


def build_preview(s3, bucket, domain, secret, photo, width, descriptor):
    key, height, source_hash = descriptor
    try:
        metadata = head_image(s3, bucket, key)
    except (BotoCoreError, ClientError) as error:
        logger.warning("photo_api_preview_object_unavailable error_type=%s", type(error).__name__)
        return None, True
    length = metadata.get("ContentLength", 0)
    if (metadata.get("ContentType") != "image/webp" or length <= 0 or
            metadata.get("Metadata", {}).get("source-sha256") != source_hash):
        return None, True
    if length >= photo["bytes"]:
        return None, False
    return {**photo, "imageUrl": image_url(domain, secret, key),
            "width": int(width), "height": height, "bytes": length}, False


def catalog_objects(version, photos, prefix=""):
    featured = [photo for photo in photos if photo["featured"]]
    pools = {"all": photos}
    if featured:
        pools["featured"] = featured
    else:
        pools["fallback"] = [{**photo, "fallbackUsed": True} for photo in photos]
    for name, pool in pools.items():
        for index, photo in enumerate(pool):
            yield f"catalog/{version}/{prefix}{name}/{index}.json", encoded(photo)


def list_objects(version, photos, include_fallback=True, page_size=LIST_PAGE_SIZE, prefix=""):
    featured = [photo for photo in photos if photo["featured"]]
    pools = []
    if photos:
        pools.append(("all", photos, False))
    if featured:
        pools.append(("featured", featured, False))
    elif include_fallback and photos:
        pools.append(("fallback", [{**photo, "fallbackUsed": True} for photo in photos], True))
    for name, pool, fallback_used in pools:
        total_pages = (len(pool) + page_size - 1) // page_size
        for page in range(total_pages):
            chunk = pool[page * page_size:(page + 1) * page_size]
            next_cursor = str(page + 1) if page + 1 < total_pages else None
            body = encoded({
                "items": chunk,
                "fallbackUsed": fallback_used,
                "nextCursor": next_cursor,
            })
            yield f"catalog/{version}/{prefix}{name}/page-{page}.json", body


def pool_counts(photos):
    return [len(photos), sum(photo["featured"] for photo in photos)]


def pool_info(version, photos, previews):
    originals = pool_counts(photos)
    tiers = []
    for width in PREVIEW_WIDTHS:
        counts = pool_counts(previews[width])
        # Each tier is empty, shares the original counts, or has its own all:featured counts.
        if not counts[0]:
            tiers.append("")
        elif counts == originals:
            tiers.append("*")
        else:
            tiers.append(f"{counts[0]}:{counts[1]}")
    info = [version, *originals]
    if any(tiers):
        info.append(",".join(tiers))
    return info


def compact_selector(source):
    lines = []
    for raw_line in source.splitlines():
        line = raw_line.strip()
        if not line or line.startswith((b"//", b"/*")):
            continue
        lines.append(line)
    return b"\n".join(lines)


def selector_code(albums, secret, expires, global_pool=None):
    source = compact_selector(SELECTOR.read_bytes())
    marker = rb"\bsnapshot\s*=\s*null\b"
    if len(re.findall(marker, source)) != 1:
        raise RuntimeError("Edge selector snapshot marker is missing")
    payload = {"albums": albums, "signingKey": secret.decode(), "expires": expires * 1000}
    if global_pool is not None:
        payload["global"] = global_pool
    snapshot = encoded(payload)
    code = re.sub(marker, lambda _: b"snapshot=" + snapshot, source)
    if len(code) > MAX_FUNCTION_BYTES:
        raise RuntimeError("Edge selector exceeds the CloudFront Functions code limit")
    return code


def publish_selector(cloudfront, function, code):
    current = cloudfront.describe_function(Name=function, Stage="DEVELOPMENT")
    config = current["FunctionSummary"]["FunctionConfig"]
    update = cloudfront.update_function(Name=function, IfMatch=current["ETag"],
                                        FunctionConfig=config, FunctionCode=code)
    cloudfront.publish_function(Name=function, IfMatch=update["ETag"])


def write_catalog(s3, bucket, pool, version, objects):
    # A timed-out run may have written part of this immutable version before it reached the selector.
    pages = s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=f"catalog/{version}/")
    existing = {entry["Key"] for page in pages for entry in page.get("Contents", [])}

    def write_object(item):
        key, body = item
        s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/json",
                      CacheControl=CACHE_CONTROL)

    list(pool.map(write_object, (item for item in objects if item[0] not in existing)))


def handler(_event, _context):
    started = int(time.time())
    region = os.environ["IMAGES_REGION"]
    s3 = boto3.client("s3", config=CLIENT_CONFIG)
    image_s3 = boto3.client("s3", region_name=region, config=CLIENT_CONFIG)
    ddb = boto3.client("dynamodb", region_name=region, config=CLIENT_CONFIG)
    albums = os.environ["ALBUMS_TABLE"]
    media = os.environ["ALBUM_MEDIA_TABLE"]
    preview_table = os.environ["PREVIEW_METADATA_TABLE"]
    bucket = os.environ["CATALOG_BUCKET"]
    images_bucket = os.environ["IMAGES_BUCKET"]
    domain = os.environ["PHOTO_API_DOMAIN"]
    secret = signing_key(s3, bucket)
    signing_key_id = hashlib.sha256(secret).hexdigest()[:16]
    state = json.loads(read_private(s3, bucket, STATE_KEY) or "{}")
    previous = state.get("albums", {})
    index = {}
    photos_written = 0
    album_ids = sorted({
        row["albumId"] for row in query_items(
            ddb, TableName=albums, IndexName="VisibilityCreatedAtIndex",
            KeyConditionExpression="visibility = :public",
            ExpressionAttributeValues={":public": {"S": "public"}},
            ProjectionExpression="albumId",
        ) if ALBUM_ID.fullmatch(row["albumId"])
    })
    if len(album_ids) > MAX_ALBUMS:
        raise RuntimeError("Public catalog exceeds its album limit")

    with ThreadPoolExecutor(max_workers=24) as pool:
        records = [entry for entry in pool.map(
            lambda aid: load_album(ddb, albums, media, preview_table, aid), album_ids
        ) if entry]
        if sum(len(images) for _, images, _ in records) > MAX_PHOTOS:
            raise RuntimeError("Public catalog exceeds its photo limit")
        for slug, images, descriptors in records:
            if slug in index:
                raise RuntimeError("Public catalog has duplicate album slugs")
            source = digest([CATALOG_FORMAT_VERSION, slug, domain, signing_key_id,
                             started // ROTATION_SECONDS, images, descriptors])
            old = previous.get(slug, {})
            if old.get("source") == source and old.get("retryAfter", 0) > started and isinstance(old.get("photos"), list):
                index[slug] = old
                continue

            photos = [photo for photo in pool.map(
                lambda image: build_photo(image_s3, images_bucket, domain, secret, slug, image), images
            ) if photo]
            preview_candidates = [
                (photo, width, descriptor) for photo in photos
                for width, descriptor in descriptors.get(photo["id"], {}).items()
            ]
            previews = {width: [] for width in PREVIEW_WIDTHS}
            previews_complete = True
            for preview, retry in pool.map(
                lambda candidate: build_preview(image_s3, images_bucket, domain, secret, *candidate),
                preview_candidates,
            ):
                if preview:
                    previews[str(preview["width"])].append(preview)
                if retry:
                    previews_complete = False
            version = digest([source, photos, previews])
            if old.get("pool", [None])[0] != version:
                album_objects = list(catalog_objects(version, photos)) + list(list_objects(version, photos))
                for width, tier in previews.items():
                    prefix = f"webp/{width}/"
                    album_objects.extend(catalog_objects(version, tier, prefix=prefix))
                    album_objects.extend(list_objects(version, tier, prefix=prefix))
                write_catalog(s3, bucket, pool, version, album_objects)
                photos_written += len(photos)
            complete = len(photos) == len(images) and previews_complete
            index[slug] = {
                "source": source,
                "pool": pool_info(version, photos, previews),
                "photos": photos,
                "previews": previews,
                "retryAfter": started + (ROTATION_SECONDS if complete else HEARTBEAT_SECONDS),
            }
        all_photos = [photo for slug in sorted(index) for photo in index[slug]["photos"]]
        all_previews = {
            width: [photo for slug in sorted(index) for photo in index[slug]["previews"][width]]
            for width in PREVIEW_WIDTHS
        }
        global_version = digest([CATALOG_FORMAT_VERSION, started // ROTATION_SECONDS, all_photos, all_previews])
        global_pool = pool_info(global_version, all_photos, all_previews)
        if all_photos and state.get("global", [None])[0] != global_version:
            global_objects = list(list_objects(global_version, all_photos, include_fallback=False))
            for width, tier in all_previews.items():
                global_objects.extend(list_objects(global_version, tier, include_fallback=False, prefix=f"webp/{width}/"))
            write_catalog(s3, bucket, pool, global_version, global_objects)
    published = {slug: entry["pool"] for slug, entry in index.items() if entry["pool"][1]}
    previous_pools = {slug: entry["pool"] for slug, entry in previous.items() if entry["pool"][1]}
    selector_digest = hashlib.sha256(SELECTOR.read_bytes()).hexdigest()
    publish = (published != previous_pools or global_pool != state.get("global")
               or state.get("publishedAt", 0) + HEARTBEAT_SECONDS <= started
               or state.get("selectorDigest") != selector_digest)
    if publish:
        code = selector_code(published, secret, started + EXPIRY_SECONDS, global_pool=global_pool)
        publish_selector(boto3.client("cloudfront", config=CLIENT_CONFIG), os.environ["SELECTOR_NAME"], code)
    if publish or index != previous:
        s3.put_object(Bucket=bucket, Key=STATE_KEY, ContentType="application/json", Body=encoded({
            "albums": index,
            "global": global_pool,
            "publishedAt": started if publish else state["publishedAt"],
            "selectorDigest": selector_digest,
        }))
    return {
        "albums": len(published),
        "photos": sum(album[1] for album in published.values()),
        "featured": sum(album[2] for album in published.values()),
        "photosWritten": photos_written,
        "published": publish,
    }
