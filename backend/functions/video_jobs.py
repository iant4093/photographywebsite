"""Per-source video dispatch receipts in the existing album row.

Only a prepared receipt may create a job. An uncertain old submission is
reconciled by provider token, never blindly replayed after its dedupe window.

Upgrade receipts re-convert an already streaming video to the current ladder
in a new folder. The video keeps its old stream until the new master
playlist exists (MediaConvert writes manifests last), then switches.

Every conversion also writes timeline preview frames; frames receipts add
them alone to a video already on the current ladder. Frames are advertised
once their job is accepted: a frame that is not written yet only means the
player shows no picture for that moment.
"""
import hashlib
import logging
import os
import time
import uuid
from copy import deepcopy
import boto3
from botocore.exceptions import ClientError
from album_media_store import finish_media_sync
from cache_invalidation import request_public_api_invalidation
from dynamodb_helpers import ensure_album_item_budget
from hls_ladder import (
    SCRUB_FRAMES, hls_destination_prefix, hls_is_current, hls_master_playlist_key, receipt_identity,
    scrub_frames_current, scrub_frames_prefix,
)
from media_helpers import get_mediaconvert_client, start_frame_capture_job, start_mediaconvert_job
from visibility_change import enqueue

logger = logging.getLogger("photography_api.video_dispatch")


UPGRADE_FIRST_CHECK_SECONDS = 300
UNRESOLVED_AFTER_SECONDS = 86400
_s3 = None


def prepare(album, images):
    jobs = deepcopy(album.get("videoJobs", {}))
    for image in images:
        if image.get("mediaConvertJobId"):
            continue
        key = image["rawKey"]
        jobs.setdefault(receipt_identity(key), {"key": key, "token": uuid.uuid4().hex, "phase": "prepared"})
        image.pop("hlsUrl", None)
    return jobs


def _master_exists(key):
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3")
    try:
        _s3.head_object(Bucket=os.environ["IMAGES_BUCKET"], Key=hls_master_playlist_key(key))
        return True
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise


def _save(table, album, *, images=False):
    ensure_album_item_budget(album)
    values = {":jobs": album.get("videoJobs", {}), ":active": "active"}
    expression = "SET videoJobs = :jobs"
    if images:
        values[":images"] = album["images"]
        values[":dirty"] = True
        expression += ", images = :images, mediaStoreDirty = :dirty REMOVE mediaStoreVersion"
    table.update_item(Key={"albumId": album["albumId"]}, UpdateExpression=expression,
        ConditionExpression="attribute_exists(albumId) AND #status = :active AND attribute_not_exists(pendingVisibilityChange)",
        ExpressionAttributeNames={"#status": "status"}, ExpressionAttributeValues=values)
    if images:
        album.pop("mediaStoreVersion", None)
        album["mediaStoreDirty"] = True


def _find(receipt, source):
    client = get_mediaconvert_client()
    token = None
    # A bounded search is positive evidence only. An empty/truncated result
    # never authorizes an older ambiguous paid submission to be repeated.
    for _ in range(3):
        response = client.search_jobs(InputFile=source[:300], Queue="Default", Order="DESCENDING", MaxResults=20,
                                      **({"NextToken": token} if token else {}))
        for job in response.get("Jobs", []):
            if job.get("ClientRequestToken") == receipt["token"] or (job.get("UserMetadata") or {}).get("dispatchToken") == receipt["token"]:
                return job["Id"]
        next_token = response.get("NextToken")
        if not next_token or next_token == token:
            return None
        token = next_token
    return None


