"""Admin-only report over anonymous daily analytics aggregates."""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from decimal import Decimal
import logging
import os
from zoneinfo import ZoneInfo

import boto3
from boto3.dynamodb.conditions import Key

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import require_admin
from front_door import verify_front_door_request
from response_helpers import error_response, internal_error, json_response


logger = logging.getLogger("photography_api.analytics_report")
logger.setLevel(logging.INFO)

ALLOWED_RANGES = {7, 30, 90, 365}
MAX_QUERY_PAGES_PER_MONTH = 20

dynamodb = boto3.resource("dynamodb")
analytics_table = dynamodb.Table(os.environ["ANALYTICS_TABLE"])
albums_table_name = os.environ["ALBUMS_TABLE"]


def _today():
    timezone_name = os.environ.get("ANALYTICS_TIMEZONE", "America/Los_Angeles")
    return dt.datetime.now(ZoneInfo(timezone_name)).date()


def _requested_days(event):
    params = (event or {}).get("queryStringParameters") or {}
    if not isinstance(params, dict):
        return None
    raw = params.get("range", "30")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value in ALLOWED_RANGES else None


def _months_between(start, end):
    cursor = start.replace(day=1)
    result = []
    while cursor <= end:
        result.append(cursor.strftime("%Y-%m"))
        month_index = cursor.year * 12 + cursor.month
        cursor = dt.date(month_index // 12, month_index % 12 + 1, 1)
    return result


def _query_rows(start, end):
    rows = []
    for bucket in _months_between(start, end):
        exclusive_start_key = None
        for _ in range(MAX_QUERY_PAGES_PER_MONTH):
            arguments = {
                "KeyConditionExpression": Key("bucket").eq(bucket)
                & Key("metric").between(f"{start.isoformat()}#", f"{end.isoformat()}#\uffff"),
                "ConsistentRead": False,
            }
            if exclusive_start_key:
                arguments["ExclusiveStartKey"] = exclusive_start_key
            response = analytics_table.query(**arguments)
            page = response.get("Items") or []
            if not isinstance(page, list):
                raise ValueError("invalid analytics query result")
            rows.extend(item for item in page if isinstance(item, dict))
            exclusive_start_key = response.get("LastEvaluatedKey")
            if not exclusive_start_key:
                break
        else:
            raise ValueError("analytics query exceeded pagination limit")
    return rows


def _count(item):
    value = item.get("count", 0)
    return int(value) if isinstance(value, (int, Decimal)) and value >= 0 else 0


def _sum(item):
    value = item.get("sum", 0)
    return value if isinstance(value, Decimal) and value.is_finite() and value >= 0 else Decimal("0")


def _album_metadata(album_ids):
    metadata = {}
    identifiers = sorted(album_ids)
    for index in range(0, len(identifiers), 100):
        keys = [{"albumId": value} for value in identifiers[index:index + 100]]
        request = {
            albums_table_name: {
                "Keys": keys,
                "ProjectionExpression": "albumId, title, category, #visibility, #status",
                "ExpressionAttributeNames": {"#visibility": "visibility", "#status": "status"},
                "ConsistentRead": False,
            }
        }
        attempts = 0
        while request and attempts < 4:
            response = dynamodb.batch_get_item(RequestItems=request)
            for album in response.get("Responses", {}).get(albums_table_name, []):
                if (
                    isinstance(album, dict)
                    and album.get("visibility") == "public"
                    and album.get("status", "active") == "active"
                ):
                    album_id = str(album.get("albumId", ""))
                    title = str(album.get("title") or "Untitled album").strip()[:200]
                    category = str(album.get("category") or "Uncategorized").strip()[:100]
                    metadata[album_id] = {"title": title, "category": category}
            request = response.get("UnprocessedKeys") or {}
            attempts += 1
    return metadata


def _rank(values, *, limit=10, label="name", value_label="count"):
    return [
        {label: name, value_label: count}
        for name, count in sorted(values.items(), key=lambda item: (-item[1], item[0].lower()))[:limit]
    ]


def _aggregate(rows, start, end):
    daily = {
        (start + dt.timedelta(days=offset)).isoformat(): {
            "date": (start + dt.timedelta(days=offset)).isoformat(),
            "visits": 0,
            "pageViews": 0,
            "albumViews": 0,
        }
        for offset in range((end - start).days + 1)
    }
    events = defaultdict(int)
    album_views = {"photo": defaultdict(int), "video": defaultdict(int)}
    categories = defaultdict(int)
    sources = defaultdict(int)
    devices = defaultdict(int)
    countries = defaultdict(int)
    vitals = defaultdict(lambda: {"count": 0, "sum": Decimal("0"), "ratings": defaultdict(int)})
    errors = defaultdict(int)
    headline_visits = {"today": 0, "last7Days": 0, "currentMonth": 0}
    last_7_start = end - dt.timedelta(days=6)
    current_month_start = end.replace(day=1)

    for item in rows:
        metric = item.get("metric")
        if not isinstance(metric, str) or "#" not in metric:
            continue
        day, metric_key = metric.split("#", 1)
        if metric_key == "event#site_visit":
            try:
                parsed_day = dt.date.fromisoformat(day)
            except ValueError:
                parsed_day = None
            if parsed_day == end:
                headline_visits["today"] += _count(item)
            if parsed_day is not None and last_7_start <= parsed_day <= end:
                headline_visits["last7Days"] += _count(item)
            if parsed_day is not None and current_month_start <= parsed_day <= end:
                headline_visits["currentMonth"] += _count(item)
        if day not in daily:
            continue
        count = _count(item)
        if metric_key.startswith("event#"):
            name = metric_key[6:]
            events[name] += count
            if name == "site_visit":
                daily[day]["visits"] += count
            elif name == "page_view":
                daily[day]["pageViews"] += count
            elif name == "album_view":
                daily[day]["albumViews"] += count
        elif metric_key.startswith("album#"):
            parts = metric_key.split("#", 2)
            if len(parts) == 3 and parts[1] in album_views:
                album_views[parts[1]][parts[2]] += count
        elif metric_key.startswith("category#"):
            categories[metric_key[9:]] += count
        elif metric_key.startswith("source#"):
            sources[metric_key[7:]] += count
        elif metric_key.startswith("device#"):
            devices[metric_key[7:]] += count
        elif metric_key.startswith("country#"):
            countries[metric_key[8:]] += count
        elif metric_key.startswith("vital#"):
            parts = metric_key.split("#", 2)
            if len(parts) == 3:
                entry = vitals[parts[1]]
                entry["count"] += count
                entry["sum"] += _sum(item)
                entry["ratings"][parts[2]] += count
        elif metric_key.startswith("error#"):
            errors[metric_key[6:]] += count

    all_album_ids = set(album_views["photo"]) | set(album_views["video"])
    metadata = _album_metadata(all_album_ids)

    def ranked_albums(album_type):
        values = []
        for album_id, views in album_views[album_type].items():
            album = metadata.get(album_id)
            if album:
                values.append({"albumId": album_id, **album, "views": views})
        return sorted(values, key=lambda item: (-item["views"], item["title"].lower()))[:10]

    daily_values = list(daily.values())
    weekly = defaultdict(lambda: {"visits": 0, "pageViews": 0, "albumViews": 0})
    monthly = defaultdict(lambda: {"visits": 0, "pageViews": 0, "albumViews": 0})
    for value in daily_values:
        day = dt.date.fromisoformat(value["date"])
        iso_year, iso_week, _ = day.isocalendar()
        week = f"{iso_year}-W{iso_week:02d}"
        month = value["date"][:7]
        for key in ("visits", "pageViews", "albumViews"):
            weekly[week][key] += value[key]
            monthly[month][key] += value[key]

    web_vitals = []
    for metric in ("LCP", "INP", "CLS"):
        entry = vitals.get(metric, {"count": 0, "sum": Decimal("0"), "ratings": {}})
        count = entry["count"]
        web_vitals.append({
            "metric": metric,
            "average": round(float(entry["sum"] / count), 3) if count else None,
            "samples": count,
            "ratings": {
                rating: int(entry["ratings"].get(rating, 0))
                for rating in ("good", "needs-improvement", "poor")
            },
        })

    return {
        "range": {"days": (end - start).days + 1, "start": start.isoformat(), "end": end.isoformat()},
        "visits": {
            **headline_visits,
            "selectedRange": events["site_visit"],
        },
        "totals": {
            "pageViews": events["page_view"],
            "albumViews": events["album_view"],
            "photoDownloads": events["photo_download"],
            "zipRequests": events["zip_request"],
            "contactSubmissions": events["contact_submit"],
            "explorePhotosClicks": events["hero_explore_photos"],
            "exploreVideosClicks": events["hero_explore_videos"],
            "frontendErrors": sum(errors.values()),
        },
        "trends": {
            "daily": daily_values,
            "weekly": [{"period": key, **value} for key, value in sorted(weekly.items())],
            "monthly": [{"period": key, **value} for key, value in sorted(monthly.items())],
        },
        "albums": {"photo": ranked_albums("photo"), "video": ranked_albums("video")},
        "categories": _rank(categories, label="category", value_label="views"),
        "sources": _rank(sources),
        "devices": _rank(devices),
        "countries": _rank(countries, limit=15, label="countryCode"),
        "webVitals": web_vitals,
        "frontendErrors": [
            {"kind": name, "count": count}
            for name, count in sorted(errors.items(), key=lambda item: (-item[1], item[0]))
        ],
    }


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    denied = require_admin(event)
    if denied:
        return denied
    days = _requested_days(event)
    if days is None:
        return error_response(400, "range must be 7, 30, 90, or 365", code="invalid_analytics_range")
    try:
        end = _today()
        start = end - dt.timedelta(days=days - 1)
        query_start = min(start, end - dt.timedelta(days=6), end.replace(day=1))
        report = _aggregate(_query_rows(query_start, end), start, end)
        report["generatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        actor_type, auth_method = actor_context(event)
        emit_audit_event(
            event_name="analytics.report", outcome="success", action="analytics.report.view",
            resource_type="aggregate_telemetry", reason_code=f"range_{days}", event=event,
            context=context, actor_type=actor_type, auth_method=auth_method,
        )
        return json_response(200, report)
    except Exception as error:
        return internal_error(context, error, "analytics_report")
