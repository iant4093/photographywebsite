"""Narrow, privacy-safe CloudFront invalidation helpers for public mutations."""

import json
import logging
import os
import time
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from media_access import album_media_prefixes
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


def invalidate_public_api_batch(*, album_ids=None, catalog=False, random_photos=False, featured_photos=False, reason="public-album", strict=False):
    """Invalidate anonymous representations in one bounded provider request."""
    # Validate even when the catalog wildcard already covers these albums.
    validated_albums = sorted({validate_uuid(value) for value in album_ids or []})
    paths = []
    if catalog:
        # One suffix wildcard covers the exact URL and every query variant.
        # Albums also covers detail URLs, so do not pay for overlapping paths.
        paths.extend(("/api/public/albums*", "/api/public/explore*"))
    else:
        paths.extend(f"/api/public/albums/{album_id}" for album_id in validated_albums)
    if catalog or random_photos:
        paths.append("/api/public/random-photos*")
    if catalog or featured_photos:
        paths.append("/api/public/featured-photos*")
    distribution_id = os.environ.get(
        "FRONTEND_DISTRIBUTION_ID",
        DEFAULT_FRONTEND_DISTRIBUTION_ID,
    ).strip()
    return _create_invalidation(distribution_id, paths, reason, strict=strict)


def invalidate_public_api(*, album_id=None, catalog=False, random_photos=False, featured_photos=False, reason="public-album", strict=False):
    """Synchronously invalidate only anonymous API representations."""
    return invalidate_public_api_batch(
        album_ids=[album_id] if album_id else [],
        catalog=catalog,
        random_photos=random_photos,
        featured_photos=featured_photos,
        reason=reason,
        strict=strict,
    )


def request_public_api_invalidation(*, album_id=None, catalog=False, random_photos=False, featured_photos=False, reason="public-album"):
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
            random_photos=random_photos,
            featured_photos=featured_photos,
            reason=reason,
        )
    try:
        _queue_client().send_message(
            QueueUrl=queue_url,
            MessageBody=json.dumps({
                "version": 1,
                "albumId": validated_album_id,
                "catalog": bool(catalog),
                "randomPhotos": bool(random_photos),
                "featuredPhotos": bool(featured_photos),
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


def invalidate_album_media(album, *, reason="media-revocation", strict=False):
    """Purge originals, derivatives, and their rewritten public-preview URLs.

    Use the same trusted namespaces as media authorization and deletion;
    mutable historical s3Prefix values must never broaden an invalidation.
    """
    album_id = validate_uuid((album or {}).get("albumId"))
    paths = [f"/{prefix}*" for prefix in album_media_prefixes(album)]
    paths.append(f"/public-previews/{album_id}/*")
    return _create_invalidation(
        os.environ.get("IMAGES_DISTRIBUTION_ID", "").strip(),
        paths,
        reason,
        strict=strict,
    )


def reset_cache_invalidation_client_for_tests():
    global _cloudfront, _sqs
    _cloudfront = None
    _sqs = None


def prepare_media_revocation(album, operation_id):
    """Persist this receipt before submission so a lost response is idempotent."""
    distribution = os.environ.get("IMAGES_DISTRIBUTION_ID", "").strip()
    if not distribution:
        raise RuntimeError("Privacy cache invalidation is not configured")
    album_id = validate_uuid(album["albumId"])
    return {"distribution": distribution, "caller": f"media-revocation-{album_id}-{operation_id}",
            "paths": sorted({f"/{prefix}*" for prefix in album_media_prefixes(album)} | {f"/public-previews/{album_id}/*"})}


def advance_media_revocation(receipt):
    """Check once; the existing queue owns waiting, never a sleeping Lambda."""
    if receipt.get("complete"):
        return True
    now = int(time.time())
    if int(receipt.get("checkAfter", 0)) > now:
        return False
    client = _client()
    if receipt.get("id"):
        response = client.get_invalidation(DistributionId=receipt["distribution"], Id=receipt["id"])
    else:
        response = client.create_invalidation(DistributionId=receipt["distribution"], InvalidationBatch={
            "CallerReference": receipt["caller"], "Paths": {"Quantity": len(receipt["paths"]), "Items": receipt["paths"]}})
    invalidation = response.get("Invalidation", {})
    if not isinstance(invalidation.get("Id"), str) or not invalidation["Id"]:
        raise RuntimeError("Invalid privacy invalidation response")
    receipt["id"] = invalidation["Id"]
    receipt["complete"] = invalidation.get("Status") == "Completed"
    receipt["checkAfter"] = now + 15
    return receipt["complete"]
