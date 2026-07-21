"""Verify that HTTP API requests arrived through the approved CloudFront origin.

The verification value is generated and stored in Secrets Manager.  It is
never accepted from query/body data and is never written to logs.  Enforcement
is deliberately staged off by default; when enabled, any configuration or
provider failure denies the request.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import threading
import time

import boto3


logger = logging.getLogger("photography_api.front_door")

HEADER_NAME = "x-origin-verify"
_CACHE_LOCK = threading.Lock()
_CACHE = {"arn": None, "current": None, "previous": None, "expires_at": 0.0}
_secrets_client = None


def _enforcement_enabled():
    value = os.environ.get("FRONT_DOOR_ENFORCEMENT_ENABLED", "false").strip().lower()
    if value == "false":
        return False
    if value == "true":
        return True
    # A misspelled production control must not silently disable enforcement.
    return None


def _cache_ttl_seconds():
    try:
        value = int(os.environ.get("FRONT_DOOR_SECRET_CACHE_TTL_SECONDS", "300"))
    except (TypeError, ValueError):
        return 300
    return max(5, min(value, 3600))


def _client():
    global _secrets_client
    if _secrets_client is None:
        _secrets_client = boto3.client("secretsmanager")
    return _secrets_client


def _parse_secret(payload):
    if not isinstance(payload, str) or len(payload) > 4096:
        raise ValueError("invalid origin secret contract")
    document = json.loads(payload)
    if not isinstance(document, dict):
        raise ValueError("invalid origin secret contract")
    current = document.get("current")
    previous = document.get("previous")
    if (
        not isinstance(current, str)
        or not 32 <= len(current) <= 512
        or not current.isascii()
        or "\r" in current
        or "\n" in current
    ):
        raise ValueError("invalid origin secret contract")
    if previous in (None, ""):
        previous = None
    elif (
        not isinstance(previous, str)
        or not 32 <= len(previous) <= 512
        or not previous.isascii()
        or "\r" in previous
        or "\n" in previous
    ):
        raise ValueError("invalid origin secret contract")
    return current, previous


def _secret_values(secret_arn):
    now = time.monotonic()
    with _CACHE_LOCK:
        if _CACHE["arn"] == secret_arn and now < _CACHE["expires_at"]:
            return _CACHE["current"], _CACHE["previous"]

        response = _client().get_secret_value(SecretId=secret_arn)
        current, previous = _parse_secret(response.get("SecretString"))
        _CACHE.update(
            arn=secret_arn,
            current=current,
            previous=previous,
            expires_at=now + _cache_ttl_seconds(),
        )
        return current, previous


def _request_header(event):
    headers = (event or {}).get("headers") or {}
    if not isinstance(headers, dict):
        return None
    for name, value in headers.items():
        if isinstance(name, str) and name.lower() == HEADER_NAME:
            return (
                value
                if isinstance(value, str)
                and len(value) <= 512
                and value.isascii()
                and "\r" not in value
                and "\n" not in value
                else None
            )
    return None


def _deny(reason):
    # Reason is an internal fixed classification.  Never include header values,
    # secret identifiers, exception text, paths, query strings, or user data.
    logger.warning("front_door_request_denied reason=%s", reason)
    return {
        "statusCode": 403,
        "headers": {
            "Content-Type": "application/json",
            "Cache-Control": "private, no-store",
        },
        "body": json.dumps({"error": "Forbidden", "code": "front_door_required"}),
    }


def verify_front_door_request(event, _context=None):
    """Return a fixed 403 response when an enforced request is not from CloudFront."""
    enabled = _enforcement_enabled()
    if enabled is False:
        return None
    if enabled is None:
        return _deny("invalid_configuration")

    secret_arn = os.environ.get("FRONT_DOOR_CONFIG_ARN", "").strip()
    supplied = _request_header(event)
    if not secret_arn:
        return _deny("secret_not_configured")
    if not supplied:
        return _deny("verification_missing")

    try:
        current, previous = _secret_values(secret_arn)
    except Exception:
        return _deny("secret_unavailable")

    if hmac.compare_digest(supplied, current):
        return None
    if previous and hmac.compare_digest(supplied, previous):
        return None
    return _deny("verification_invalid")


def reset_front_door_cache_for_tests():
    """Clear process-local state without returning or logging cached values."""
    global _secrets_client
    with _CACHE_LOCK:
        _CACHE.update(arn=None, current=None, previous=None, expires_at=0.0)
    _secrets_client = None
