"""Per-source video dispatch receipts in the existing album row.

Only a prepared receipt may create a job. An uncertain old submission is
reconciled by provider token, never blindly replayed after its dedupe window.
"""
import hashlib
import logging
import os
import time
import uuid
from copy import deepcopy
from botocore.exceptions import ClientError
from album_media_store import finish_media_sync
from dynamodb_helpers import ensure_album_item_budget
from media_helpers import get_mediaconvert_client, hls_master_playlist_key, start_mediaconvert_job
from visibility_change import enqueue

logger = logging.getLogger("photography_api.video_dispatch")


def prepare(album, images):
    jobs = deepcopy(album.get("videoJobs", {}))
    for image in images:
        if image.get("mediaConvertJobId"):
            continue
        key = image["rawKey"]
        identity = hashlib.sha256(key.encode()).hexdigest()[:24]
        jobs.setdefault(identity, {"key": key, "token": uuid.uuid4().hex, "phase": "prepared"})
        image.pop("hlsUrl", None)
    return jobs


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
        if not image or image.get("mediaConvertJobId"):
            del jobs[identity]
            _save(table, album)
            continue
        now = int(time.time())
        if int(receipt.get("checkAfter", 0)) > now or receipt.get("phase") == "unresolved":
            continue
        source = f"s3://{os.environ['IMAGES_BUCKET']}/{receipt['key']}"
        job_id = None
        submitting = receipt["phase"] == "prepared"
        if submitting:
            receipt.setdefault("firstAttemptAt", now)
            receipt.update(phase="submitting", submittedAt=now)
            _save(table, album)  # Must precede any potentially paid request.
        try:
            if submitting:
                job_id = start_mediaconvert_job(source,
                    f"s3://{os.environ['IMAGES_BUCKET']}/{receipt['key'].rsplit('.', 1)[0]}_hls/",
                    request_token=receipt["token"])
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
        if job_id:
            image["mediaConvertJobId"] = job_id
            image["hlsUrl"] = hls_master_playlist_key(receipt["key"])
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
