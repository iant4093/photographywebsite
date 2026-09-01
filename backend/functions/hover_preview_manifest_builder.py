"""Materialize bounded, immutable hover-preview manifests for public albums."""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import logging
import os
import urllib.parse

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from album_media_store import MEDIA_STORE_VERSION, query_album_media
from cache_invalidation import request_public_api_invalidation
from media_access import (
    HOVER_PREVIEW_MANIFEST_VERSION,
    bucket_name,
    hover_preview_manifest_key,
    load_preview_metadata,
    media_id_for_key,
    public_preview_key,
    public_url,
    validated_hover_preview_manifest_key,
    validated_preview_keys,
    validate_album_media_key,
)
from validation_helpers import ValidationError, validate_uuid


logger = logging.getLogger("photography_api.hover_preview_manifest")
dynamodb = boto3.resource("dynamodb")
albums_table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
preview_table = dynamodb.Table(os.environ["PREVIEW_METADATA_TABLE"])
s3 = boto3.client("s3")

MANIFEST_LIMIT = 12
RECONCILIATION_PARTITION = "__SYSTEM__"
RECONCILIATION_ID = "hover-preview-reconciliation-v1"
RECONCILIATION_INTERVAL_SECONDS = 24 * 60 * 60
RECONCILIATION_PAGE_LIMIT = 20


def _active_public_photo(album):
    return bool(
        isinstance(album, dict)
        and album.get("visibility") == "public"
        and album.get("status", "active") == "active"
        and album.get("type", "photo") == "photo"
    )


def _raw_key(image):
    return (image.get("rawKey") or image.get("key")) if isinstance(image, dict) else ""


def _comparable_key(value):
    if not isinstance(value, str) or not value:
        return ""
    if value.startswith("https://"):
        return urllib.parse.unquote(urllib.parse.urlsplit(value).path).lstrip("/")
    return value


def _load_album(album_id):
    names = {"#status": "status", "#type": "type"}
    projection = (
        "albumId,visibility,#status,#type,coverImageUrl,coverThumbKey,"
        "legacyS3Prefix,mediaStoreVersion,imageCount,hoverPreviewStatus,"
        "hoverPreviewVersion,hoverPreviewManifestKey"
    )
    album = albums_table.get_item(
        Key={"albumId": album_id},
        ConsistentRead=True,
        ProjectionExpression=projection,
        ExpressionAttributeNames=names,
    ).get("Item")
    if not album:
        return None
    if album.get("mediaStoreVersion") != MEDIA_STORE_VERSION:
        legacy = albums_table.get_item(
            Key={"albumId": album_id},
            ConsistentRead=True,
            ProjectionExpression="albumId,images",
        ).get("Item", {})
        album["images"] = legacy.get("images", [])
    return album


def _normalized_images(album_id):
    items = []
    cursor = None
    while True:
        page, cursor = query_album_media(album_id, 100, cursor)
        items.extend(page)
        if not cursor:
            return items


def _album_images(album):
    if album.get("mediaStoreVersion") == MEDIA_STORE_VERSION:
        return _normalized_images(album["albumId"])
    images = album.get("images")
    return images if isinstance(images, list) else []


def _dimension(metadata, name):
    dimensions = metadata.get("dimensions") if isinstance(metadata, dict) else None
    value = dimensions.get(name) if isinstance(dimensions, dict) else None
    if not isinstance(value, dict):
        return None
    try:
        width = int(value.get("width"))
        height = int(value.get("height"))
    except (TypeError, ValueError):
        return None
    return (width, height) if width > 0 and height > 0 else None


