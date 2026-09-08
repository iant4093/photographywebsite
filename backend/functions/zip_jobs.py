"""Shared archive lookups and durable, per-album serialized preparation jobs."""

import json
import os
import hashlib

import boto3

from validation_helpers import validate_uuid
from zip_helpers import zip_version


def object_metadata(s3, bucket, key):
    # Exact-prefix listing distinguishes missing objects without broad ListBucket
    # access (HeadObject returns 403 for missing keys under prefix-scoped IAM).
    contents = s3.list_objects_v2(Bucket=bucket, Prefix=key, MaxKeys=1).get("Contents", [])
    if not isinstance(contents, list):
        raise RuntimeError("Malformed archive lookup")
    return next((item for item in contents if isinstance(item, dict) and item.get("Key") == key), None)


def enqueue_zip(album_id, album=None, *, request_id=None):
    album_id = validate_uuid(album_id)
    version = zip_version(album) if album else "deleted"
    # FIFO serializes builds and cleanup for the same album. Duplicate clicks
    # and stream events share the same five-minute deduplication identity.
    identity = f"{album_id}:{version}:{request_id or ''}"
    return boto3.client("sqs").send_message(
        QueueUrl=os.environ["ZIP_QUEUE_URL"],
        MessageGroupId=album_id,
        MessageDeduplicationId=hashlib.sha256(identity.encode()).hexdigest(),
        MessageBody=json.dumps({"albumId": album_id, "version": version}),
    )
