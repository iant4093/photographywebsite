"""Privacy-safe public photography statistics built once per day."""

from __future__ import annotations

from collections import Counter
import datetime as dt
import json
import logging
import os
import re

import boto3

from front_door import verify_front_door_request
from response_helpers import error_response, internal_error, json_response


logger = logging.getLogger("photography_api.photography_stats")
logger.setLevel(logging.INFO)

DRIVE_CACHE_KEY = "google-drive-usage-v2"
STATS_CACHE_KEY = "photography-stats-v1"
STATS_SCHEMA_VERSION = 1
MAX_CACHE_PAYLOAD_BYTES = 100_000
MAX_ALBUM_SCAN_PAGES = 100
MAX_TEXT_LENGTH = 200
MANUAL_LENS_FALLBACK = "Sirui Nightwalker 75mm T1.2"
YEAR_RE = re.compile(r"^(19|20|21)\d{2}")

cache_table = boto3.resource("dynamodb").Table(os.environ["DRIVE_USAGE_CACHE_TABLE"])
albums_table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])


def _nonnegative_int(value):
    if isinstance(value, bool):
        raise ValueError("Aggregate value is invalid")
    parsed = int(value)
    if parsed < 0:
        raise ValueError("Aggregate value is invalid")
    return parsed


def _aggregate_category(report, backup_name, category_name):
    backup = report.get(backup_name)
    categories = backup.get("categories") if isinstance(backup, dict) else None
    category = categories.get(category_name) if isinstance(categories, dict) else None
    if not isinstance(category, dict):
        raise ValueError("Drive aggregate is unavailable")
    return {
        "bytes": _nonnegative_int(category.get("bytes")),
        "fileCount": _nonnegative_int(category.get("fileCount")),
    }


def _read_drive_report():
    item = cache_table.get_item(
        Key={"cacheKey": DRIVE_CACHE_KEY},
        ConsistentRead=True,
    ).get("Item")
    if not isinstance(item, dict):
        raise ValueError("Drive report is unavailable")
    payload = item.get("payload")
    if not isinstance(payload, str) or not 1 <= len(payload.encode("utf-8")) <= MAX_CACHE_PAYLOAD_BYTES:
        raise ValueError("Drive report is invalid")
    try:
        report = json.loads(payload)
    except (TypeError, ValueError):
        raise ValueError("Drive report is invalid") from None
    if not isinstance(report, dict) or not isinstance(report.get("generatedAt"), str):
        raise ValueError("Drive report is invalid")
    return report


def _scan_albums():
    items = []
    start_key = None
    for _page in range(MAX_ALBUM_SCAN_PAGES):
        arguments = {
            "ProjectionExpression": (
                "#visibility, #status, #type, #createdAt, #category, #images, #imageCount"
            ),
            "ExpressionAttributeNames": {
                "#visibility": "visibility",
                "#status": "status",
                "#type": "type",
                "#createdAt": "createdAt",
                "#category": "category",
                "#images": "images",
                "#imageCount": "imageCount",
            },
        }
        if start_key:
            arguments["ExclusiveStartKey"] = start_key
        response = albums_table.scan(**arguments)
        page_items = response.get("Items", [])
        if not isinstance(page_items, list):
            raise ValueError("Album inventory is invalid")
        items.extend(item for item in page_items if isinstance(item, dict))
        start_key = response.get("LastEvaluatedKey")
        if not start_key:
            return items
    raise ValueError("Album inventory pagination exceeded safe limit")


def _normalized_text(value, fallback=""):
    if not isinstance(value, str):
        return fallback
    normalized = " ".join(value.strip().split())
    return normalized[:MAX_TEXT_LENGTH] or fallback


def _album_year(value):
    if not isinstance(value, str):
        return None
    match = YEAR_RE.match(value.strip())
    return int(match.group(0)) if match else None


def _media_items(album):
    images = album.get("images")
    return images if isinstance(images, list) else []


def _media_count(album):
    images = album.get("images")
    if isinstance(images, list):
        return len(images)
    try:
        return _nonnegative_int(album.get("imageCount", 0))
    except (TypeError, ValueError):
        return 0


def _percent(kept, taken):
    return round((kept / taken) * 100, 1) if taken else 0.0


def _counter_rows(counter):
    return [
        {"name": name, "photos": count}
        for name, count in sorted(counter.items(), key=lambda item: (-item[1], item[0].casefold()))
    ]


