"""Narrow, privacy-safe CloudFront invalidation helpers for public mutations."""

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


def invalidate_public_api(*, album_id=None, catalog=False, reason="public-album", strict=False):
    """Invalidate only anonymous API representations affected by a mutation."""
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
    if album_id:
        paths.append(f"/api/public/albums/{validate_uuid(album_id)}")
    distribution_id = os.environ.get(
        "FRONTEND_DISTRIBUTION_ID",
        DEFAULT_FRONTEND_DISTRIBUTION_ID,
    ).strip()
    return _create_invalidation(distribution_id, paths, reason, strict=strict)


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
    global _cloudfront
    _cloudfront = None