def resume(table, album, context=None):
    jobs = album.get("videoJobs") or {}
    if not jobs:
        return
    by_key = {image.get("rawKey") or image.get("key"): image for image in album.get("images", []) if isinstance(image, dict)}
    deadline = time.monotonic() + 8
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    for identity, receipt in list(jobs.items()):
        if time.monotonic() >= deadline or (callable(remaining) and remaining() < 20000):
            break
        image = by_key.get(receipt["key"])
        upgrade = receipt.get("upgrade") is True
        frames = receipt.get("frames") is True
        if not image or (frames and scrub_frames_current(image.get("scrubFrames"))) or (
            image.get("mediaConvertJobId") and not upgrade and not frames
        ) or (upgrade and hls_is_current(receipt["key"], image.get("hlsUrl"))):
            del jobs[identity]
            _save(table, album)
            continue
        now = int(time.time())
        if int(receipt.get("checkAfter", 0)) > now or receipt.get("phase") == "unresolved":
            continue
        if receipt["phase"] == "transcoding":
            if _master_exists(receipt["key"]):
                image["hlsUrl"] = hls_master_playlist_key(receipt["key"])
                image["mediaConvertJobId"] = receipt["jobId"]
                image["scrubFrames"] = dict(SCRUB_FRAMES)
                del jobs[identity]
                _save(table, album, images=True)
                if album.get("visibility") == "public":
                    # Cached public responses still name the old (intact) stream.
                    request_public_api_invalidation(album_id=album["albumId"], catalog=True, reason="video-upgrade")
                logger.info("video_upgrade_ready")
                continue
            attempt = min(4, int(receipt.get("checks", 0)))
            receipt.update(checkAfter=now + min(1800, UPGRADE_FIRST_CHECK_SECONDS * (2 ** attempt)), checks=attempt + 1)
            if now - int(receipt.get("transcodeStartedAt", now)) >= UNRESOLVED_AFTER_SECONDS:
                # The job failed or never finished; the old stream stays.
                receipt["phase"] = "unresolved"
                logger.error("video_upgrade_unresolved")
            _save(table, album)
            continue
        source = f"s3://{os.environ['IMAGES_BUCKET']}/{receipt['key']}"
        job_id = None
        submitting = receipt["phase"] == "prepared"
        if submitting:
            receipt.setdefault("firstAttemptAt", now)
            receipt.update(phase="submitting", submittedAt=now)
            _save(table, album)  # Must precede any potentially paid request.
        try:
            frames_destination = f"s3://{os.environ['IMAGES_BUCKET']}/{scrub_frames_prefix(receipt['key'])}"
            if submitting and frames:
                job_id = start_frame_capture_job(source, frames_destination, request_token=receipt["token"],
                    width=image.get("width"), height=image.get("height"))
            elif submitting:
                job_id = start_mediaconvert_job(source,
                    f"s3://{os.environ['IMAGES_BUCKET']}/{hls_destination_prefix(receipt['key'])}",
                    request_token=receipt["token"], width=image.get("width"), height=image.get("height"),
                    frames_s3_prefix=frames_destination)
            else:
                job_id = _find(receipt, source)
        except Exception as error:
            # Only explicit CreateJob rejections permit another submission.
            # In particular, a failed search must never reset uncertain work.
            if submitting and isinstance(error, ClientError) and error.response.get("Error", {}).get("Code") in {
                "TooManyRequestsException", "BadRequestException", "ForbiddenException", "NotFoundException"
            }:
                receipt["phase"] = "prepared"
            logger.warning("video_dispatch_deferred error_type=%s", type(error).__name__)
        # Keep persistence outside the provider exception handler. If saving
        # the accepted ID fails, the durable submitting receipt survives.
        if job_id and upgrade:
            # Keep serving the old stream until the new one is complete.
            receipt.update(phase="transcoding", jobId=job_id, transcodeStartedAt=now,
                           checkAfter=now + UPGRADE_FIRST_CHECK_SECONDS, checks=0)
            _save(table, album)
        elif job_id and frames:
            image["scrubFrames"] = dict(SCRUB_FRAMES)
            del jobs[identity]
            _save(table, album, images=True)
        elif job_id:
            image["mediaConvertJobId"] = job_id
            image["hlsUrl"] = hls_master_playlist_key(receipt["key"])
            image["scrubFrames"] = dict(SCRUB_FRAMES)
            del jobs[identity]
            _save(table, album, images=True)
        else:
            attempt = min(5, int(receipt.get("checks", 0)))
            receipt.update(checkAfter=now + min(1800, 60 * (2 ** attempt)), checks=attempt + 1)
            if now - int(receipt.get("firstAttemptAt", receipt.get("submittedAt", now))) >= 86400:
                receipt["phase"] = "unresolved"
                logger.error("video_dispatch_unresolved manual_reconciliation_required=true")
            _save(table, album)
    if album.get("mediaStoreDirty"):
        if finish_media_sync(table, album, album.get("images", []), lambda: False):
            album.pop("mediaStoreDirty", None)
            album["mediaStoreVersion"] = 1
        else:
            enqueue(album["albumId"], "album-media-sync", delay=30)
    waiting = [int(value.get("checkAfter", 0)) for value in jobs.values() if value.get("phase") != "unresolved"]
    if waiting:
        enqueue(album["albumId"], "album-video-jobs", delay=max(30, min(waiting) - int(time.time())))
