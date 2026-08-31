"""Compatibility-safe normalized album media storage.

The legacy `images` manifest remains the rollback source while this table is
backfilled. An album opts into normalized reads only after every row has been
written and `mediaStoreVersion` is committed on the album record.
"""

from __future__ import annotations

import logging
import os

import boto3
from boto3.dynamodb.conditions import Key

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


def replace_album_media(album_id, images):
    table = _table()
    if table is None:
        return False
    existing = []
    cursor = None
    while True:
        params = {
            "KeyConditionExpression": Key("albumId").eq(album_id),
            "ProjectionExpression": "albumId,mediaId",
        }
        if cursor:
            params["ExclusiveStartKey"] = cursor
        response = table.query(**params)
        existing.extend(response.get("Items", []))
        cursor = response.get("LastEvaluatedKey")
        if not cursor:
            break
    with table.batch_writer(overwrite_by_pkeys=["albumId", "mediaId"]) as batch:
        for key in existing:
            batch.delete_item(Key={"albumId": key["albumId"], "mediaId": key["mediaId"]})
        for index, image in enumerate(images if isinstance(images, list) else []):
            batch.put_item(Item=normalized_media_item(album_id, image, index))
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


def deactivate_album_media(albums_table, album_id):
    try:
        albums_table.update_item(
            Key={"albumId": album_id},
            UpdateExpression="REMOVE mediaStoreVersion",
            ConditionExpression="attribute_exists(albumId)",
        )
    except Exception as error:
        logger.error("album_media_deactivation_failed error_type=%s", type(error).__name__)
