"""Read-only, private delivery of matched camera-original previews.

This API module never contacts Drive or mutates the archive, comparison table,
or preview bucket. Archive identifiers and matching evidence stay server-side.
"""

import logging
import os
import re
import time

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


logger = logging.getLogger("photography_api.original_comparison_access")
ORIGINAL_URL_TTL_SECONDS = 1800
_s3 = None


def original_comparisons_enabled():
    return bool(os.environ.get("ORIGINAL_COMPARISON_TABLE", "").strip())


def _get_s3_client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3", config=Config(
            signature_version="s3v4", s3={"addressing_style": "virtual"},
        ))
    return _s3


def _requested_images(album_images):
    from media_access import _raw_key, media_id_for_key, validate_album_media_key
    from validation_helpers import ValidationError

    requested = {}
    for album, images in album_images:
        if not isinstance(album, dict) or album.get("type", "photo") != "photo":
            continue
        sources = images if images is not None else album.get("images", [])
        for image in sources if isinstance(sources, list) else []:
            try:
                raw_key = validate_album_media_key(_raw_key(image), album=album)
            except ValidationError:
                continue
            identity = (album["albumId"], media_id_for_key(raw_key))
            requested[identity] = raw_key
    return requested


def load_original_comparisons_for_albums(album_images, *, resource=None):
    """Read in batches of 100; distinguish missing matches from failed reads."""
    table_name = os.environ.get("ORIGINAL_COMPARISON_TABLE", "").strip()
    if not table_name:
        return {}
    requested = _requested_images(album_images)
    if not requested:
        return {}
    if resource is None:
        from media_access import get_dynamodb_resource
        resource = get_dynamodb_resource()
    results = {}
    for (album_id, media_id), raw_key in requested.items():
        results.setdefault(album_id, {})[media_id] = {
            "albumId": album_id, "mediaId": media_id, "rawKey": raw_key, "status": "pending",
        }
    keys = [{"albumId": album_id, "mediaId": media_id} for album_id, media_id in requested]
    for offset in range(0, len(keys), 100):
        outstanding = keys[offset:offset + 100]
        try:
            for _attempt in range(3):
                response = resource.batch_get_item(RequestItems={
                    table_name: {"Keys": outstanding, "ConsistentRead": False},
                })
                for item in response.get("Responses", {}).get(table_name, []):
                    if not isinstance(item, dict):
                        continue
                    identity = (item.get("albumId"), item.get("mediaId"))
                    if identity in requested:
                        results[identity[0]][identity[1]] = item
                outstanding = response.get("UnprocessedKeys", {}).get(table_name, {}).get("Keys", [])
                if not outstanding:
                    break
        except (BotoCoreError, ClientError) as error:
            logger.error("original_comparison_read_failed error_type=%s", type(error).__name__)
        for key in outstanding:
            identity = (key.get("albumId"), key.get("mediaId"))
            if identity in requested:
                results[identity[0]][identity[1]] = {
                    **key, "rawKey": requested[identity], "status": "failed",
                }
    return results


def _dimension(value):
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
        return number if number == value and 0 < number <= 100000 else None
    except (TypeError, ValueError, OverflowError):
        return None


def serialize_original_comparison(image, album, metadata=None):
    """Expose a minimal DTO only after checking the exact image and key contract."""
    from media_access import _raw_key, media_id_for_key, validate_album_media_key
    from validation_helpers import ValidationError

    if not original_comparisons_enabled() or not isinstance(album, dict) or album.get("type", "photo") != "photo":
        return None
    if metadata is None:
        return {"status": "pending"}
    if not isinstance(metadata, dict):
        return {"status": "failed"}
    try:
        raw_key = validate_album_media_key(_raw_key(image), album=album)
    except ValidationError:
        return {"status": "failed"}
    album_id, media_id = album["albumId"], media_id_for_key(raw_key)
    if (metadata.get("albumId"), metadata.get("mediaId"), metadata.get("rawKey")) != (album_id, media_id, raw_key):
        return {"status": "failed"}
    status = metadata.get("status")
    if status in {"unavailable", "ambiguous"}:
        return {"status": "unavailable"}
    if status in {"pending", "failed"}:
        return {"status": status}
    if status != "ready":
        return {"status": "failed"}

    checksum = metadata.get("sourceChecksum")
    width, height = _dimension(metadata.get("width")), _dimension(metadata.get("height"))
    previews = metadata.get("previews")
    bucket = os.environ.get("ORIGINAL_PREVIEW_BUCKET", "").strip()
    if (
        not bucket or not isinstance(checksum, str) or not re.fullmatch(r"[a-f0-9]{32}", checksum)
        or not width or not height or not isinstance(previews, dict) or not 1 <= len(previews) <= 4
    ):
        return {"status": "failed"}
    allowed_widths = {min(target, width) for target in (640, 960, 1440, 1920)}
    validated = []
    for candidate_width, key in previews.items():
        if not isinstance(candidate_width, str) or not re.fullmatch(r"[1-9][0-9]{0,3}", candidate_width):
            return {"status": "failed"}
        candidate_width = int(candidate_width)
        expected_key = f"before/{album_id}/{media_id}/{checksum}/w{candidate_width}.webp"
        if candidate_width not in allowed_widths or key != expected_key:
            return {"status": "failed"}
        validated.append((candidate_width, key))
    try:
        client = _get_s3_client()
        candidates = [
            {"width": size, "url": client.generate_presigned_url(
                "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=ORIGINAL_URL_TTL_SECONDS,
            )}
            for size, key in sorted(validated)
        ]
    except (BotoCoreError, ClientError) as error:
        logger.error("original_comparison_sign_failed error_type=%s", type(error).__name__)
        return {"status": "failed"}
    return {
        "status": "ready", "url": candidates[-1]["url"], "srcSet": candidates,
        "width": width, "height": height,
        "expiresAt": int((time.time() + ORIGINAL_URL_TTL_SECONDS) * 1000),
    }
