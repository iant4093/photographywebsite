"""Shared deterministic ZIP job helpers."""

import hashlib
import json
import os

import boto3
from boto3.dynamodb.conditions import Key


dynamodb = boto3.resource("dynamodb")


def get_album_record(album_id=None, share_code=None):
    table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
    if album_id:
        return table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
    response = table.query(
        IndexName=os.environ.get("SHARE_CODE_INDEX", "ShareCodeIndex"),
        KeyConditionExpression=Key("shareCode").eq(share_code),
        Limit=2,
    )
    items = response.get("Items", [])
    return items[0] if len(items) == 1 else None


def raw_image_keys(album):
    return [
        image.get("rawKey") or image.get("key")
        for image in album.get("images", [])
        if isinstance(image, dict) and (image.get("rawKey") or image.get("key"))
    ]


def zip_version(album):
    material = {
        "archiveFormatVersion": 2,
        "albumId": album.get("albumId"),
        "type": album.get("type", "photo"),
        "visibility": album.get("visibility"),
        "keys": raw_image_keys(album),
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:20]


def zip_keys(album):
    base = f"temp-zips/{album['albumId']}/{zip_version(album)}"
    return f"{base}.zip", f"{base}.lock"
