"""Incremental, idempotent legacy-manifest backfill for AlbumMediaTable."""

import logging
import os

import boto3

from album_media_store import (
    BACKFILL_MEDIA_ID,
    SYSTEM_ALBUM_ID,
    _table,
    activate_album_media,
    replace_album_media,
)


albums_table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])
logger = logging.getLogger("photography_api.album_media_backfill")


def _migrate(album):
    album_id = album.get("albumId")
    images = album.get("images")
    if (
        not isinstance(album_id, str)
        or not isinstance(images, list)
        or album.get("mediaStoreVersion") == 1
    ):
        return False
    replace_album_media(album_id, images)
    # The equality guard prevents a concurrent upload/delete from activating
    # an incomplete snapshot. That album remains legacy-readable and retries.
    activate_album_media(albums_table, album_id, images)
    return True


def handler(_event, _context):
    media_table = _table()
    if media_table is None:
        raise RuntimeError("ALBUM_MEDIA_TABLE is not configured")
    state_key = {"albumId": SYSTEM_ALBUM_ID, "mediaId": BACKFILL_MEDIA_ID}
    state = media_table.get_item(Key=state_key, ConsistentRead=True).get("Item", {})
    if state.get("status") == "complete":
        return {"status": "complete", "processed": 0}

    processed = 0
    retries = []
    for album_id in state.get("retryAlbumIds", []) if isinstance(state.get("retryAlbumIds"), list) else []:
        try:
            album = albums_table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
            if album and _migrate(album):
                processed += 1
        except Exception as error:
            retries.append(album_id)
            logger.error(
                "album_media_backfill_retry_failed album_id=%s error_type=%s",
                album_id,
                type(error).__name__,
            )

    cursor = None
    scan_complete = state.get("scanComplete") is True
    if not scan_complete:
        scan = {"Limit": 20}
        if isinstance(state.get("lastEvaluatedKey"), dict):
            scan["ExclusiveStartKey"] = state["lastEvaluatedKey"]
        response = albums_table.scan(**scan)
        for album in response.get("Items", []):
            album_id = album.get("albumId")
            try:
                if _migrate(album):
                    processed += 1
            except Exception as error:
                if isinstance(album_id, str):
                    retries.append(album_id)
                logger.error(
                    "album_media_backfill_failed album_id=%s error_type=%s",
                    album_id,
                    type(error).__name__,
                )
        cursor = response.get("LastEvaluatedKey")
        scan_complete = not cursor

    retries = sorted(set(retries))[:100]
    state_item = {
        **state_key,
        "recordType": "migrationState",
        "schemaVersion": 1,
        "status": "complete" if scan_complete and not retries else "running",
        "scanComplete": scan_complete,
        "processedInLastRun": processed,
    }
    if cursor:
        state_item["lastEvaluatedKey"] = cursor
    if retries:
        state_item["retryAlbumIds"] = retries
    media_table.put_item(Item=state_item)
    return {"status": state_item["status"], "processed": processed}
