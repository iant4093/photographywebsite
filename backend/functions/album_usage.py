"""Daily per-album storage and media CDN bandwidth for the AWS costs page.

Storage is the size of each album's current objects under ``albums/<id>/``.
Bandwidth is summed from the media distribution's standard access logs: only
the bytes each album's paths served are kept, never addresses or user agents.
Each log day is reduced to one small cache item, so the 30-day window is a
handful of reads, and a day is counted once its logs have had time to arrive.

Protected media delivered through the site's signed-cookie path is served by
the frontend distribution and is not in these logs.
"""

import datetime
import gzip
import json
import logging
import os
import re

import boto3


logger = logging.getLogger("photography_api.album_usage")

SUMMARY_KEY = "album-usage-v1"
DAY_KEY = "album-bandwidth-v1#{day}"
STATE_KEY = "album-usage-state-v1"
WINDOW_DAYS = 30
# CloudFront delivers standard logs within hours, rarely up to a day.
LOG_LAG_DAYS = 2
TOP_ALBUMS = 25
ALBUM_PATH = re.compile(r"^/(?:albums|public-previews)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/")
ALBUM_KEY = re.compile(r"^albums/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/")
OTHER = "other"
ALBUM_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

_s3 = None
_dynamodb = None


def _client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3")
    return _s3


def _resource():
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb")
    return _dynamodb


def _cache():
    return _resource().Table(os.environ["COST_REPORT_CACHE_TABLE"])


def album_storage():
    """Bytes and object counts per album, from the current object listing."""
    sizes, counts = {}, {}
    paginator = _client().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=os.environ["IMAGES_BUCKET"], Prefix="albums/"):
        for item in page.get("Contents", []):
            match = ALBUM_KEY.match(item.get("Key", ""))
            album_id = match.group(1) if match else OTHER
            sizes[album_id] = sizes.get(album_id, 0) + int(item.get("Size", 0))
            counts[album_id] = counts.get(album_id, 0) + 1
    return sizes, counts


def parse_log(lines, totals):
    """Add one CloudFront standard log's bytes per album to ``totals``."""
    fields = None
    for line in lines:
        if line.startswith("#Fields:"):
            fields = line[len("#Fields:"):].split()
            continue
        if not line or line.startswith("#") or not fields:
            continue
        values = line.rstrip("\n").split("\t")
        record = dict(zip(fields, values))
        try:
            sent = int(record.get("sc-bytes", "0"))
        except ValueError:
            continue
        match = ALBUM_PATH.match(record.get("cs-uri-stem", ""))
        album_id = match.group(1) if match else OTHER
        totals[album_id] = totals.get(album_id, 0) + sent
    return totals


def day_bandwidth(day):
    """Bytes served per album on one UTC day, from that day's log files."""
    bucket = os.environ["MEDIA_LOGS_BUCKET"]
    prefix = f"media/{os.environ['IMAGES_DISTRIBUTION_ID']}.{day.isoformat()}-"
    totals = {}
    paginator = _client().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            body = _client().get_object(Bucket=bucket, Key=item["Key"])["Body"].read()
            text = gzip.decompress(body).decode("utf-8", errors="replace")
            parse_log(text.splitlines(), totals)
    return totals


def _ingest_days(today, remaining):
    """Reduce every unprocessed complete log day in the window to a cache item."""
    table = _cache()
    state = table.get_item(Key={"cacheKey": STATE_KEY}, ConsistentRead=True).get("Item") or {}
    last_ready = today - datetime.timedelta(days=LOG_LAG_DAYS)
    first = last_ready - datetime.timedelta(days=WINDOW_DAYS - 1)
    done = state.get("lastDay")
    day = max(first, datetime.date.fromisoformat(done) + datetime.timedelta(days=1)) if done else first
    processed = 0
    while day <= last_ready:
        if callable(remaining) and remaining() < 60000:
            break
        totals = day_bandwidth(day)
        table.put_item(Item={"cacheKey": DAY_KEY.format(day=day.isoformat()), "bytes": totals})
        table.put_item(Item={"cacheKey": STATE_KEY, "lastDay": day.isoformat()})
        old = day - datetime.timedelta(days=WINDOW_DAYS + 5)
        table.delete_item(Key={"cacheKey": DAY_KEY.format(day=old.isoformat())})
        processed += 1
        day += datetime.timedelta(days=1)
    return first, min(last_ready, day - datetime.timedelta(days=1)), processed