def build_hover_manifest(album, images, metadata_by_id):
    """Return a deterministic manifest or an explicit unavailable result."""
    if not _active_public_photo(album):
        return None
    album_id = validate_uuid(album.get("albumId"))
    cover_paths = {
        _comparable_key(value)
        for value in (album.get("coverImageUrl"), album.get("coverThumbKey"))
        if _comparable_key(value)
    }
    candidates = []
    seen = set()
    for image in images if isinstance(images, list) else []:
        try:
            raw_key = validate_album_media_key(_raw_key(image), album=album)
            media_id = media_id_for_key(raw_key)
            metadata = metadata_by_id.get(media_id, {})
            preview_keys = validated_preview_keys(image, album, metadata)
            dimensions = _dimension(metadata, "640")
            if not dimensions or dimensions[0] != 640 or dimensions[0] <= dimensions[1]:
                continue
            thumb_key = image.get("thumbKey", "") if isinstance(image, dict) else ""
            if cover_paths.intersection({_comparable_key(raw_key), _comparable_key(thumb_key)}):
                continue
            preview_key = preview_keys.get("640")
            if not preview_key or preview_key in seen:
                continue
            seen.add(preview_key)
            candidates.append({
                "rank": hashlib.sha256(
                    f"hover-v1\0{album_id}\0{media_id}".encode("utf-8")
                ).hexdigest(),
                "url": public_url(public_preview_key(album_id, preview_key)),
                "width": dimensions[0],
                "height": dimensions[1],
            })
        except (TypeError, ValidationError):
            continue

    selected = [
        {key: item[key] for key in ("url", "width", "height")}
        for item in sorted(candidates, key=lambda item: item["rank"])[:MANIFEST_LIMIT]
    ]
    if len(selected) < 2:
        return {"status": "unavailable", "images": []}

    content = {
        "schemaVersion": HOVER_PREVIEW_MANIFEST_VERSION,
        "albumId": album_id,
        "images": selected,
    }
    encoded = json.dumps(content, separators=(",", ":"), sort_keys=True).encode("utf-8")
    version = hashlib.sha256(encoded).hexdigest()[:24]
    return {
        **content,
        "status": "ready",
        "version": version,
        "manifestKey": hover_preview_manifest_key(album_id, version),
    }


