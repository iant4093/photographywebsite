"""S3 ObjectCreated handler that propagates album visibility to new derivatives."""

import os
import urllib.parse
import uuid
import time
import json

import boto3

from media_access import PENDING_VISIBILITY, tag_keys_visibility, validate_album_media_key
from media_mutation import album_lease, object_is_committed, MediaAlbumMissing, MediaMutationBusy, enabled
from cache_invalidation import _queue_client
from response_helpers import json_response
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
    internal = isinstance(event, dict) and event.get("source") == "album-object-tagging" and set(event) == {"source", "albumId", "key", "firstAttemptAt", "attempt"}
    if internal:
        if _album_id_from_key(event["key"]) != event["albumId"]:
            raise ValueError("Invalid tagging continuation")
        records = [{"s3": {"bucket": {"name": expected_bucket}, "object": {"key": urllib.parse.quote_plus(event["key"])}}}]
    else:
        records = (event or {}).get("Records", [])
    tagged = 0
    for record in records:
        bucket = record.get("s3", {}).get("bucket", {}).get("name", "")
        key = urllib.parse.unquote_plus(record.get("s3", {}).get("object", {}).get("key", ""))
        if bucket != expected_bucket:
            raise ValueError("Unexpected S3 event bucket")
        album_id = _album_id_from_key(key)
        if not album_id:
            continue
        validate_album_media_key(key, album={"albumId": album_id})
        try:
            with album_lease(table, album_id, context):
                album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
                visibility = PENDING_VISIBILITY
                if (album and album.get("status", "active") == "active"
                        and album.get("visibility") in ALLOWED_VISIBILITIES
                        and (not enabled() or object_is_committed(album, key))):
                    visibility = album["visibility"]
                tagged += tag_keys_visibility([key], visibility)
        except MediaAlbumMissing:
            # Initial uploads already carry pending, service outputs are denied
            # without a public tag. Do not race a new album's first publication
            # by writing a pending tag after observing a missing row.
            continue
        except MediaMutationBusy:
            album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
            if not album or album.get("status") == "deleting":
                continue
            now = int(time.time())
            started = int(event["firstAttemptAt"]) if internal else now
            attempt = min(4, max(0, int(event["attempt"]))) if internal else 0
            if now - started >= 86400 or started > now + 60:
                raise RuntimeError("Tagging continuation expired")
            queue = os.environ.get("CACHE_INVALIDATION_QUEUE_URL", "").strip()
            if not queue:
                raise RuntimeError("Tagging continuation queue is unavailable")
            _queue_client().send_message(QueueUrl=queue, DelaySeconds=min(300, 30 * 2 ** attempt),
                MessageBody=json.dumps({"version": 1, "kind": "album-object-tagging", "albumId": album_id,
                    "key": key, "firstAttemptAt": started, "attempt": attempt + 1}))
    return json_response(200, {"tagged": tagged}) if internal else {"tagged": tagged}
