"""Consume durable album work independently of public CDN invalidation."""
import json
import logging

from continuation_batch import resume_batch
from continuation_dispatch import WORKERS, continue_album_work
from validation_helpers import ValidationError, validate_uuid

logger = logging.getLogger("photography_api.album_work_worker")


def handler(event, context):
    records = []
    for record in (event or {}).get("Records", []):
        try:
            body = json.loads(record.get("body", ""))
            if not isinstance(body, dict) or body.get("version") != 1 or body.get("kind") not in WORKERS:
                raise ValueError("unsupported work message")
            body["albumId"] = validate_uuid(body.get("albumId"))
            records.append((record.get("messageId"), body))
        except (TypeError, ValueError, json.JSONDecodeError, ValidationError):
            logger.warning("album_work_message_discarded")
    return {"batchItemFailures": resume_batch(records, context, continue_album_work)}
