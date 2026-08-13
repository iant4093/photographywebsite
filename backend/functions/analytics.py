"""Privacy-preserving, first-party aggregate analytics ingestion."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal, InvalidOperation
import logging
import os
import re
from zoneinfo import ZoneInfo

import boto3

from front_door import verify_front_door_request
from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit
from validation_helpers import ValidationError, parse_json_body, validate_uuid


logger = logging.getLogger("photography_api.analytics")
logger.setLevel(logging.INFO)

MAX_EVENTS = 20
RETENTION_DAYS = 400
ALLOWED_SOURCES = {"direct", "search", "instagram", "github", "other"}
ALLOWED_DEVICES = {"mobile", "tablet", "desktop"}
ALLOWED_VITALS = {"LCP", "CLS", "INP"}
ALLOWED_RATINGS = {"good", "needs-improvement", "poor"}
ALLOWED_ERROR_KINDS = {"resource", "runtime", "unhandled-rejection"}
SIMPLE_EVENTS = {
    "page_view",
    "contact_submit",
    "hero_explore_photos",
    "hero_explore_videos",
}
ALBUM_EVENTS = {"album_view", "photo_download", "zip_request"}
COUNTRY_PATTERN = re.compile(r"^[A-Z]{2}$")

analytics_table = boto3.resource("dynamodb").Table(os.environ["ANALYTICS_TABLE"])
albums_table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])


def _headers(event):
    values = (event or {}).get("headers") or {}
    if not isinstance(values, dict):
        return {}
    return {str(key).lower(): value for key, value in values.items()}


def _validate_origin(event):
    expected = os.environ.get("FRONTEND_URL", "https://iantruongphotography.com").rstrip("/")
    origin = _headers(event).get("origin")
    if not isinstance(origin, str) or origin.rstrip("/") != expected:
        raise ValidationError("Analytics origin was not accepted")


def _local_day():
    timezone_name = os.environ.get("ANALYTICS_TIMEZONE", "America/Los_Angeles")
    return dt.datetime.now(ZoneInfo(timezone_name)).date()


def _country(event):
    value = str(_headers(event).get("cloudfront-viewer-country", "XX")).upper()
    return value if COUNTRY_PATTERN.fullmatch(value) else "XX"


def _event_keys(event):
    return set(event) if isinstance(event, dict) else set()


def _require_exact_keys(event, allowed):
    if not isinstance(event, dict) or _event_keys(event) != set(allowed):
        raise ValidationError("Analytics event fields were invalid")


def _decimal_value(value):
    if isinstance(value, bool):
        raise ValidationError("Web Vital value was invalid")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise ValidationError("Web Vital value was invalid") from None
    if not result.is_finite() or result < 0 or result > Decimal("100000"):
        raise ValidationError("Web Vital value was invalid")
    return result.quantize(Decimal("0.001"))


def _public_album(album_id, cache):
    album_id = validate_uuid(album_id)
    if album_id not in cache:
        response = albums_table.get_item(
            Key={"albumId": album_id},
            ProjectionExpression="albumId, #visibility, #status, #type, category",
            ExpressionAttributeNames={
                "#visibility": "visibility",
                "#status": "status",
                "#type": "type",
            },
            ConsistentRead=False,
        )
        album = response.get("Item")
        if (
            not isinstance(album, dict)
            or album.get("visibility") != "public"
            or album.get("status", "active") != "active"
        ):
            raise ValidationError("Public album was not found")
        album_type = "video" if album.get("type") == "video" else "photo"
        category = str(album.get("category") or "Uncategorized").strip()[:100] or "Uncategorized"
        cache[album_id] = {"albumId": album_id, "type": album_type, "category": category}
    return cache[album_id]


def _add_counter(counters, metric_key, *, count=1, value=Decimal("0")):
    current = counters.setdefault(metric_key, {"count": 0, "sum": Decimal("0")})
    current["count"] += count
    current["sum"] += value


def _validate_and_aggregate(events, country):
    counters = {}
    album_cache = {}
    site_visits = 0
    for event in events:
        if not isinstance(event, dict):
            raise ValidationError("Analytics events must be objects")
        name = event.get("name")
        if name in SIMPLE_EVENTS:
            _require_exact_keys(event, {"name"})
            _add_counter(counters, f"event#{name}")
            continue

        if name == "site_visit":
            _require_exact_keys(event, {"name", "source", "device"})
            source = event.get("source")
            device = event.get("device")
            if source not in ALLOWED_SOURCES or device not in ALLOWED_DEVICES:
                raise ValidationError("Visit dimensions were invalid")
            site_visits += 1
            if site_visits > 1:
                raise ValidationError("Only one site visit is accepted per batch")
            _add_counter(counters, "event#site_visit")
            _add_counter(counters, f"source#{source}")
            _add_counter(counters, f"device#{device}")
            _add_counter(counters, f"country#{country}")
            continue

        if name in ALBUM_EVENTS:
            _require_exact_keys(event, {"name", "albumId"})
            album = _public_album(event.get("albumId"), album_cache)
            if name in {"photo_download", "zip_request"} and album["type"] != "photo":
                raise ValidationError("Photo event album type was invalid")
            _add_counter(counters, f"event#{name}")
            if name == "album_view":
                _add_counter(counters, f"album#{album['type']}#{album['albumId']}")
                _add_counter(counters, f"category#{album['category']}")
            continue

        if name == "web_vital":
            _require_exact_keys(event, {"name", "metric", "value", "rating"})
            metric = event.get("metric")
            rating = event.get("rating")
            if metric not in ALLOWED_VITALS or rating not in ALLOWED_RATINGS:
                raise ValidationError("Web Vital dimensions were invalid")
            _add_counter(counters, f"vital#{metric}#{rating}", value=_decimal_value(event.get("value")))
            continue

        if name == "frontend_error":
            _require_exact_keys(event, {"name", "kind"})
            kind = event.get("kind")
            if kind not in ALLOWED_ERROR_KINDS:
                raise ValidationError("Frontend error kind was invalid")
            _add_counter(counters, f"error#{kind}")
            continue

        raise ValidationError("Analytics event name was invalid")
    return counters


def _store_counters(counters, day):
    bucket = day.strftime("%Y-%m")
    ttl = int((dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=RETENTION_DAYS)).timestamp())
    for metric_key, aggregate in counters.items():
        names = {"#count": "count", "#ttl": "ttl"}
        values = {":count": aggregate["count"], ":ttl": ttl}
        update = "SET #ttl = :ttl ADD #count :count"
        if aggregate["sum"]:
            names["#sum"] = "sum"
            values[":sum"] = aggregate["sum"]
            update = "SET #ttl = :ttl ADD #count :count, #sum :sum"
        analytics_table.update_item(
            Key={"bucket": bucket, "metric": f"{day.isoformat()}#{metric_key}"},
            UpdateExpression=update,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    try:
        _validate_origin(event)
        source_ip = str(((event or {}).get("requestContext", {}).get("http", {}).get("sourceIp") or "unknown"))[:64]
        if not check_rate_limit(source_ip, "analytics", max_requests=60, window_seconds=60, fail_closed=True):
            return error_response(429, "Too many analytics requests", code="rate_limited")
        body = parse_json_body(event, max_bytes=16 * 1024)
        if set(body) != {"events"} or not isinstance(body.get("events"), list):
            raise ValidationError("events must be an array")
        events = body["events"]
        if not 1 <= len(events) <= MAX_EVENTS:
            raise ValidationError(f"events must contain between 1 and {MAX_EVENTS} items")
        counters = _validate_and_aggregate(events, _country(event))
        _store_counters(counters, _local_day())
        return json_response(202, {"accepted": len(events)})
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_analytics_event")
    except Exception as error:
        return internal_error(context, error, "analytics_ingest")
