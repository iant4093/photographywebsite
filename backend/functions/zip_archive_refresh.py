"""Prepare current ZIPs from album changes; reconcile existing albums in pages."""

import json
import logging
import os
import time

import boto3

from media_access import bucket_name
from validation_helpers import ValidationError, validate_uuid
from zip_helpers import get_album_record, zip_keys
from zip_jobs import enqueue_zip, object_metadata


s3 = boto3.client("s3")
logger = logging.getLogger("photography_api.zip_refresh")
CURSOR_KEY = "temp-zips/zip-reconciliation.json"


def refresh_album(album_id, *, request_id=None):
    album = get_album_record(album_id=album_id)
    if album and (album.get("status", "active") != "active" or album.get("createdBySub")):
        return
    if album and object_metadata(s3, bucket_name(), zip_keys(album)[0]):
        return
    # A later edit that restores an earlier title/manifest must still enqueue,
    # even if that same archive version was built within FIFO's dedup window.
    enqueue_zip(album_id, album, request_id=request_id)


def _reconcile():
    params = {"Limit": 100, "ProjectionExpression": "albumId"}
    if object_metadata(s3, bucket_name(), CURSOR_KEY):
        response = s3.get_object(Bucket=bucket_name(), Key=CURSOR_KEY)
        try:
            cursor = json.loads(response["Body"].read())
        finally:
            response["Body"].close()
        if cursor:
            params["ExclusiveStartKey"] = cursor
    page = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"]).scan(**params)
    for item in page.get("Items", []):
        try:
            album_id = validate_uuid(item.get("albumId"))
        except ValidationError:
            continue
        refresh_album(album_id, request_id=f"reconcile:{int(time.time()) // 900}")
    s3.put_object(
        Bucket=bucket_name(), Key=CURSOR_KEY,
        Body=json.dumps(page.get("LastEvaluatedKey")),
        ContentType="application/json", Tagging="visibility=private",
    )
    return {"checked": len(page.get("Items", [])), "hasMore": bool(page.get("LastEvaluatedKey"))}


def handler(event, context):
    if "Records" not in event:
        return _reconcile()
    failures = []
    seen = set()
    for record in event["Records"]:
        sequence = record.get("dynamodb", {}).get("SequenceNumber")
        try:
            album_id = validate_uuid(record.get("dynamodb", {}).get("Keys", {}).get("albumId", {}).get("S"))
        except ValidationError:
            continue
        if album_id in seen:
            continue
        try:
            refresh_album(album_id, request_id=sequence)
            seen.add(album_id)
        except Exception as error:
            logger.error("zip_refresh_failed error_type=%s", type(error).__name__)
            failures.append({"itemIdentifier": sequence})
    return {"batchItemFailures": failures}
