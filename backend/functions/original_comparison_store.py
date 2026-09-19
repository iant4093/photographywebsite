"""Private original-photo index snapshots and comparison records, independent of galleries."""
import gzip
import hashlib
import json
import os
import re
import time

import boto3

INDEX_KEY = {"albumId": "__SYSTEM__", "mediaId": "original-index-v1"}
MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024
UNMATCHED_RETRY_SECONDS = 86400
FAILURE_RETRY_SECONDS = 900
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


def image_revision(image):
    """Notice edited matching metadata without storing another photo manifest."""
    return hashlib.sha256(json.dumps(image, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def retry_due(image, record, generation, now):
    """Negative matches are checked daily forever, or sooner on changed inputs.

    Failures have a bounded cooldown even if an SQS redelivery or another index
    generation arrives. A successful comparison clears that failure history.
    """
    status = record.get("status")
    if status == "failed":
        return now >= int(record.get("nextAttemptAt", int(record.get("updatedAt", 0)) + FAILURE_RETRY_SECONDS))
    if status not in {"unavailable", "ambiguous"}:
        return True
    if record.get("indexGeneration") != generation:
        return True
    if record.get("imageRevision") and record["imageRevision"] != image_revision(image):
        return True
    deadline = int(record.get("nextAttemptAt", int(record.get("updatedAt", 0)) + UNMATCHED_RETRY_SECONDS))
    return now >= deadline


def failure_retry(previous, now):
    count = min(max(int(previous.get("failureCount", 0)), 0) + 1, 8)
    return count, now + min(UNMATCHED_RETRY_SECONDS, FAILURE_RETRY_SECONDS * 2 ** (count - 1))


def needs_work(image, record, candidates, generation, now=None):
    now = int(time.time()) if now is None else now
    if not record or record.get("rawKey") != (image.get("rawKey") or image.get("key")):
        return True
    if int(record.get("leaseUntil", 0)) > now:
        return False
    if record.get("status") == "pending" and int(record.get("queuedUntil", 0)) > now:
        return False
    if record.get("status") == "ready":
        if record.get("imageRevision") and record["imageRevision"] != image_revision(image):
            return True
        source = candidates.get(record.get("sourceFileId"))
        return not source or source_version(source) != record.get("sourceChecksum")
    return retry_due(image, record, generation, now)
