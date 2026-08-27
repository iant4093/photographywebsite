"""Admin-only operational health for the Ian Truong Photography stack."""

from __future__ import annotations

import datetime as dt
import http.client
import logging
import os
import re
import time
from urllib.parse import urlencode, urlsplit

import boto3

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import require_admin
from front_door import verify_front_door_request
from response_helpers import json_response


logger = logging.getLogger("photography_api.site_health")
logger.setLevel(logging.INFO)
cloudformation = boto3.client("cloudformation")
cloudwatch = boto3.client("cloudwatch")

_HEALTHY_STACK_STATUSES = {"CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"}
_ALARM_SUFFIX = re.compile(r"-[A-Za-z0-9]{8,}$")


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _label_alarm(name):
    stack_prefix = f"{os.environ.get('STACK_NAME', '')}-"
    value = name.removeprefix(stack_prefix)
    value = _ALARM_SUFFIX.sub("", value).removesuffix("Alarm")
    return re.sub(r"(?<!^)(?=[A-Z])", " ", value).strip() or "Operational alarm"


def _public_check(check_id, label, path, method="GET"):
    base = urlsplit(os.environ["FRONTEND_URL"])
    if base.scheme != "https" or not base.hostname or base.username or base.password or base.port not in {None, 443}:
        raise ValueError("Invalid configured frontend URL")
    target_path = f"{base.path.rstrip('/')}{path}" or "/"
    started = time.monotonic()
    connection = http.client.HTTPSConnection(base.hostname, 443, timeout=4)
    try:
        connection.request(method, target_path, headers={"User-Agent": "IanTruongPhotography-SiteHealth/1.0"})
        response = connection.getresponse()
        response.read(1024)
        latency_ms = round((time.monotonic() - started) * 1000)
        healthy = 200 <= response.status < 400
        return {
            "id": check_id,
            "label": label,
            "status": "healthy" if healthy else "incident",
            "detail": f"HTTP {response.status}",
            "latencyMs": latency_ms,
        }
    except Exception as error:
        logger.warning("site_health_check_failed check=%s error_type=%s", check_id, type(error).__name__)
        return {"id": check_id, "label": label, "status": "incident", "detail": "Unavailable", "latencyMs": None}
    finally:
        connection.close()


def _stack_check():
    try:
        stack = cloudformation.describe_stacks(StackName=os.environ["STACK_NAME"])["Stacks"][0]
        status = stack.get("StackStatus", "UNKNOWN")
        return {
            "id": "infrastructure",
            "label": "AWS infrastructure",
            "status": "healthy" if status in _HEALTHY_STACK_STATUSES else "incident",
            "detail": status.replace("_", " ").title(),
            "latencyMs": None,
        }
    except Exception as error:
        logger.warning("site_health_stack_failed error_type=%s", type(error).__name__)
        return {"id": "infrastructure", "label": "AWS infrastructure", "status": "unknown", "detail": "Status unavailable", "latencyMs": None}


def _alarms():
    try:
        response = cloudwatch.describe_alarms(AlarmNamePrefix=f"{os.environ['STACK_NAME']}-", MaxRecords=100)
        alarms = []
        for alarm in response.get("MetricAlarms", []):
            alarms.append({
                "name": _label_alarm(alarm.get("AlarmName", "")),
                "description": str(alarm.get("AlarmDescription") or "Website operational alarm"),
                "state": str(alarm.get("StateValue") or "INSUFFICIENT_DATA"),
                "updatedAt": alarm.get("StateUpdatedTimestamp").isoformat().replace("+00:00", "Z") if alarm.get("StateUpdatedTimestamp") else None,
            })
        alarms.sort(key=lambda item: ({"ALARM": 0, "INSUFFICIENT_DATA": 1, "OK": 2}.get(item["state"], 1), item["name"]))
        return alarms, None
    except Exception as error:
        logger.warning("site_health_alarms_failed error_type=%s", type(error).__name__)
        return [], "Alarm status unavailable"


def _overall(checks, alarms, alarm_error):
    if any(check["status"] == "incident" for check in checks) or any(alarm["state"] == "ALARM" for alarm in alarms):
        return "incident"
    if alarm_error or any(check["status"] == "unknown" for check in checks) or any(alarm["state"] == "INSUFFICIENT_DATA" for alarm in alarms):
        return "degraded"
    return "healthy"


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied

    query = urlencode({"type": "photo", "limit": 1})
    checks = [
        _public_check("website", "Public website", "/", method="HEAD"),
        _public_check("api", "Public album API", f"/api/albums?{query}"),
        _stack_check(),
    ]
    alarms, alarm_error = _alarms()
    overall = _overall(checks, alarms, alarm_error)
    actor_type, auth_method = actor_context(event)
    emit_audit_event(
        event_name="provider.site_health",
        outcome="success",
        action="provider.site_health.view",
        resource_type="provider",
        reason_code=f"{overall}_report",
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        severity="warning" if overall != "healthy" else "info",
    )
    active = sum(alarm["state"] == "ALARM" for alarm in alarms)
    unknown = sum(alarm["state"] == "INSUFFICIENT_DATA" for alarm in alarms)
    return json_response(200, {
        "schemaVersion": 1,
        "generatedAt": _now(),
        "overall": overall,
        "summary": {
            "checksPassing": sum(check["status"] == "healthy" for check in checks),
            "checksTotal": len(checks),
            "activeAlarms": active,
            "unknownAlarms": unknown,
            "monitoredAlarms": len(alarms),
        },
        "checks": checks,
        "alarms": alarms,
        "alarmError": alarm_error,
    })
