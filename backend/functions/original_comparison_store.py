"""Private original-photo index snapshots and comparison records, independent of galleries."""
import gzip
import json
import os
import re
import time

import boto3

INDEX_KEY = {"albumId": "__SYSTEM__", "mediaId": "original-index-v1"}
MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024
_snapshot_cache = {"key": None, "value": None}


def comparison_table():
    return boto3.resource("dynamodb").Table(os.environ["ORIGINAL_COMPARISON_TABLE"])


def index_state():
    return comparison_table().get_item(Key=INDEX_KEY, ConsistentRead=True).get("Item", {})


def load_snapshot(state=None):
    state = index_state() if state is None else state
    key = state.get("indexKey")
    if not isinstance(key, str) or not re.fullmatch(r"index/[a-f0-9]{32}\.json\.gz", key):
        raise RuntimeError("Original index is not ready")
    if _snapshot_cache["key"] == key:
        if _snapshot_cache["value"].get("rootId") != state.get("rootId"):
            raise ValueError("Original index root changed")
        return _snapshot_cache["value"]
    response = boto3.client("s3").get_object(Bucket=os.environ["ORIGINAL_PREVIEW_BUCKET"], Key=key)
    stream = response["Body"]
    try:
        with gzip.GzipFile(fileobj=stream) as handle:
            data = handle.read(MAX_SNAPSHOT_BYTES + 1)
    finally:
        stream.close()
    if len(data) > MAX_SNAPSHOT_BYTES:
        raise ValueError("Original index exceeds size limit")
    snapshot = json.loads(data)
    if not isinstance(snapshot, dict) or snapshot.get("schemaVersion") != 1 or not isinstance(snapshot.get("files"), list):
        raise ValueError("Original index is invalid")
    if snapshot.get("rootId") != state.get("rootId"):
        raise ValueError("Original index root changed")
    _snapshot_cache.update(key=key, value=snapshot)
    return snapshot


def scan_all(table, **kwargs):
    cursor = None
    for _ in range(1000):
        response = table.scan(**kwargs, **({"ExclusiveStartKey": cursor} if cursor else {}))
        yield from response.get("Items", [])
        cursor = response.get("LastEvaluatedKey")
        if not cursor:
            return
    raise RuntimeError("Original reconciliation exceeded scan limit")


def source_version(source):
    return str(source.get("md5Checksum") or "")


def needs_work(image, record, candidates, generation, now=None):
    now = int(time.time()) if now is None else now
    if not record or record.get("rawKey") != (image.get("rawKey") or image.get("key")):
        return True
    if int(record.get("leaseUntil", 0)) > now:
        return False
    if record.get("status") == "pending" and int(record.get("queuedUntil", 0)) > now:
        return False
    if record.get("status") == "ready":
        source = candidates.get(record.get("sourceFileId"))
        return not source or source_version(source) != record.get("sourceChecksum")
    # Every new index generation retries missing sources (including a late Drive
    # backup); failures retry even if no Drive files changed.
    return record.get("indexGeneration") != generation or record.get("status") in {"failed", "pending", "processing"}
