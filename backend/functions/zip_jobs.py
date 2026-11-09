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


def album_archives(s3, bucket, album_id):
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=f"album-zips/{album_id}/"):
        yield from page.get("Contents", [])


def enqueue_zip(album_id, album=None, *, request_id=None, expire=False):
    album_id = validate_uuid(album_id)
    version = zip_version(album) if album else "deleted"
    # FIFO serializes builds and cleanup for the same album. Duplicate clicks
    # and stream events share the same five-minute deduplication identity.
    identity = f"{album_id}:{version}:{request_id or ''}"
    message = {"albumId": album_id, "version": version}
    if expire:
        message["operation"] = "expire"
        identity = f"expire:{identity}"
    return boto3.client("sqs").send_message(
        QueueUrl=os.environ["ZIP_QUEUE_URL"],
        MessageGroupId=album_id,
        MessageDeduplicationId=hashlib.sha256(identity.encode()).hexdigest(),
        MessageBody=json.dumps(message),
    )
