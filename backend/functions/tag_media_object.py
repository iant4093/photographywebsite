"""S3 ObjectCreated handler that propagates album visibility to new derivatives."""

import os
import urllib.parse
import uuid

import boto3

from media_access import PENDING_VISIBILITY, tag_keys_visibility
from validation_helpers import ALLOWED_VISIBILITIES


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])


def _album_id_from_key(key):
    parts = key.split("/", 2)
    if len(parts) < 3 or parts[0] != "albums":
        return None
    try:
        return str(uuid.UUID(parts[1]))
    except ValueError:
        return None


def handler(event, context):
    expected_bucket = os.environ.get("IMAGES_BUCKET", "")
    tagged = 0
    for record in (event or {}).get("Records", []):
        bucket = record.get("s3", {}).get("bucket", {}).get("name", "")
        key = urllib.parse.unquote_plus(record.get("s3", {}).get("object", {}).get("key", ""))
        if bucket != expected_bucket:
            raise ValueError("Unexpected S3 event bucket")
        album_id = _album_id_from_key(key)
        if not album_id:
            continue
        album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        visibility = PENDING_VISIBILITY
        if album and album.get("status", "active") == "active" and album.get("visibility") in ALLOWED_VISIBILITIES:
            visibility = album["visibility"]
        tagged += tag_keys_visibility([key], visibility)
    return {"tagged": tagged}
