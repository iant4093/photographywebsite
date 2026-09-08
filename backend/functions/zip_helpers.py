"""Shared deterministic ZIP job helpers."""

import hashlib
import json
import os
import posixpath
import re

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
    if len(items) != 1:
        return None
    # GSIs are eventually consistent. Re-read the authoritative manifest so a
    # shared download reflects edits and sharing revocation immediately.
    return table.get_item(Key={"albumId": items[0]["albumId"]}, ConsistentRead=True).get("Item")


def raw_image_keys(album):
    return [
        image.get("rawKey") or image.get("key")
        for image in album.get("images", [])
        if isinstance(image, dict) and (image.get("rawKey") or image.get("key"))
    ]


def zip_version(album):
    material = {
        "archiveFormatVersion": 4,
        "albumId": album.get("albumId"),
        "title": album.get("title", "album"),
        "type": album.get("type", "photo"),
        "visibility": album.get("visibility"),
        "files": archive_entries(album),
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:20]


def zip_keys(album):
    version = zip_version(album)
    return (
        f"album-zips/{album['albumId']}/{version}.zip",
        f"temp-zips/{album['albumId']}/{version}.failed.json",
    )


def archive_entries(album):
    """Stable ordered sources and safe, human-readable names inside the ZIP."""
    entries = []
    for image in album.get("images", []):
        if not isinstance(image, dict):
            continue
        key = image.get("rawKey") or image.get("key")
        if not key:
            continue
        name = image.get("originalFilename") or posixpath.basename(key)
        name = posixpath.basename(str(name).replace("\\", "/"))
        name = re.sub(r'[\x00-\x1f\x7f<>:"|?*]', "_", name).strip(" .")[:180] or "media"
        entries.append({"key": key, "name": f"{len(entries) + 1:04d}_{name}"})
    return entries
