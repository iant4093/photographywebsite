"""Compatibility-safe normalized album media storage.

The legacy `images` manifest remains the rollback source while this table is
backfilled. An album opts into normalized reads only after every row has been
written and `mediaStoreVersion` is committed on the album record.
"""

from __future__ import annotations

import logging
import os
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer

from media_access import media_id_for_key


logger = logging.getLogger("photography_api.album_media_store")
MEDIA_STORE_VERSION = 1
ORDER_INDEX = "AlbumOrderIndex"
SYSTEM_ALBUM_ID = "__SYSTEM__"
BACKFILL_MEDIA_ID = "album-media-backfill-v1"
MEDIA_FIELDS = frozenset({
    "rawKey",
    "thumbKey",
    "hlsUrl",
    "blurhash",
    "width",
    "height",
    "exif",
    "thumbnailTime",
    "mediaConvertJobId",
    "originalFilename",
    "altText",
    "isFavorite",
    "captionVtt",
    "captionLanguage",
    "transcript",
    "scrubFrames",
})


def _table():
    name = os.environ.get("ALBUM_MEDIA_TABLE", "").strip()
    return boto3.resource("dynamodb").Table(name) if name else None


def normalized_media_item(album_id, image, index):
    source = image if isinstance(image, dict) else {"rawKey": image}
    raw_key = source.get("rawKey") or source.get("key") or ""
    media_id = media_id_for_key(raw_key)
    item = {
        "albumId": album_id,
        "mediaId": media_id,
        "orderKey": f"{max(0, int(index)):012d}#{media_id}",
        "recordType": "albumMedia",
        "schemaVersion": MEDIA_STORE_VERSION,
        "rawKey": raw_key,
    }
    for field in MEDIA_FIELDS - {"rawKey"}:
        if field in source:
            item[field] = source[field]
    return item


def _comparison_value(value):
    """Compare serialized values with BOOL distinct from N; ignore numeric scale."""
    kind, data = next(iter(value.items()))
    if kind == "N":
        data = Decimal(data)
    elif kind == "NS":
        data = frozenset(Decimal(number) for number in data)
    elif kind in {"SS", "BS"}:
        data = frozenset(data)
    elif kind == "M":
        data = {key: _comparison_value(item) for key, item in data.items()}
    elif kind == "L":
        data = [_comparison_value(item) for item in data]
    return kind, data


def replace_album_media(album_id, images):
    table = _table()
    if table is None:
        return False
    target = {}
    for index, image in enumerate(images if isinstance(images, list) else []):
        item = normalized_media_item(album_id, image, index)
        # The legacy batch writer keeps the last occurrence of a repeated ID.
        target[item["mediaId"]] = item
    existing = {}
    cursor = None
    seen_cursors = set()
    while True:
        params = {
            "KeyConditionExpression": Key("albumId").eq(album_id),
            "ConsistentRead": True,
        }
        if cursor:
            params["ExclusiveStartKey"] = cursor
        response = table.query(**params)
        for item in response.get("Items", []):
            if item["albumId"] != album_id:
                raise RuntimeError("Media repair returned another album")
            existing[item["mediaId"]] = item
        cursor = response.get("LastEvaluatedKey")
        if not cursor:
            break
        identity = tuple(sorted(cursor.items()))
        if identity in seen_cursors:
            raise RuntimeError("Media repair cursor did not advance")
        seen_cursors.add(identity)
    serializer = TypeSerializer()
    # Validate every target even when an equivalent existing row needs no write.
    comparisons = {key: _comparison_value(serializer.serialize(item)) for key, item in target.items()}
    removals = existing.keys() - target.keys()
    replacements = [item for key, item in target.items()
                    if key not in existing or _comparison_value(serializer.serialize(existing[key])) != comparisons[key]]
    if removals or replacements:
        with table.batch_writer(overwrite_by_pkeys=["albumId", "mediaId"]) as batch:
            for media_id in sorted(removals):
                batch.delete_item(Key={"albumId": album_id, "mediaId": media_id})
            for item in replacements:
                batch.put_item(Item=item)
    return True


def append_album_media(album_id, images, start_index):
    table = _table()
    if table is None:
        return False
    with table.batch_writer(overwrite_by_pkeys=["albumId", "mediaId"]) as batch:
        for offset, image in enumerate(images if isinstance(images, list) else []):
            batch.put_item(Item=normalized_media_item(album_id, image, start_index + offset))
    return True


