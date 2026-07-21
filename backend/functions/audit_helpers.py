"""Strict, privacy-safe security audit events for Lambda handlers.

Audit records are intentionally small and contain no caller/resource identifiers.
The builder raises on schema violations so tests catch unsafe additions; the emitter
swallows those violations so an observability failure never breaks user actions.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import re


logger = logging.getLogger("photography_api.audit")
logger.setLevel(logging.INFO)

SCHEMA_VERSION = 1
_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$")
_CODE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_CORRELATION_PATTERN = re.compile(r"^[A-Za-z0-9_./:;=+-]{1,256}$")
_ENVIRONMENT_PATTERN = re.compile(r"^[a-z0-9-]{1,32}$")
_RELEASE_PATTERN = re.compile(r"^(?:unknown|[A-Fa-f0-9]{7,64})$")

OUTCOMES = frozenset({"success", "denied", "failure"})
SEVERITIES = frozenset({"info", "warning", "error"})
ACTOR_TYPES = frozenset({"anonymous", "user", "admin", "service", "ci"})
AUTH_METHODS = frozenset({"none", "jwt", "share_grant", "oidc", "service"})
RESOURCE_TYPES = frozenset({
    "authentication",
    "authorization",
    "user",
    "album",
    "media",
    "download",
    "archive",
    "contact",
    "provider",
})

# Details are aggregate/enumerated operational facts only. Never add identifiers,
# user input, paths, object keys, URLs, provider errors, or request data here.
_DETAIL_TYPES = {
    "album_count": int,
    "deleted_count": int,
    "deleted_version_count": int,
    "media_count": int,
    "http_status": int,
    "challenge_type": str,
    "visibility": str,
    "previous_visibility": str,
    "zip_state": str,
}
_DETAIL_ENUMS = {
    "challenge_type": frozenset({"new_password_required", "software_token_mfa", "other"}),
    "visibility": frozenset({"public", "private", "unlisted", "unknown"}),
    "previous_visibility": frozenset({"public", "private", "unlisted", "unknown"}),
    "zip_state": frozenset({"ready", "processing"}),
}
_FORBIDDEN_FRAGMENTS = (
    "authorization",
    "body",
    "code",
    "cookie",
    "credential",
    "email",
    "exception",
    "identifier",
    "key",
    "message",
    "name",
    "password",
    "prefix",
    "secret",
    "session",
    "subject",
    "token",
    "url",
)


def _utc_timestamp() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _require_pattern(value, field, pattern):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f"Invalid audit {field}")
    return value


def _request_id(event, context):
    candidate = getattr(context, "aws_request_id", "") if context else ""
    if not candidate:
        candidate = str(((event or {}).get("requestContext") or {}).get("requestId") or "")
    if candidate and _CORRELATION_PATTERN.fullmatch(candidate):
        return candidate[:256]
    return "unknown"


def _trace_id():
    candidate = os.environ.get("_X_AMZN_TRACE_ID", "")
    return candidate[:256] if candidate and _CORRELATION_PATTERN.fullmatch(candidate) else "unknown"


def _validated_details(details):
    if details is None:
        return None
    if not isinstance(details, dict) or len(details) > len(_DETAIL_TYPES):
        raise ValueError("Invalid audit details")
    validated = {}
    for key, value in details.items():
        lowered = str(key).lower()
        if key not in _DETAIL_TYPES or any(fragment in lowered for fragment in _FORBIDDEN_FRAGMENTS):
            raise ValueError("Forbidden audit detail field")
        expected_type = _DETAIL_TYPES[key]
        if expected_type is int:
            if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 10_000_000:
                raise ValueError("Invalid audit detail value")
        elif not isinstance(value, expected_type) or value not in _DETAIL_ENUMS[key]:
            raise ValueError("Invalid audit detail value")
        validated[key] = value
    return validated or None


def build_audit_event(
    *,
    event_name,
    outcome,
    action,
    resource_type,
    reason_code,
    event=None,
    context=None,
    actor_type="anonymous",
    auth_method="none",
    severity=None,
    details=None,
):
    """Build a validated record. Callers cannot add arbitrary schema fields."""
    _require_pattern(event_name, "event_name", _NAME_PATTERN)
    _require_pattern(action, "action", _NAME_PATTERN)
    _require_pattern(reason_code, "reason_code", _CODE_PATTERN)
    if outcome not in OUTCOMES:
        raise ValueError("Invalid audit outcome")
    if actor_type not in ACTOR_TYPES:
        raise ValueError("Invalid audit actor_type")
    if auth_method not in AUTH_METHODS:
        raise ValueError("Invalid audit auth_method")
    if resource_type not in RESOURCE_TYPES:
        raise ValueError("Invalid audit resource_type")
    selected_severity = severity or {"success": "info", "denied": "warning", "failure": "error"}[outcome]
    if selected_severity not in SEVERITIES:
        raise ValueError("Invalid audit severity")

    environment = os.environ.get("APPLICATION_STAGE", "unknown").strip().lower()
    if environment != "unknown":
        _require_pattern(environment, "environment", _ENVIRONMENT_PATTERN)
    release_sha = os.environ.get("RELEASE_SHA", "unknown").strip()
    _require_pattern(release_sha, "release_sha", _RELEASE_PATTERN)

    record = {
        "schema_version": SCHEMA_VERSION,
        "record_type": "security_audit",
        "timestamp": _utc_timestamp(),
        "event_name": event_name,
        "outcome": outcome,
        "severity": selected_severity,
        "environment": environment,
        "release_sha": release_sha,
        "request_id": _request_id(event, context),
        "trace_id": _trace_id(),
        "actor_type": actor_type,
        "auth_method": auth_method,
        "action": action,
        "resource_type": resource_type,
        "reason_code": reason_code,
    }
    validated_details = _validated_details(details)
    if validated_details:
        record["details"] = validated_details
    return record


def emit_audit_event(**values):
    """Emit one compact JSON record without ever failing the business request."""
    try:
        record = build_audit_event(**values)
        logger.info(json.dumps(record, separators=(",", ":"), sort_keys=True))
        return True
    except Exception:
        # Invalid audit input and logger failures must be caught by tests/alarms,
        # not leak request data or change the business operation's result.
        return False


def actor_context(event):
    """Classify a gateway caller without returning or logging their identity."""
    claims = (
        ((event or {}).get("requestContext") or {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims")
    ) or {}
    if not claims:
        return "anonymous", "none"
    groups = claims.get("cognito:groups")
    if isinstance(groups, (list, tuple, set)):
        parsed_groups = {str(group).strip() for group in groups}
    elif isinstance(groups, str):
        raw = groups.strip()
        try:
            decoded = json.loads(raw)
        except (TypeError, ValueError):
            decoded = None
        if isinstance(decoded, list):
            parsed_groups = {str(group).strip() for group in decoded}
        else:
            parsed_groups = {
                group.strip().strip('"\'')
                for group in raw.removeprefix("[").removesuffix("]").split(",")
                if group.strip()
            }
    else:
        parsed_groups = set()
    return ("admin" if "Admins" in parsed_groups else "user"), "jwt"
