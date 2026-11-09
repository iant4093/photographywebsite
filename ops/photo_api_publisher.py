"""Build immutable public catalog objects before advancing the edge selector."""

import base64
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import time
from urllib.parse import quote

import boto3
from boto3.dynamodb.types import TypeDeserializer
from botocore.config import Config
from botocore.exceptions import ClientError

SELECTOR = Path(__file__).with_name("photo_api_selector.js")
STATE_KEY = "state/catalog.json"
SIGNING_KEY = "state/signing-key"
CACHE_CONTROL = "public, max-age=0, s-maxage=86400"
MAX_FUNCTION_BYTES = 10 * 1024
MAX_ALBUMS = 250
MAX_PHOTOS = 10_000
MAX_PAGES = 20
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


def load_album(ddb, albums, media, album_id):
    album = deserialize(ddb.get_item(TableName=albums, Key={"albumId": {"S": album_id}},
                                     ConsistentRead=True).get("Item", {}))
    slug = album.get("slug")
    if not public_album(album) or not isinstance(slug, str) or len(slug) > 60 or not SLUG.fullmatch(slug):
        return None
    images = album.get("images") or []
    if album.get("mediaStoreVersion") == 1:
        images = query_items(ddb, TableName=media, KeyConditionExpression="albumId = :album",
                             ExpressionAttributeValues={":album": {"S": album_id}}, ConsistentRead=True)
    return slug, eligible_images(album, images)


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


def build_photo(s3, bucket, domain, secret, slug, image):
    key, featured, width, height = image
    try:
        metadata = s3.head_object(Bucket=bucket, Key=key)
    except ClientError as error:
        if error.response["Error"]["Code"] in MISSING:
            return None
        raise
    if metadata.get("ContentType", "").split(";", 1)[0] not in {"image/jpeg", "image/png", "image/webp"}:
        return None
    if metadata.get("ContentLength", 0) <= 0:
        return None
    key_token = base64.urlsafe_b64encode(key.encode()).rstrip(b"=")
    signature = hmac.new(secret, key_token, hashlib.sha256).hexdigest()
    return {
        "id": hashlib.sha256(key.encode()).hexdigest()[:24],
        "albumSlug": slug,
        "albumUrl": "https://iantruongphotography.com/album/" + quote(slug),
        "imageUrl": f"https://{domain}/v1/images/{signature}/{key_token.decode()}",
        "width": width,
        "height": height,
        "bytes": metadata["ContentLength"],
        "featured": featured,
        "fallbackUsed": False,
    }


def catalog_objects(version, photos):
    featured = [photo for photo in photos if photo["featured"]]
    pools = {"all": photos}
    if featured:
        pools["featured"] = featured
    else:
        pools["fallback"] = [{**photo, "fallbackUsed": True} for photo in photos]
    for name, pool in pools.items():
        for index, photo in enumerate(pool):
            yield f"catalog/{version}/{name}/{index}.json", encoded(photo)


def selector_code(albums, secret, expires):
    source = SELECTOR.read_bytes()
    marker = b"const snapshot = null;"
    if source.count(marker) != 1:
        raise RuntimeError("Edge selector snapshot marker is missing")
    snapshot = encoded({"albums": albums, "signingKey": secret.decode(), "expires": expires * 1000})
    code = source.replace(marker, b"const snapshot = " + snapshot + b";")
    if len(code) > MAX_FUNCTION_BYTES:
        raise RuntimeError("Edge selector exceeds the CloudFront Functions code limit")
    return code


def publish_selector(cloudfront, function, code):
    current = cloudfront.describe_function(Name=function, Stage="DEVELOPMENT")
    config = current["FunctionSummary"]["FunctionConfig"]
    update = cloudfront.update_function(Name=function, IfMatch=current["ETag"],
                                        FunctionConfig=config, FunctionCode=code)
    cloudfront.publish_function(Name=function, IfMatch=update["ETag"])


def handler(_event, _context):
    started = int(time.time())
    region = os.environ["IMAGES_REGION"]
    s3 = boto3.client("s3", config=CLIENT_CONFIG)
    image_s3 = boto3.client("s3", region_name=region, config=CLIENT_CONFIG)
    ddb = boto3.client("dynamodb", region_name=region, config=CLIENT_CONFIG)
    albums = os.environ["ALBUMS_TABLE"]
    media = os.environ["ALBUM_MEDIA_TABLE"]
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
        records = [entry for entry in pool.map(lambda aid: load_album(ddb, albums, media, aid), album_ids) if entry]
        if sum(len(images) for _, images in records) > MAX_PHOTOS:
            raise RuntimeError("Public catalog exceeds its photo limit")
        for slug, images in records:
            if slug in index:
                raise RuntimeError("Public catalog has duplicate album slugs")
            source = digest([slug, domain, signing_key_id, started // ROTATION_SECONDS, images])
            old = previous.get(slug, {})
            if old.get("source") == source and old.get("retryAfter", 0) > started:
                index[slug] = old
                continue

            photos = [photo for photo in pool.map(
                lambda image: build_photo(image_s3, images_bucket, domain, secret, slug, image), images
            ) if photo]
            version = digest([source, photos])
            if old.get("pool", [None])[0] != version:
                def write_object(item):
                    key, body = item
                    s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/json",
                                  CacheControl=CACHE_CONTROL)

                list(pool.map(write_object, catalog_objects(version, photos)))
                photos_written += len(photos)
            index[slug] = {
                "source": source,
                "pool": [version, len(photos), sum(photo["featured"] for photo in photos)],
                "retryAfter": started + (ROTATION_SECONDS if len(photos) == len(images) else HEARTBEAT_SECONDS),
            }
    published = {slug: entry["pool"] for slug, entry in index.items() if entry["pool"][1]}
    previous_pools = {slug: entry["pool"] for slug, entry in previous.items() if entry["pool"][1]}
    publish = (published != previous_pools or state.get("publishedAt", 0) + HEARTBEAT_SECONDS <= started
               or state.get("selectorDigest") != hashlib.sha256(SELECTOR.read_bytes()).hexdigest())
    if publish:
        code = selector_code(published, secret, started + EXPIRY_SECONDS)
        publish_selector(boto3.client("cloudfront", config=CLIENT_CONFIG), os.environ["SELECTOR_NAME"], code)
    if publish or index != previous:
        s3.put_object(Bucket=bucket, Key=STATE_KEY, ContentType="application/json", Body=encoded({
            "albums": index,
            "publishedAt": started if publish else state["publishedAt"],
            "selectorDigest": hashlib.sha256(SELECTOR.read_bytes()).hexdigest(),
        }))
    return {
        "albums": len(published),
        "photos": sum(album[1] for album in published.values()),
        "featured": sum(album[2] for album in published.values()),
        "photosWritten": photos_written,
        "published": publish,
    }