def _build_snapshot(drive_report, albums, generated_at=None):
    raw_images = _aggregate_category(drive_report, "rawPhotoBackup", "images")
    raw_videos = _aggregate_category(drive_report, "rawPhotoBackup", "videos")
    website_photos = _aggregate_category(drive_report, "websiteBackup", "photos")
    website_videos = _aggregate_category(drive_report, "websiteBackup", "videos")

    photo_albums = 0
    video_albums = 0
    photos_kept = 0
    videos_kept = 0
    years = {}
    categories = {}
    cameras = Counter()
    lenses = Counter()

    for album in albums:
        if album.get("visibility") != "public" or album.get("status", "active") != "active":
            continue
        album_type = "video" if album.get("type") == "video" else "photo"
        media_count = _media_count(album)
        if album_type == "video":
            video_albums += 1
            videos_kept += media_count
        else:
            photo_albums += 1
            photos_kept += media_count

        year = _album_year(album.get("createdAt"))
        if year is not None:
            year_row = years.setdefault(year, {
                "year": year,
                "photoAlbums": 0,
                "photos": 0,
                "videoAlbums": 0,
                "videos": 0,
            })
            if album_type == "video":
                year_row["videoAlbums"] += 1
                year_row["videos"] += media_count
            else:
                year_row["photoAlbums"] += 1
                year_row["photos"] += media_count

        category_name = _normalized_text(album.get("category"), "Uncategorized")
        category_key = category_name.casefold()
        category_row = categories.setdefault(category_key, {
            "category": category_name,
            "albums": 0,
            "photos": 0,
            "videos": 0,
        })
        category_row["albums"] += 1
        category_row["videos" if album_type == "video" else "photos"] += media_count

        if album_type == "photo":
            for media in _media_items(album):
                exif = media.get("exif") if isinstance(media, dict) else None
                exif = exif if isinstance(exif, dict) else {}
                camera = _normalized_text(exif.get("model"))
                lens = _normalized_text(exif.get("lens"), MANUAL_LENS_FALLBACK)
                if camera:
                    cameras[camera] += 1
                lenses[lens] += 1

    output_by_year = sorted(years.values(), key=lambda row: row["year"])
    category_rows = sorted(
        categories.values(),
        key=lambda row: (-(row["photos"] + row["videos"]), row["category"].casefold()),
    )
    most_active_year = max(
        output_by_year,
        key=lambda row: (row["photos"] + row["videos"], row["year"]),
        default=None,
    )
    most_active_category = category_rows[0] if category_rows else None
    timestamp = generated_at or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    return {
        "schemaVersion": STATS_SCHEMA_VERSION,
        "generatedAt": timestamp,
        "sourceGeneratedAt": drive_report["generatedAt"],
        "taken": {
            "photos": raw_images["fileCount"],
            "videos": raw_videos["fileCount"],
        },
        "kept": {
            "photos": photos_kept,
            "videos": videos_kept,
            "photoPercent": _percent(photos_kept, raw_images["fileCount"]),
            "videoPercent": _percent(videos_kept, raw_videos["fileCount"]),
        },
        "storage": {
            "totalBytes": sum(category["bytes"] for category in (
                raw_images, raw_videos, website_photos, website_videos
            )),
        },
        "albums": {
            "photos": photo_albums,
            "videos": video_albums,
        },
        "outputByYear": output_by_year,
        "categories": category_rows,
        "mostActive": {
            "year": most_active_year,
            "category": most_active_category,
        },
        "gear": {
            "cameras": _counter_rows(cameras),
            "lenses": _counter_rows(lenses),
            "manualLensFallback": MANUAL_LENS_FALLBACK,
        },
    }


def _is_nonnegative_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and value >= 0


def _valid_snapshot(snapshot):
    if not isinstance(snapshot, dict) or snapshot.get("schemaVersion") != STATS_SCHEMA_VERSION:
        return False
    if not all(isinstance(snapshot.get(field), str) and snapshot[field] for field in ("generatedAt", "sourceGeneratedAt")):
        return False
    taken = snapshot.get("taken")
    kept = snapshot.get("kept")
    storage = snapshot.get("storage")
    albums = snapshot.get("albums")
    if not all(isinstance(value, dict) for value in (taken, kept, storage, albums)):
        return False
    if not all(_is_nonnegative_number(taken.get(field)) for field in ("photos", "videos")):
        return False
    if not all(_is_nonnegative_number(kept.get(field)) for field in ("photos", "videos", "photoPercent", "videoPercent")):
        return False
    if not _is_nonnegative_number(storage.get("totalBytes")):
        return False
    if not all(_is_nonnegative_number(albums.get(field)) for field in ("photos", "videos")):
        return False
    if not isinstance(snapshot.get("outputByYear"), list) or not isinstance(snapshot.get("categories"), list):
        return False
    most_active = snapshot.get("mostActive")
    gear = snapshot.get("gear")
    return (
        isinstance(most_active, dict)
        and isinstance(gear, dict)
        and isinstance(gear.get("cameras"), list)
        and isinstance(gear.get("lenses"), list)
        and gear.get("manualLensFallback") == MANUAL_LENS_FALLBACK
    )


def _store_snapshot(snapshot):
    payload = json.dumps(snapshot, separators=(",", ":"), sort_keys=True)
    if len(payload.encode("utf-8")) > MAX_CACHE_PAYLOAD_BYTES:
        raise ValueError("Photography statistics cache payload exceeded safe limit")
    cache_table.put_item(Item={
        "cacheKey": STATS_CACHE_KEY,
        "schemaVersion": STATS_SCHEMA_VERSION,
        "cacheDate": snapshot["generatedAt"][:10],
        "payload": payload,
    })


def _read_snapshot():
    item = cache_table.get_item(Key={"cacheKey": STATS_CACHE_KEY}).get("Item")
    if not isinstance(item, dict):
        return None
    payload = item.get("payload")
    if not isinstance(payload, str) or not 1 <= len(payload.encode("utf-8")) <= MAX_CACHE_PAYLOAD_BYTES:
        return None
    try:
        snapshot = json.loads(payload)
    except (TypeError, ValueError):
        return None
    return snapshot if _valid_snapshot(snapshot) else None


def refresh_photography_stats():
    drive_report = _read_drive_report()
    snapshot = _build_snapshot(drive_report, _scan_albums())
    _store_snapshot(snapshot)
    logger.info("photography_stats_refresh_succeeded")
    return snapshot


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    try:
        if (event or {}).get("queryStringParameters"):
            return error_response(400, "Photography statistics do not accept query parameters", code="invalid_request")
        snapshot = _read_snapshot()
        if snapshot is None:
            return error_response(
                503,
                "Photography statistics are being prepared. Please try again shortly.",
                code="stats_preparing",
            )
        return json_response(
            200,
            snapshot,
            cache_control="public, max-age=300, s-maxage=86400, stale-while-revalidate=3600",
        )
    except Exception as error:
        return internal_error(context, error, "get_photography_stats")
