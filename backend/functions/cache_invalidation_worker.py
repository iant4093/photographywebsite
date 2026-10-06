"""Coalesce queued public API invalidations into one CloudFront request."""

import json
import logging

import boto3

from cache_invalidation import invalidate_public_api_batch
from validation_helpers import ValidationError, validate_uuid
from continuation_dispatch import WORKERS, continue_album_work as _continue_album_work
from continuation_batch import resume_batch


logger = logging.getLogger("photography_api.cache_invalidation_worker")


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
    failures.extend(resume_batch(work_records, _context, _continue_album_work))
    result = {"invalidated": invalidated, "albumCount": len(album_ids), "catalog": catalog}
    if work_records or failures:
        result["batchItemFailures"] = failures
    return result
