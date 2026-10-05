"""Which day each public photo was taken, for the Stats page shooting calendar.

New uploads record ``exif.takenOn`` when they are processed. For photos that
predate that, the daily refresh reads the first 64 KB of the original once
(where the EXIF header lives) and remembers the result per album in the
cache table, so each photo is read at most once. Only the calendar day is
kept, never the time. A photo with no readable date counts on its album's
date, and videos always do.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import hashlib
import io
import logging
import os
import re
import time

import boto3


logger = logging.getLogger("photography_api.capture_calendar")

CACHE_PREFIX = "capture-dates-v1#"
HEADER_BYTES = 65_536
READ_WORKERS = 16
MAX_READS_PER_RUN = 5_000
READ_BUDGET_SECONDS = 120
EXIF_DATE_RE = re.compile(r"^(\d{4}):(\d{2}):(\d{2})[ T]\d{2}:\d{2}:\d{2}")
ISO_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
EARLIEST_YEAR = 1990


def _valid_day(year, month, day):
    try:
        parsed = dt.date(int(year), int(month), int(day))
    except ValueError:
        return None
    if parsed.year < EARLIEST_YEAR or parsed > dt.date.today() + dt.timedelta(days=1):
        return None
    return parsed.isoformat()


def exif_day(value):
    """'2026:09:12 18:40:03' -> '2026-09-12'; None for blank, zeroed or impossible dates."""
    match = EXIF_DATE_RE.match(str(value or "").strip())
    return _valid_day(*match.groups()) if match else None


def iso_day(value):
    """The calendar day of an ISO date or timestamp, as written."""
    match = ISO_DATE_RE.match(value.strip()) if isinstance(value, str) else None
    return _valid_day(*match.groups()) if match else None


def day_from_tags(tags):
    for name in ("EXIF DateTimeOriginal", "EXIF DateTimeDigitized", "Image DateTime"):
        if name in tags:
            day = exif_day(tags[name])
            if day:
                return day
    return None


def read_capture_day(s3, bucket, key):
    """The capture day from the original's EXIF header; '' when it has none."""
    import exifread

    response = s3.get_object(Bucket=bucket, Key=key, Range=f"bytes=0-{HEADER_BYTES - 1}")
    tags = exifread.process_file(io.BytesIO(response["Body"].read()), details=False)
    return day_from_tags(tags) or ""


def _cached_days(table, album_id):
    item = table.get_item(Key={"cacheKey": f"{CACHE_PREFIX}{album_id}"}).get("Item")
    days = item.get("days") if isinstance(item, dict) else None
    if not isinstance(days, dict):
        return {}
    return {str(key): value for key, value in days.items() if isinstance(value, str) and (value == "" or iso_day(value) == value)}


def _store_days(table, album_id, days):
    table.put_item(Item={"cacheKey": f"{CACHE_PREFIX}{album_id}", "days": days})


def cache_id(key):
    """A short stable id for an original's object key (keys never leave this module)."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]


def _media_key(image):
    if isinstance(image, dict):
        return image.get("rawKey") or image.get("key") or ""
    return image if isinstance(image, str) else ""


def photo_days(albums, table, *, s3=None, bucket=None, clock=time.monotonic, read=read_capture_day):
    """{albumId: [day or None per image]} for public photo albums.

    None means the photo's date is still unknown (no EXIF date, or not read
    yet); the caller counts it on the album's date.
    """
    bucket = bucket or os.environ.get("IMAGES_BUCKET", "")
    s3 = s3 or (boto3.client("s3") if bucket else None)
    results = {}
    pending = []
    caches = {}
    for album in albums:
        album_id = album.get("albumId")
        images = album.get("images") if isinstance(album.get("images"), list) else []
        if not isinstance(album_id, str) or not images:
            continue
        cache = _cached_days(table, album_id)
        caches[album_id] = (cache, dict(cache))
        days = []
        for index, image in enumerate(images):
            exif = image.get("exif") if isinstance(image, dict) else None
            recorded = iso_day((exif or {}).get("takenOn")) if isinstance(exif, dict) else None
            key = _media_key(image)
            media_id = cache_id(key) if key else ""
            if recorded:
                days.append(recorded)
            elif media_id in cache:
                days.append(cache[media_id] or None)
            else:
                days.append(None)
                if key and media_id:
                    pending.append((album_id, index, media_id, key))
        results[album_id] = days

    if pending and s3 and bucket:
        deadline = clock() + READ_BUDGET_SECONDS
        batch = pending[:MAX_READS_PER_RUN]

        def fetch(entry):
            if clock() > deadline:
                return entry, None
            try:
                return entry, read(s3, bucket, entry[3])
            except Exception as error:
                # Object keys can carry personal names; log only the error type.
                logger.warning("capture_date_read_failed error_type=%s", type(error).__name__)
                return entry, None

        with ThreadPoolExecutor(max_workers=READ_WORKERS) as executor:
            for (album_id, index, media_id, _key), day in executor.map(fetch, batch):
                if day is None:
                    continue
                caches[album_id][0][media_id] = day
                if day:
                    results[album_id][index] = day

    for album_id, (cache, original) in caches.items():
        if cache != original:
            try:
                _store_days(table, album_id, cache)
            except Exception as error:
                logger.warning("capture_date_cache_write_failed error_type=%s", type(error).__name__)
    if pending:
        logger.info("capture_dates_pending=%d read_limit=%d", len(pending), MAX_READS_PER_RUN)
    return results
