"""Administrator controls for the Videos-page hero reel.

The reel worker does the heavy lifting; these operations only record a job
in the gallery settings table and hand it to the worker asynchronously.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import uuid
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

from validation_helpers import ValidationError


STATE_KEY = {"settingId": "hero-reel"}
ACTIVE_STATUSES = ("queued", "running")
# A job the worker never picked up (or that died mid-build) stops blocking
# new requests after this long.
STALE_JOB_SECONDS = 20 * 60
VERSION_PATTERN = re.compile(r"^[a-f0-9]{24}$")
REEL_KEY_PATTERN = re.compile(
    r"^site/hero/versions/video/reel/v1/[a-f0-9]{24}/"
    r"(?:reel-(?:\d-)?\d{3,4}x\d{3,4}\.mp4|reel-\d-(?:landscape|portrait)\.m3u8|poster(?:-\d)?\.jpg)$"
)
ORIENTATIONS = ("landscape", "portrait")

_lambda = None
_table = None


class ReelBusy(Exception):
    """Another reel job is already queued or running."""


def _lambda_client():
    global _lambda
    if _lambda is None:
        _lambda = boto3.client("lambda")
    return _lambda


def _settings():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["GALLERY_SETTINGS_TABLE"])
    return _table


def _now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def _iso(value):
    return value.isoformat().replace("+00:00", "Z")


def _plain(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_plain(item) for item in value]
    return value


def _media_url(key):
    if not isinstance(key, str) or not REEL_KEY_PATTERN.fullmatch(key):
        return None
    domain = os.environ["CLOUDFRONT_DOMAIN"].strip().removeprefix("https://").rstrip("/")
    return f"https://{domain}/{key}"


def _renditions(items):
    renditions = []
    for item in items or []:
        url = _media_url(item.get("key"))
        if url:
            renditions.append({"url": url, "width": item.get("width"), "height": item.get("height"), "bytes": item.get("bytes")})
    return renditions


def _streams(cut):
    """Adaptive (HLS) master playlists per orientation, or None for older MP4 reels."""
    streams = {}
    for orientation in ORIENTATIONS:
        stream = cut.get(orientation)
        url = _media_url(stream.get("master")) if isinstance(stream, dict) else None
        if not url:
            return None
        rungs = stream.get("rungs") or []
        streams[orientation] = {
            "url": url,
            "maxHeight": max((int(rung.get("height") or 0) for rung in rungs), default=0),
            "maxWidth": max((int(rung.get("width") or 0) for rung in rungs), default=0),
        }
    return streams


def _seconds(value):
    try:
        return round(float(value), 1)
    except (TypeError, ValueError):
        return None


def _public_record(record):
    """Expose only what the admin preview needs; never source IDs."""
    if not isinstance(record, dict) or not VERSION_PATTERN.fullmatch(str(record.get("version") or "")):
        return None
    record = _plain(record)
    raw_cuts = record.get("cuts") or (
        [{"renditions": record.get("renditions"), "posterKey": record.get("posterKey"), "duration": record.get("duration")}]
        if record.get("renditions") else []
    )
    cuts = [
        {
            "renditions": _renditions(cut.get("renditions")),
            "streams": _streams(cut),
            "posterUrl": _media_url(cut.get("posterKey")),
            "duration": _seconds(cut.get("duration")),
        }
        for cut in raw_cuts
    ]
    cuts = [cut for cut in cuts if cut["renditions"] or cut["streams"]]
    return {
        "version": record["version"],
        "mode": record.get("mode"),
        "createdAt": record.get("createdAt"),
        "publishedAt": record.get("publishedAt"),
        "duration": _seconds(record.get("duration")),
        "clipCount": record.get("clipCount"),
        "sourceCount": record.get("sourceCount"),
        "pendingCount": len(record.get("pending") or []),
        "cuts": cuts,
    }


def _public_job(job):
    if not isinstance(job, dict):
        return None
    job = _plain(job)
    return {
        "requestId": job.get("requestId"),
        "mode": job.get("mode"),
        "status": job.get("status"),
        "reason": job.get("reason"),
        "version": job.get("version"),
        "progress": job.get("progress"),
        "total": job.get("total"),
        "updatedAt": job.get("updatedAt"),
    }


def status():
    item = _settings().get_item(Key=STATE_KEY, ConsistentRead=True).get("Item") or {}
    auto = _plain(item.get("auto")) if isinstance(item.get("auto"), dict) else None
    return {
        "job": _public_job(item.get("job")),
        "draft": _public_record(item.get("draft")),
        "published": _public_record(item.get("published")),
        "auto": {"status": auto.get("status"), "reason": auto.get("reason"), "at": auto.get("at")} if auto else None,
    }


def _queue(mode, **extra):
    request_id = uuid.uuid4().hex
    now = _now()
    stale = _iso(now - dt.timedelta(seconds=STALE_JOB_SECONDS))
    job = {"requestId": request_id, "mode": mode, "status": "queued", "updatedAt": _iso(now), **extra}
    try:
        _settings().update_item(
            Key=STATE_KEY,
            UpdateExpression="SET #job = :job",
            ConditionExpression=(
                "attribute_not_exists(#job) OR NOT #job.#status IN (:queued, :running) OR #job.#updatedAt < :stale"
            ),
            ExpressionAttributeNames={"#job": "job", "#status": "status", "#updatedAt": "updatedAt"},
            ExpressionAttributeValues={":job": job, ":queued": "queued", ":running": "running", ":stale": stale},
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise ReelBusy() from error
        raise
    try:
        _lambda_client().invoke(
            FunctionName=os.environ["HERO_REEL_FUNCTION_NAME"],
            InvocationType="Event",
            Payload=json.dumps(
                {"action": "publish" if mode == "publish" else "generate", "requestId": request_id, **extra},
                separators=(",", ":"),
            ).encode("utf-8"),
        )
    except Exception:
        # Release the slot so the administrator can retry immediately.
        failed = {**job, "status": "failed", "reason": "dispatch_failed", "updatedAt": _iso(_now())}
        _settings().update_item(
            Key=STATE_KEY,
            UpdateExpression="SET #job = :job",
            ConditionExpression="#job.#requestId = :rid",
            ExpressionAttributeNames={"#job": "job", "#requestId": "requestId"},
            ExpressionAttributeValues={":job": failed, ":rid": request_id},
        )
        raise
    return _public_job(job)


def generate():
    return _queue("draft")


def publish(body):
    version = str((body or {}).get("version") or "").strip().lower()
    if not VERSION_PATTERN.fullmatch(version):
        raise ValidationError("version is invalid")
    return _queue("publish", version=version)
