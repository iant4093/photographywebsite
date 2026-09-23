"""Coalesce queued public API invalidations into one CloudFront request."""

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config

from cache_invalidation import invalidate_public_api_batch
from validation_helpers import ValidationError, validate_uuid


logger = logging.getLogger("photography_api.cache_invalidation_worker")
WORKERS = {"album-visibility": "VISIBILITY_WORKER_FUNCTION_NAME",
           "album-upload-followup": "UPLOAD_WORKER_FUNCTION_NAME",
           "album-media-sync": "UPLOAD_WORKER_FUNCTION_NAME",
           "album-thumbnail-cleanup": "THUMBNAIL_WORKER_FUNCTION_NAME"}


def _continue_album_work(body):
    function = os.environ.get(WORKERS[body["kind"]], "").strip()
    if not function:
        raise RuntimeError("Album continuation worker is not configured")
    client = boto3.session.Session().client("lambda", config=Config(connect_timeout=2, read_timeout=20,
                                                retries={"mode": "standard", "total_max_attempts": 1}))
    response = client.invoke(FunctionName=function, InvocationType="RequestResponse",
                             Payload=json.dumps({"source": body["kind"], "albumId": validate_uuid(body["albumId"])}))
    payload = response["Payload"]
    try:
        raw = payload.read(65537)
        if len(raw) > 65536:
            raise RuntimeError("Invalid continuation response size")
        result = json.loads(raw)
    finally:
        payload.close()
    if response.get("FunctionError") or result.get("statusCode") not in {200, 202}:
        raise RuntimeError("Album continuation did not complete")


def handler(event, _context):
    album_ids = set()
    catalog = False
    random_photos = False
    featured_photos = False
    reasons = []
    failures = []
    invalidation_records = []
    work_records = []
    for record in (event or {}).get("Records", []):
        try:
            body = json.loads(record.get("body", ""))
            if not isinstance(body, dict) or body.get("version") != 1:
                raise ValueError("unsupported message")
            if body.get("kind") in WORKERS:
                body["albumId"] = validate_uuid(body.get("albumId"))
                work_records.append((record.get("messageId"), body))
                continue
            if body.get("kind"):
                raise ValueError("unsupported message kind")
            invalidation_records.append(record.get("messageId"))
            if body.get("albumId"):
                album_ids.add(validate_uuid(body["albumId"]))
            catalog = catalog or body.get("catalog") is True
            random_photos = random_photos or body.get("randomPhotos") is True
            featured_photos = featured_photos or body.get("featuredPhotos") is True
            reason = body.get("reason")
            if isinstance(reason, str) and reason:
                reasons.append(reason)
        except (TypeError, ValueError, json.JSONDecodeError, ValidationError):
            # Malformed internal messages contain no authority and are safe to
            # discard instead of poisoning the queue indefinitely.
            logger.warning("cache_invalidation_message_discarded")

    invalidated = bool(album_ids or catalog or random_photos or featured_photos)
    if invalidated:
        try:
            invalidate_public_api_batch(
                album_ids=album_ids, catalog=catalog, random_photos=random_photos,
                featured_photos=featured_photos,
                reason=(reasons[0] if len(reasons) == 1 else "batched-public-mutation"), strict=True,
            )
        except Exception:
            if not all(invalidation_records):
                raise  # Preserve direct/legacy invocation error semantics.
            failures.extend({"itemIdentifier": value} for value in invalidation_records)
            invalidated = False
    remaining = getattr(_context, "get_remaining_time_in_millis", None)
    grouped = {}
    for identifier, body in work_records:
        identity = (body["kind"], body["albumId"])
        group = grouped.setdefault(identity, {"body": body, "ids": []})
        group["ids"].append(identifier)

    def resume(group):
        try:
            if callable(remaining) and remaining() < 24000:
                raise RuntimeError("Defer continuation to the next batch")
            _continue_album_work(group["body"])
            return []
        except Exception as error:
            logger.error("album_continuation_failed error_type=%s", type(error).__name__)
            if not all(group["ids"]):
                raise
            return [{"itemIdentifier": identifier} for identifier in group["ids"]]

    if grouped:
        with ThreadPoolExecutor(max_workers=min(4, len(grouped)), thread_name_prefix="album-work") as executor:
            for batch_failures in executor.map(resume, grouped.values()):
                failures.extend(batch_failures)
    result = {"invalidated": invalidated, "albumCount": len(album_ids), "catalog": catalog}
    if work_records or failures:
        result["batchItemFailures"] = failures
    return result