def window_bandwidth(first, last):
    """Bytes per album summed over the stored days in [first, last]."""
    keys, day = [], first
    while day <= last:
        keys.append({"cacheKey": DAY_KEY.format(day=day.isoformat())})
        day += datetime.timedelta(days=1)
    totals, days = {}, 0
    name = os.environ["COST_REPORT_CACHE_TABLE"]
    for offset in range(0, len(keys), 100):
        request = {name: {"Keys": keys[offset:offset + 100]}}
        for _attempt in range(3):
            response = _resource().batch_get_item(RequestItems=request)
            for item in response.get("Responses", {}).get(name, []):
                days += 1
                for album_id, sent in (item.get("bytes") or {}).items():
                    totals[album_id] = totals.get(album_id, 0) + int(sent)
            unprocessed = response.get("UnprocessedKeys", {}).get(name)
            if not unprocessed:
                break
            request = {name: unprocessed}
    return totals, days


def album_labels():
    """Title, type, visibility and bin state for each album."""
    labels = {}
    scan = {"ProjectionExpression": "albumId, title, #type, visibility, trashedAt", "ExpressionAttributeNames": {"#type": "type"}}
    table = _resource().Table(os.environ["ALBUMS_TABLE"])
    while True:
        page = table.scan(**scan)
        for item in page.get("Items", []):
            if not ALBUM_ID.match(str(item.get("albumId", ""))):
                continue  # Internal rows (deletion receipts, markers) share the table.
            labels[item["albumId"]] = {
                "title": str(item.get("title") or "Untitled")[:200],
                "type": "video" if item.get("type") == "video" else "photo",
                "visibility": item.get("visibility") if item.get("visibility") in {"public", "private", "unlisted"} else "unlisted",
                "deleted": bool(item.get("trashedAt")),
            }
        if not page.get("LastEvaluatedKey"):
            return labels
        scan["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def build_summary(storage, objects, bandwidth, labels, *, first, last, days, now):
    def row(album_id):
        label = labels.get(album_id, {"title": "Removed album", "type": "photo", "visibility": "unlisted", "deleted": True})
        return {
            "albumId": album_id, **label,
            "storageBytes": storage.get(album_id, 0), "objectCount": objects.get(album_id, 0),
            "bandwidthBytes": bandwidth.get(album_id, 0),
        }
    album_ids = (set(storage) | set(bandwidth)) - {OTHER}
    by_storage = sorted(album_ids, key=lambda album_id: (-storage.get(album_id, 0), album_id))[:TOP_ALBUMS]
    by_bandwidth = sorted(
        (album_id for album_id in album_ids if bandwidth.get(album_id, 0) > 0),
        key=lambda album_id: (-bandwidth.get(album_id, 0), album_id),
    )[:TOP_ALBUMS]
    return {
        "kind": "album-usage",
        "schemaVersion": 1,
        "generatedAt": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "storageBytes": sum(storage.values()),
        "albumCount": len(album_ids),
        "bandwidthBytes": sum(bandwidth.values()),
        "otherBandwidthBytes": bandwidth.get(OTHER, 0),
        "bandwidthWindow": {"from": first.isoformat(), "to": last.isoformat(), "days": days},
        "byStorage": [row(album_id) for album_id in by_storage],
        "byBandwidth": [row(album_id) for album_id in by_bandwidth],
    }


def handler(_event, context):
    now = datetime.datetime.now(datetime.timezone.utc)
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    storage, objects = album_storage()
    first, last, processed = _ingest_days(now.date(), remaining)
    bandwidth, days = window_bandwidth(first, last)
    summary = build_summary(storage, objects, bandwidth, album_labels(), first=first, last=last, days=days, now=now)
    _cache().put_item(Item={"cacheKey": SUMMARY_KEY, "payload": json.dumps(summary, separators=(",", ":"))})
    logger.info("album_usage_run albums=%d log_days=%d processed=%d", summary["albumCount"], days, processed)
    return {"albums": summary["albumCount"], "logDays": days, "processed": processed}


def load_summary(table):
    """The latest summary for the cost report, or None."""
    item = table.get_item(Key={"cacheKey": SUMMARY_KEY}).get("Item") or {}
    try:
        summary = json.loads(item.get("payload") or "null")
    except (TypeError, ValueError):
        return None
    valid = isinstance(summary, dict) and summary.get("kind") == "album-usage" and summary.get("schemaVersion") == 1
    return summary if valid else None

