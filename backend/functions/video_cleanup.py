"""Settle recorded video producers before the final deletion sweep."""
import os
import time
from copy import deepcopy

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from media_access import validate_album_media_key


def client():
    return boto3.client("mediaconvert", config=Config(connect_timeout=2, read_timeout=4,
        retries={"total_max_attempts": 1}))


def prepare(album, images):
    selected = {item.get("rawKey") or item.get("key"): item for item in images if isinstance(item, dict)}
    result = []
    for key, item in selected.items():
        if item.get("mediaConvertJobId"):
            result.append({"key": validate_album_media_key(key, album=album), "jobId": item["mediaConvertJobId"]})
    for receipt in (album.get("videoJobs") or {}).values():
        if receipt.get("key") in selected and receipt.get("phase") != "prepared" and not selected[receipt["key"]].get("mediaConvertJobId"):
            result.append({"key": validate_album_media_key(receipt["key"], album=album), "token": receipt["token"]})
    return deepcopy(result)


def settle(album, pending, save, context=None):
    work = pending.get("videoCleanup", [])
    now = int(time.time())
    if all(item.get("complete") for item in work):
        return True
    if int(pending.get("videoCheckAfter", 0)) > now:
        return False
    pending.setdefault("videoStartedAt", now)
    if now - int(pending["videoStartedAt"]) >= 86400:
        raise RuntimeError("Video deletion needs provider reconciliation")
    provider = client()
    deadline = time.monotonic() + 8
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    start = int(pending.get("videoCursor", 0)) % len(work)
    for offset in range(min(8, len(work))):
        index = (start + offset) % len(work)
        item = work[index]
        pending["videoCursor"] = (index + 1) % len(work)
        if item.get("complete"):
            continue
        if time.monotonic() >= deadline or (callable(remaining) and remaining() < 12000):
            break
        source = "s3://" + os.environ["IMAGES_BUCKET"] + "/" + validate_album_media_key(item["key"], album=album)
        if not item.get("jobId"):
            # One bounded search page per turn; pagination progress survives
            # timeouts. Absence is never proof an ambiguous job was not sent.
            page = provider.search_jobs(InputFile=source[:300], Queue="Default", Order="DESCENDING", MaxResults=20,
                **({"NextToken": item["searchToken"]} if item.get("searchToken") else {}))
            match = next((job for job in page.get("Jobs", []) if job.get("ClientRequestToken") == item["token"]
                or (job.get("UserMetadata") or {}).get("dispatchToken") == item["token"]), None)
            if match:
                item["jobId"] = match["Id"]
                item.pop("searchToken", None)
            elif page.get("NextToken") and page["NextToken"] != item.get("searchToken"):
                item["searchToken"] = page["NextToken"]
            else:
                item.pop("searchToken", None)
            save()
            if not item.get("jobId"):
                continue
        try:
            job = provider.get_job(Id=item["jobId"])["Job"]
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") != "NotFoundException":
                raise
            # Old completed job records expire from MediaConvert. An absent
            # recorded ID has no live producer; never resubmit it during cleanup.
            item["complete"] = True
            save()
            continue
        if source not in [value.get("FileInput") for value in job.get("Settings", {}).get("Inputs", [])]:
            raise RuntimeError("Video job does not match the deleted source")
        if job.get("Status") in {"COMPLETE", "ERROR", "CANCELED"}:
            item["complete"] = True
        elif job.get("Status") == "SUBMITTED":
            try:
                provider.cancel_job(Id=item["jobId"])
            except ClientError as error:
                if error.response.get("Error", {}).get("Code") not in {"ConflictException", "BadRequestException"}:
                    raise
            # Cancellation can race processing. Confirm a terminal state on
            # the next delivery before deleting the final output namespace.
        save()
    pending["videoCheckAfter"] = now + 30
    save()
    return all(item.get("complete") for item in work)
