"""Move existing videos onto the current HLS ladder, a few at a time.

A schedule scans the video albums and gives converted videos whose stream
predates the current ladder an upgrade receipt; the album's durable video
worker then re-converts each one from its original into a new folder and
switches the video over once the new stream is complete. Pacing keeps the
MediaConvert queue and spend gradual; once every video is current a run only
reads the albums table.

The same schedule wakes due existing receipts when a continuation was lost,
without resetting submission tokens or retry deadlines.

Receipts are added one key at a time with conditions, never by rewriting the
album's receipt map, so this never races an upload's own receipts. Logs carry
counts only.
"""

import json
import logging
import os
from work_queue import queue_url as work_queue_url
import time

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.config import Config
from botocore.exceptions import ClientError

from hls_ladder import frames_candidates, frames_receipt, upgrade_candidates, upgrade_receipt


logger = logging.getLogger("photography_api.video_upgrade")

# New re-conversions per run, and upgrades allowed in flight at once.
MAX_NEW_PER_RUN = 8
MAX_IN_FLIGHT = 12
# Frame backfills do not rebuild the published HLS ladder.
MAX_FRAMES_PER_RUN = 20
BUSY_FIELDS = (
    "pendingVisibilityChange", "pendingMediaDeletion", "pendingAlbumDeletion",
    "pendingMediaUpload", "createdBySub", "trashedAt",
)

_table = None
_sqs = None


def _albums():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])
    return _table


def _enqueue_video_jobs(album_id):
    """Wake the album's durable video worker (same message as visibility_change.enqueue)."""
    global _sqs
    if _sqs is None:
        _sqs = boto3.client("sqs", config=Config(connect_timeout=2, read_timeout=4, retries={"mode": "standard", "max_attempts": 2}))
    _sqs.send_message(
        QueueUrl=work_queue_url(),
        MessageBody=json.dumps({"version": 1, "kind": "album-video-jobs", "albumId": album_id}, separators=(",", ":")),
    )


def _video_albums():
    table = _albums()
    scan = {"FilterExpression": Attr("type").eq("video")}
    while True:
        page = table.scan(**scan)
        yield from page.get("Items", [])
        if not page.get("LastEvaluatedKey"):
            return
        scan["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _in_flight(album):
    return sum(
        1 for receipt in (album.get("videoJobs") or {}).values()
        if isinstance(receipt, dict) and receipt.get("upgrade") is True and receipt.get("phase") != "unresolved"
    )


def _ready(album):
    return album.get("status", "active") == "active" and not any(album.get(field) for field in BUSY_FIELDS)


def _has_due_jobs(album, now):
    """Recover lost continuations without changing receipts or retry ceilings."""
    return any(
        isinstance(receipt, dict)
        and receipt.get("phase") in {"prepared", "submitting", "transcoding"}
        and int(receipt.get("checkAfter", 0)) <= now
        for receipt in (album.get("videoJobs") or {}).values()
    )


def _add_receipt(album_id, identity, receipt):
    """Add one receipt unless the album changed state or already has it."""
    table = _albums()
    condition = "attribute_exists(albumId) AND #status = :active AND attribute_not_exists(pendingVisibilityChange)"
    try:
        table.update_item(
            Key={"albumId": album_id},
            UpdateExpression="SET videoJobs = if_not_exists(videoJobs, :empty)",
            ConditionExpression=condition,
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":empty": {}, ":active": "active"},
        )
        table.update_item(
            Key={"albumId": album_id},
            UpdateExpression="SET videoJobs.#identity = :receipt",
            ConditionExpression=f"{condition} AND attribute_not_exists(videoJobs.#identity)",
            ExpressionAttributeNames={"#status": "status", "#identity": identity},
            ExpressionAttributeValues={":receipt": receipt, ":active": "active"},
        )
        return True
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise


def handler(_event, _context):
    albums = list(_video_albums())
    in_flight = sum(_in_flight(album) for album in albums)
    budget = max(0, min(MAX_NEW_PER_RUN, MAX_IN_FLIGHT - in_flight))
    frames_budget = MAX_FRAMES_PER_RUN
    remaining = queued = frames_queued = resumed = 0
    now = int(time.time())
    for album in albums:
        if not _ready(album):
            continue
        candidates = upgrade_candidates(album)
        remaining += len(candidates)
        added = 0
        for key in candidates[:budget]:
            if _add_receipt(album["albumId"], *upgrade_receipt(key)):
                added += 1
        budget -= added
        queued += added
        # Videos already on the current ladder get their timeline frames alone.
        frames_added = 0
        for key in frames_candidates(album)[:frames_budget]:
            if _add_receipt(album["albumId"], *frames_receipt(key)):
                frames_added += 1
        frames_budget -= frames_added
        frames_queued += frames_added
        due = _has_due_jobs(album, now)
        if added or frames_added or due:
            _enqueue_video_jobs(album["albumId"])
            resumed += int(due)
    logger.info("video_upgrade_run queued=%d frames=%d resumed=%d in_flight=%d waiting=%d",
                queued, frames_queued, resumed, in_flight, remaining - queued)
    return {"queued": queued, "frames": frames_queued, "resumed": resumed, "inFlight": in_flight, "waiting": remaining - queued}