def _manifest_bytes(manifest):
    public_manifest = {
        key: manifest[key]
        for key in ("schemaVersion", "albumId", "version", "images")
    }
    return json.dumps(public_manifest, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _is_precondition_failure(error):
    return (
        isinstance(error, ClientError)
        and error.response.get("Error", {}).get("Code") in {"PreconditionFailed", "412"}
    )


def _publish_manifest(manifest):
    body = _manifest_bytes(manifest)
    checksum = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
    try:
        s3.put_object(
            Bucket=bucket_name(),
            Key=manifest["manifestKey"],
            Body=body,
            ContentType="application/json",
            CacheControl="public, max-age=31536000, immutable",
            ServerSideEncryption="AES256",
            Tagging="artifact=hover-preview-manifest&visibility=public",
            Metadata={
                "album-id": manifest["albumId"],
                "manifest-version": manifest["version"],
                "schema-version": str(HOVER_PREVIEW_MANIFEST_VERSION),
            },
            ChecksumAlgorithm="SHA256",
            ChecksumSHA256=checksum,
            IfNoneMatch="*",
        )
        return True
    except ClientError as error:
        if not _is_precondition_failure(error):
            raise
    head = s3.head_object(
        Bucket=bucket_name(),
        Key=manifest["manifestKey"],
        ChecksumMode="ENABLED",
    )
    tag_set = s3.get_object_tagging(
        Bucket=bucket_name(),
        Key=manifest["manifestKey"],
    ).get("TagSet", [])
    tags = {
        item.get("Key"): item.get("Value")
        for item in tag_set
        if isinstance(item, dict) and item.get("Key")
    }
    metadata = head.get("Metadata", {})
    if (
        head.get("ContentType") != "application/json"
        or head.get("CacheControl") != "public, max-age=31536000, immutable"
        or int(head.get("ContentLength", -1)) != len(body)
        or head.get("ChecksumSHA256") != checksum
        or metadata.get("album-id") != manifest["albumId"]
        or metadata.get("manifest-version") != manifest["version"]
        or metadata.get("schema-version") != str(HOVER_PREVIEW_MANIFEST_VERSION)
        or tags.get("artifact") != "hover-preview-manifest"
        or tags.get("visibility") != "public"
    ):
        raise RuntimeError("Existing hover manifest conflicts with the immutable contract")
    return False


def _pointer_condition(album):
    names = {"#status": "status", "#type": "type", "#visibility": "visibility"}
    values = {":active": "active", ":photo": "photo", ":public": "public"}
    condition_parts = [
        "#visibility = :public",
        "(attribute_not_exists(#status) OR #status = :active)",
        "(attribute_not_exists(#type) OR #type = :photo)",
    ]
    for field, token in (("coverImageUrl", ":cover"), ("coverThumbKey", ":cover_thumb")):
        if field in album:
            values[token] = album.get(field, "")
            condition_parts.append(f"{field} = {token}")
        else:
            condition_parts.append(f"attribute_not_exists({field})")
    if "imageCount" in album:
        values[":count"] = int(album.get("imageCount", 0))
        condition_parts.append("imageCount = :count")
    else:
        condition_parts.append("attribute_not_exists(imageCount)")
    return " AND ".join(condition_parts), names, values


def _commit_unavailable(album):
    already_unavailable = (
        album.get("hoverPreviewStatus") == "unavailable"
        and not album.get("hoverPreviewManifestKey")
        and not album.get("hoverPreviewVersion")
    )
    if already_unavailable:
        return "unchanged"
    condition, names, values = _pointer_condition(album)
    values[":unavailable"] = "unavailable"
    albums_table.update_item(
        Key={"albumId": album["albumId"]},
        UpdateExpression=(
            "SET hoverPreviewStatus = :unavailable "
            "REMOVE hoverPreviewManifestKey, hoverPreviewVersion"
        ),
        ConditionExpression=condition,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    request_public_api_invalidation(catalog=True, reason="hover-preview-unavailable")
    return "unavailable"


def rebuild_album_manifest(album_id):
    album_id = validate_uuid(album_id)
    album = _load_album(album_id)
    if not album or not _active_public_photo(album):
        return {"albumId": album_id, "status": "ignored"}
    images = _album_images(album)
    metadata = load_preview_metadata({**album, "images": images}, images, strict=True)
    manifest = build_hover_manifest(album, images, metadata)
    if manifest["status"] == "unavailable":
        status = _commit_unavailable(album)
        logger.info("hover_preview_manifest_%s", status)
        return {"albumId": album_id, "status": status, "imageCount": 0}

    _publish_manifest(manifest)
    current_key = validated_hover_preview_manifest_key(album)
    if (
        album.get("hoverPreviewStatus") == "ready"
        and album.get("hoverPreviewVersion") == manifest["version"]
        and current_key == manifest["manifestKey"]
    ):
        logger.info("hover_preview_manifest_unchanged")
        return {
            "albumId": album_id,
            "status": "unchanged",
            "imageCount": len(manifest["images"]),
        }

    condition, names, values = _pointer_condition(album)
    values.update({
        ":ready": "ready",
        ":version": manifest["version"],
        ":manifest": manifest["manifestKey"],
    })
    albums_table.update_item(
        Key={"albumId": album_id},
        UpdateExpression=(
            "SET hoverPreviewStatus = :ready, hoverPreviewVersion = :version, "
            "hoverPreviewManifestKey = :manifest"
        ),
        ConditionExpression=condition,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    request_public_api_invalidation(catalog=True, reason="hover-preview-published")
    logger.info("hover_preview_manifest_published image_count=%d", len(manifest["images"]))
    return {
        "albumId": album_id,
        "status": "published",
        "imageCount": len(manifest["images"]),
    }


def _record_album_id(record):
    if record.get("eventSource") == "aws:sqs":
        payload = json.loads(record.get("body", ""))
        if payload.get("version") != 1:
            raise ValidationError("Unsupported hover preview refresh message")
        return validate_uuid(payload.get("albumId"))
    if record.get("eventSource") == "aws:dynamodb":
        value = (((record.get("dynamodb") or {}).get("Keys") or {}).get("albumId") or {}).get("S")
        try:
            return validate_uuid(value)
        except ValidationError:
            return None
    raise ValidationError("Unsupported hover preview builder event")


def _query_reconciliation_page(cursor, limit=RECONCILIATION_PAGE_LIMIT):
    public_filter = (
        (Attr("status").not_exists() | Attr("status").eq("active"))
        & (Attr("type").not_exists() | Attr("type").eq("photo"))
    )
    query = {
        "IndexName": os.environ["PUBLIC_SUMMARY_INDEX"],
        "KeyConditionExpression": Key("visibility").eq("public"),
        "FilterExpression": public_filter,
        "ProjectionExpression": "albumId,visibility",
        "Limit": max(1, min(RECONCILIATION_PAGE_LIMIT, int(limit))),
        "ScanIndexForward": False,
    }
    if isinstance(cursor, dict):
        query["ExclusiveStartKey"] = cursor
    try:
        return albums_table.query(**query)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") not in {
            "ResourceNotFoundException",
            "ValidationException",
        }:
            raise
    scan = {
        "FilterExpression": Attr("visibility").eq("public") & public_filter,
        "ProjectionExpression": "albumId,visibility",
        "Limit": RECONCILIATION_PAGE_LIMIT,
    }
    if isinstance(cursor, dict) and set(cursor) == {"albumId"}:
        scan["ExclusiveStartKey"] = cursor
    return albums_table.scan(**scan)


def _reconciliation_page(now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    now_epoch = int(now.timestamp())
    state_key = {"albumId": RECONCILIATION_PARTITION, "mediaId": RECONCILIATION_ID}
    state = preview_table.get_item(Key=state_key, ConsistentRead=True).get("Item", {})
    if state.get("status") == "complete" and int(state.get("nextRunAt", 0)) > now_epoch:
        return {"status": "idle", "processed": 0, "failed": 0}

    processed = 0
    retries = []
    pending_retries = []
    stored_retries = state.get("retryAlbumIds", [])
    for value in stored_retries if isinstance(stored_retries, list) else []:
        try:
            album_id = validate_uuid(value)
        except ValidationError:
            continue
        if album_id not in pending_retries:
            pending_retries.append(album_id)

    attempted_retries = pending_retries[:RECONCILIATION_PAGE_LIMIT]
    retries.extend(pending_retries[RECONCILIATION_PAGE_LIMIT:])
    for album_id in attempted_retries:
        try:
            rebuild_album_manifest(album_id)
            processed += 1
        except Exception as error:
            logger.error("hover_preview_manifest_failed error_type=%s", type(error).__name__)
            retries.append(album_id)

    continuing_cycle = state.get("status") == "running"
    scan_complete = continuing_cycle and state.get("scanComplete") is True
    next_cursor = state.get("lastEvaluatedKey") if continuing_cycle else None
    remaining_capacity = RECONCILIATION_PAGE_LIMIT - len(attempted_retries)
    if not scan_complete and remaining_capacity > 0:
        response = _query_reconciliation_page(
            next_cursor,
            remaining_capacity,
        )
        for item in response.get("Items", []):
            album_id = item.get("albumId")
            try:
                rebuild_album_manifest(album_id)
                processed += 1
            except Exception as error:
                logger.error("hover_preview_manifest_failed error_type=%s", type(error).__name__)
                if isinstance(album_id, str):
                    retries.append(album_id)
        next_cursor = response.get("LastEvaluatedKey")
        scan_complete = not next_cursor

    complete = scan_complete and not retries
    state_item = {
        **state_key,
        "recordType": "migrationState",
        "schemaVersion": HOVER_PREVIEW_MANIFEST_VERSION,
        "status": "complete" if complete else "running",
        "scanComplete": scan_complete,
        "processedInLastRun": processed,
    }
    if next_cursor:
        state_item["lastEvaluatedKey"] = next_cursor
    if complete:
        state_item["nextRunAt"] = now_epoch + RECONCILIATION_INTERVAL_SECONDS
    if retries:
        state_item["retryAlbumIds"] = sorted(set(retries))[:100]
    preview_table.put_item(Item=state_item)
    return {
        "status": state_item["status"],
        "processed": processed,
        "failed": len(retries),
    }


def handler(event, _context):
    records = (event or {}).get("Records")
    if not isinstance(records, list):
        return _reconciliation_page()

    by_album = {}
    failures = []
    for record in records:
        identifier = record.get("messageId") or record.get("eventID")
        try:
            album_id = _record_album_id(record)
            if album_id:
                by_album.setdefault(album_id, []).append(identifier)
        except Exception as error:
            logger.error("hover_preview_manifest_failed error_type=%s", type(error).__name__)
            if identifier:
                failures.append({"itemIdentifier": identifier})

    for album_id, identifiers in by_album.items():
        try:
            rebuild_album_manifest(album_id)
        except Exception as error:
            logger.error("hover_preview_manifest_failed error_type=%s", type(error).__name__)
            failures.extend(
                {"itemIdentifier": identifier}
                for identifier in identifiers
                if identifier
            )
    return {"batchItemFailures": failures}
