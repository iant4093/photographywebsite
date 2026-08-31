"""Narrow, privacy-safe CloudFront invalidation helpers for public mutations."""

import json
import logging
import os
import time
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from validation_helpers import validate_uuid


logger = logging.getLogger("photography_api.cache_invalidation")
DEFAULT_FRONTEND_DISTRIBUTION_ID = "EIOCCNR8XGQ1B"
_cloudfront = None
_sqs = None


def _client():
    global _cloudfront
    if _cloudfront is None:
        _cloudfront = boto3.client(
            "cloudfront",
            config=Config(
                connect_timeout=3,
                read_timeout=8,
                retries={"mode": "standard", "max_attempts": 3},
            ),
        )
    return _cloudfront


def _queue_client():
    global _sqs
    if _sqs is None:
        _sqs = boto3.client(
            "sqs",
            config=Config(
                connect_timeout=2,
                read_timeout=4,
                retries={"mode": "standard", "max_attempts": 2},
            ),
        )
    return _sqs


def _create_invalidation(distribution_id, paths, reason, *, strict):
    normalized = sorted({path for path in paths if isinstance(path, str) and path.startswith("/")})
    if not distribution_id or not normalized:
        return False
    caller_reference = f"{reason[:48]}-{time.time_ns()}-{uuid.uuid4().hex[:12]}"
    try:
        _client().create_invalidation(
            DistributionId=distribution_id,
            InvalidationBatch={
                "CallerReference": caller_reference,
                "Paths": {"Quantity": len(normalized), "Items": normalized},
            },
        )
        return True
    except (BotoCoreError, ClientError) as error:
        logger.error(
            "cloudfront_invalidation_failed distribution_kind=%s error_type=%s",
            "media" if distribution_id == os.environ.get("IMAGES_DISTRIBUTION_ID") else "frontend",
            type(error).__name__,
        )
        if strict:
            raise
        return False


def invalidate_public_api_batch(*, album_ids=None, catalog=False, reason="public-album", strict=False):
    """Invalidate anonymous representations in one bounded provider request."""
    paths = []
    if catalog:
        paths.extend((
            "/api/public/albums",
            "/api/public/albums?*",
            "/api/public/explore",
            "/api/public/explore?*",
            "/api/public/random-photos",
            "/api/public/random-photos?*",
        ))
    for album_id in sorted(set(album_ids or [])):
        paths.append(f"/api/public/albums/{validate_uuid(album_id)}")
    distribution_id = os.environ.get(
        "FRONTEND_DISTRIBUTION_ID",
        DEFAULT_FRONTEND_DISTRIBUTION_ID,
    ).strip()
    return _create_invalidation(distribution_id, paths, reason, strict=strict)


def invalidate_public_api(*, album_id=None, catalog=False, reason="public-album", strict=False):
    """Synchronously invalidate only anonymous API representations."""
    return invalidate_public_api_batch(
        album_ids=[album_id] if album_id else [],
        catalog=catalog,
        reason=reason,
        strict=strict,
    )


def request_public_api_invalidation(*, album_id=None, catalog=False, reason="public-album"):
    """Queue non-security cache work so an admin write returns immediately.

    Deployments without the queue retain the former synchronous behavior,
    which makes this safe across CloudFormation roll-forward and rollback.
    """
    validated_album_id = validate_uuid(album_id) if album_id else None
    queue_url = os.environ.get("CACHE_INVALIDATION_QUEUE_URL", "").strip()
    if not queue_url:
        return invalidate_public_api(
            album_id=validated_album_id,
            catalog=catalog,
            reason=reason,
        )
    try:
        _queue_client().send_message(
            QueueUrl=queue_url,
            MessageBody=json.dumps({
                "version": 1,
                "albumId": validated_album_id,
                "catalog": bool(catalog),
                "reason": str(reason)[:64],
            }, separators=(",", ":")),
        )
        return True
    except (BotoCoreError, ClientError) as error:
        # Cache invalidation is an availability optimization. A short TTL still
        # bounds staleness, so queue failure must not make a committed edit look
        # unsuccessful and invite a duplicate retry.
        logger.error("cache_invalidation_dispatch_failed error_type=%s", type(error).__name__)
        return False


def invalidate_public_previews(album_id, *, reason="preview-revocation", strict=False):
    """Purge the cacheable namespace before/after a public visibility transition."""
    album_id = validate_uuid(album_id)
    distribution_id = os.environ.get("IMAGES_DISTRIBUTION_ID", "").strip()
    return _create_invalidation(
        distribution_id,
        [f"/public-previews/{album_id}/*"],
        reason,
        strict=strict,
    )


def reset_cache_invalidation_client_for_tests():
    global _cloudfront, _sqs
    _cloudfront = None
    _sqs = None
