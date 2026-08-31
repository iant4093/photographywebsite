"""Coalesce queued public API invalidations into one CloudFront request."""

import json
import logging

from cache_invalidation import invalidate_public_api_batch
from validation_helpers import ValidationError, validate_uuid


logger = logging.getLogger("photography_api.cache_invalidation_worker")


def handler(event, _context):
    album_ids = set()
    catalog = False
    reasons = []
    for record in (event or {}).get("Records", []):
        try:
            body = json.loads(record.get("body", ""))
            if not isinstance(body, dict) or body.get("version") != 1:
                raise ValueError("unsupported message")
            if body.get("albumId"):
                album_ids.add(validate_uuid(body["albumId"]))
            catalog = catalog or body.get("catalog") is True
            reason = body.get("reason")
            if isinstance(reason, str) and reason:
                reasons.append(reason)
        except (TypeError, ValueError, json.JSONDecodeError, ValidationError):
            # Malformed internal messages contain no authority and are safe to
            # discard instead of poisoning the queue indefinitely.
            logger.warning("cache_invalidation_message_discarded")

    if not album_ids and not catalog:
        return {"invalidated": False, "albumCount": 0, "catalog": False}
    invalidate_public_api_batch(
        album_ids=album_ids,
        catalog=catalog,
        reason=(reasons[0] if len(reasons) == 1 else "batched-public-mutation"),
        strict=True,
    )
    return {"invalidated": True, "albumCount": len(album_ids), "catalog": catalog}
