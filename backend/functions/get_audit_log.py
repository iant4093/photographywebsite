"""Admin-only reader for privacy-safe application audit events."""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import time

import boto3

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import require_admin
from front_door import verify_front_door_request
from response_helpers import error_response, json_response


logger = logging.getLogger("photography_api.audit_log")
logger.setLevel(logging.INFO)
logs = boto3.client("logs")

_ALLOWED_WINDOWS = {1, 7, 30}
_EVENT_FIELDS = (
    "timestamp", "event_name", "outcome", "severity", "actor_type", "auth_method",
    "action", "resource_type", "reason_code", "release_sha", "details",
)


def _window_days(event):
    params = (event or {}).get("queryStringParameters") or {}
    try:
        days = int(params.get("days", 7))
    except (TypeError, ValueError):
        days = 0
    if days not in _ALLOWED_WINDOWS:
        raise ValueError("Invalid audit window")
    return days


def _parse_record(message):
    try:
        outer = json.loads(message)
        inner = outer.get("message") if isinstance(outer, dict) else None
        record = json.loads(inner) if isinstance(inner, str) else outer
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict) or record.get("record_type") != "security_audit":
        return None
    result = {field: record.get(field) for field in _EVENT_FIELDS if record.get(field) is not None}
    return result if all(result.get(field) for field in ("timestamp", "event_name", "outcome", "action", "resource_type", "reason_code")) else None


def _query_events(days):
    end = dt.datetime.now(dt.timezone.utc)
    started = logs.start_query(
        logGroupName=os.environ["APPLICATION_LOG_GROUP"],
        startTime=int((end - dt.timedelta(days=days)).timestamp()),
        endTime=int(end.timestamp()) + 1,
        queryString="fields @timestamp, @message | filter @message like /security_audit/ | sort @timestamp desc | limit 200",
        limit=200,
    )
    query_id = started["queryId"]
    response = None
    for _ in range(30):
        response = logs.get_query_results(queryId=query_id)
        if response.get("status") in {"Complete", "Failed", "Cancelled", "Timeout", "Unknown"}:
            break
        time.sleep(0.1)
    if not response or response.get("status") != "Complete":
        raise RuntimeError("Audit query did not complete")
    events = []
    for row in response.get("results", []):
        fields = {entry.get("field"): entry.get("value") for entry in row}
        record = _parse_record(fields.get("@message"))
        if record:
            events.append(record)
    return events, int(float((response.get("statistics") or {}).get("bytesScanned", 0)))


def _counts(events, key):
    values = {}
    for event in events:
        value = str(event.get(key) or "unknown")
        values[value] = values.get(value, 0) + 1
    return values


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied
    try:
        days = _window_days(event)
        events, bytes_scanned = _query_events(days)
        actor_type, auth_method = actor_context(event)
        emit_audit_event(
            event_name="provider.audit_log",
            outcome="success",
            action="provider.audit_log.view",
            resource_type="provider",
            reason_code="events_returned",
            event=event,
            context=context,
            actor_type=actor_type,
            auth_method=auth_method,
        )
        return json_response(200, {
            "schemaVersion": 1,
            "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "windowDays": days,
            "limited": len(events) >= 200,
            "events": events,
            "summary": {
                "returned": len(events),
                "outcomes": _counts(events, "outcome"),
                "actors": _counts(events, "actor_type"),
                "resources": _counts(events, "resource_type"),
                "bytesScanned": bytes_scanned,
            },
        })
    except ValueError:
        return error_response(400, "Choose a supported audit window.", code="invalid_audit_window")
    except Exception as error:
        request_id = getattr(context, "aws_request_id", "unknown") if context else "unknown"
        logger.error("audit_log_query_failed request_id=%s error_type=%s", request_id, type(error).__name__)
        return error_response(503, "The audit log is temporarily unavailable.", code="audit_log_unavailable")
