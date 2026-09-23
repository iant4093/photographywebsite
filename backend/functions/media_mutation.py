"""Serialize media publication with privacy changes using the existing album row.

The lease outlives the invoking Lambda, including a grace period for in-flight
provider requests. Never shorten it to a per-operation stopwatch: a paused
publisher must not resume after a different invocation acquired the lease.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import logging
import os
import time
import uuid

from botocore.exceptions import ClientError

logger = logging.getLogger("photography_api.media_mutation")
_held = ContextVar("album_media_lease", default=None)


def enabled():
    # Explicit rollout switch also supports old artifacts during a deployment.
    return os.environ.get("MEDIA_MUTATION_PROTOCOL", "1") == "1"


class MediaMutationBusy(Exception):
    pass


class MediaAlbumMissing(Exception):
    pass


@contextmanager
def album_lease(table, album_id, context=None, *, transition=False, creating=False):
    if not enabled() or _held.get() == album_id:
        yield
        return
    owner = uuid.uuid4().hex
    now = int(time.time())
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    duration = max(60, int(remaining() / 1000) + 60) if callable(remaining) else 960
    states = [":active"]
    values = {":owner": owner, ":until": now + duration, ":now": now, ":active": "active"}
    if transition:
        states.append(":transition")
        values[":transition"] = "updating"
    if creating:
        states.append(":pending")
        values[":pending"] = "pending"
    try:
        table.update_item(
            Key={"albumId": album_id},
            UpdateExpression="SET mediaLeaseOwner = :owner, mediaLeaseUntil = :until",
            ConditionExpression=(
                "attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status IN (" + ", ".join(states) + ")) "
                "AND (attribute_not_exists(mediaLeaseUntil) OR mediaLeaseUntil < :now)"
            ),
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues=values,
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        current = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not current:
            raise MediaAlbumMissing("Album not found") from None
        raise MediaMutationBusy("Media is being updated. Please retry shortly.") from None
    token = _held.set(album_id)
    try:
        yield
    finally:
        _held.reset(token)
        try:
            table.update_item(
                Key={"albumId": album_id},
                UpdateExpression="REMOVE mediaLeaseOwner, mediaLeaseUntil",
                ConditionExpression="attribute_exists(albumId) AND mediaLeaseOwner = :owner",
                ExpressionAttributeValues={":owner": owner},
            )
        except Exception as error:
            # A failed release expires after the invocation; never clear a new owner.
            logger.error("media_lease_release_failed error_type=%s", type(error).__name__)


def assert_current_publication(album):
    if not album or album.get("status", "active") != "active" or album.get("pendingVisibilityChange"):
        raise MediaMutationBusy("Album publication is not ready")


def object_is_committed(album, key):
    """Match sources exactly and only recognized derivatives of saved sources."""
    from media_access import expected_preview_keys, validated_album_qr_key, validated_hover_preview_manifest_key, validate_album_media_key
    from validation_helpers import ValidationError
    try:
        key = validate_album_media_key(key, album=album)
    except ValidationError:
        return False
    if key in {validated_album_qr_key(album), validated_hover_preview_manifest_key(album)} - {None, ""}:
        return True
    # Covers are valid committed references even for legacy standalone covers.
    if key in {album.get("coverImageUrl"), album.get("coverThumbKey")} - {None, ""}:
        return True
    for image in album.get("images", []):
        source = image if isinstance(image, dict) else {"rawKey": image}
        raw = source.get("rawKey") or source.get("key")
        if not isinstance(raw, str) or not raw:
            continue
        if key in {raw, source.get("thumbKey"), source.get("hlsUrl")}:
            return True
        if album.get("type") == "video" and key.startswith(raw.rsplit(".", 1)[0] + "_hls/"):
            # Every HLS rendition belongs to this exact committed video prefix.
            return key.endswith((".m3u8", ".ts", ".m4s", ".mp4"))
        if key in expected_preview_keys(album["albumId"], raw).values():
            return True
    return False