def delete_album_media(album_id, media_ids=None):
    table = _table()
    if table is None:
        return False
    ids = list(media_ids or [])
    if media_ids is None:
        cursor = None
        while True:
            params = {
                "KeyConditionExpression": Key("albumId").eq(album_id),
                "ProjectionExpression": "mediaId",
            }
            if cursor:
                params["ExclusiveStartKey"] = cursor
            response = table.query(**params)
            ids.extend(item["mediaId"] for item in response.get("Items", []) if item.get("mediaId"))
            cursor = response.get("LastEvaluatedKey")
            if not cursor:
                break
    if ids:
        with table.batch_writer() as batch:
            for media_id in sorted(set(ids)):
                batch.delete_item(Key={"albumId": album_id, "mediaId": media_id})
    return True


def update_album_media(album_id, media_id, fields):
    table = _table()
    if table is None:
        return False
    allowed = {key: value for key, value in fields.items() if key in MEDIA_FIELDS - {"rawKey"}}
    if not allowed:
        return True
    names = {f"#field{index}": field for index, field in enumerate(sorted(allowed))}
    values = {f":value{index}": allowed[field] for index, field in enumerate(sorted(allowed))}
    assignments = [
        f"#field{index} = :value{index}"
        for index, _field in enumerate(sorted(allowed))
    ]
    table.update_item(
        Key={"albumId": album_id, "mediaId": media_id},
        UpdateExpression="SET " + ", ".join(assignments),
        ConditionExpression="attribute_exists(albumId) AND attribute_exists(mediaId)",
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    return True


def query_album_media(album_id, limit, start_key=None):
    table = _table()
    if table is None:
        return [], None
    params = {
        "IndexName": ORDER_INDEX,
        "KeyConditionExpression": Key("albumId").eq(album_id),
        "ScanIndexForward": True,
        "Limit": limit,
    }
    if start_key:
        params["ExclusiveStartKey"] = start_key
    response = table.query(**params)
    items = [
        item
        for item in response.get("Items", [])
        if item.get("recordType") == "albumMedia" and item.get("schemaVersion") == MEDIA_STORE_VERSION
    ]
    return items, response.get("LastEvaluatedKey")


def activate_album_media(albums_table, album_id, images):
    expected_images = images if isinstance(images, list) else []
    albums_table.update_item(
        Key={"albumId": album_id},
        UpdateExpression="SET mediaStoreVersion = :version, imageCount = :count",
        ConditionExpression="attribute_exists(albumId) AND images = :images",
        ExpressionAttributeValues={
            ":version": MEDIA_STORE_VERSION,
            ":count": len(expected_images),
            ":images": expected_images,
        },
    )


def finish_media_sync(albums_table, album, images, operation):
    """Called after an atomic fallback to the authoritative album manifest."""
    if not (album.get("mediaStoreVersion") == MEDIA_STORE_VERSION or album.get("mediaStoreDirty")):
        return True
    try:
        synchronized = (replace_album_media(album["albumId"], images)
                        if album.get("mediaStoreDirty") else operation())
        if not synchronized:
            return False
        albums_table.update_item(
            Key={"albumId": album["albumId"]},
            UpdateExpression="SET mediaStoreVersion = :version REMOVE mediaStoreDirty",
            ConditionExpression="attribute_exists(albumId) AND images = :images AND attribute_not_exists(pendingVisibilityChange) AND (attribute_not_exists(#status) OR #status = :active)",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":version": MEDIA_STORE_VERSION, ":images": images, ":active": "active"},
        )
        return True
    except Exception as error:
        # The committed write already disabled normalized reads. A failed repair
        # cannot leave readers on stale data, and the durable dirty bit survives.
        logger.error("album_media_sync_pending error_type=%s", type(error).__name__)
        return False


def mutation_expression(expression, album, values):
    """Make read fallback atomic with any authoritative manifest mutation."""
    from media_mutation import enabled
    if not enabled() or not (album.get("mediaStoreVersion") == MEDIA_STORE_VERSION or album.get("mediaStoreDirty")):
        return expression
    values[":media_dirty"] = True
    if " REMOVE " in expression:
        sets, removes = expression.split(" REMOVE ", 1)
        return sets + ", mediaStoreDirty = :media_dirty REMOVE " + removes + ", mediaStoreVersion"
    return expression + ", mediaStoreDirty = :media_dirty REMOVE mediaStoreVersion"


def deactivate_album_media(albums_table, album_id):
    try:
        albums_table.update_item(
            Key={"albumId": album_id},
            UpdateExpression="REMOVE mediaStoreVersion",
            ConditionExpression="attribute_exists(albumId)",
        )
    except Exception as error:
        logger.error("album_media_deactivation_failed error_type=%s", type(error).__name__)
