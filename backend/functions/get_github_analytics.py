"""Admin-only cached GitHub repository analytics endpoint."""

from __future__ import annotations

import copy
import datetime as dt
import logging

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import require_admin
from front_door import verify_front_door_request
from github_analytics import load_cached_report
from response_helpers import error_response, json_response


logger = logging.getLogger("photography_api.github_analytics_api")
logger.setLevel(logging.INFO)


def _cache_status(report):
    try:
        generated = dt.datetime.fromisoformat(report["generatedAt"].replace("Z", "+00:00"))
        return "fresh" if dt.datetime.now(dt.timezone.utc) - generated <= dt.timedelta(hours=3) else "stale"
    except (KeyError, TypeError, ValueError):
        return "stale"


def _next_refresh():
    now = dt.datetime.now(dt.timezone.utc)
    return (now.replace(minute=20, second=0, microsecond=0) + dt.timedelta(hours=1 if now.minute >= 20 else 0)).isoformat().replace("+00:00", "Z")


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied
    try:
        report = load_cached_report()
        if report is None:
            return error_response(503, "The GitHub analytics snapshot is being prepared. Please try again shortly.", code="github_analytics_preparing")
        status = _cache_status(report)
        result = copy.deepcopy(report)
        result["cacheStatus"] = status
        result["nextRefreshAt"] = _next_refresh()
        actor_type, auth_method = actor_context(event)
        emit_audit_event(
            event_name="provider.github_analytics",
            outcome="success",
            action="provider.github_analytics.view",
            resource_type="provider",
            reason_code=f"{status}_report",
            event=event,
            context=context,
            actor_type=actor_type,
            auth_method=auth_method,
            severity="warning" if status == "stale" else "info",
        )
        return json_response(200, result)
    except Exception as error:
        request_id = getattr(context, "aws_request_id", "unknown") if context else "unknown"
        logger.error("github_analytics_cache_failed request_id=%s error_type=%s", request_id, type(error).__name__)
        return error_response(503, "The GitHub analytics snapshot is temporarily unavailable.", code="github_analytics_unavailable")
