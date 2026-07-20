"""Abuse-prevention helpers with privacy-preserving identifiers."""

import hashlib
import hmac
import html
import json
import os
import time
import urllib.parse
import urllib.request

import boto3
from botocore.exceptions import ClientError

from secret_helpers import resolve_secret


_rate_table = None


def _get_rate_table():
    global _rate_table
    if _rate_table is None:
        table_name = os.environ.get("RATE_LIMIT_TABLE", "").strip()
        if not table_name:
            raise RuntimeError("Rate-limit table is not configured")
        _rate_table = boto3.resource("dynamodb").Table(table_name)
    return _rate_table


def _identifier_hash(identifier, action):
    normalized = str(identifier or "unknown").strip().lower().encode("utf-8")
    secret = resolve_secret(
        direct_env="RATE_LIMIT_HASH_SECRET",
        arn_env="RATE_LIMIT_HASH_SECRET_ARN",
        json_keys=("secret", "hashSecret", "RATE_LIMIT_HASH_SECRET"),
    ).encode("utf-8")
    message = action.encode("utf-8") + b"\x00" + normalized
    digest = hmac.new(secret, message, hashlib.sha256).hexdigest()
    return f"{action}#{digest}"


def check_rate_limit(identifier, action, max_requests, window_seconds, *, fail_closed=True, now=None):
    """Atomic fixed-window rate limiter that resets expired-but-not-deleted rows."""
    if not isinstance(action, str) or not action or len(action) > 64:
        return False
    try:
        max_requests = int(max_requests)
        window_seconds = int(window_seconds)
    except (TypeError, ValueError):
        return False
    if max_requests < 1 or window_seconds < 1:
        return False

    current_time = int(time.time() if now is None else now)
    expiry = current_time + window_seconds
    try:
        key = {"identifier": _identifier_hash(identifier, action)}
        table = _get_rate_table()
        try:
            response = table.update_item(
                Key=key,
                UpdateExpression="SET #count = :one, #ttl = :expiry",
                ConditionExpression="attribute_not_exists(#ttl) OR #ttl <= :now",
                ExpressionAttributeNames={"#count": "count", "#ttl": "ttl"},
                ExpressionAttributeValues={":one": 1, ":expiry": expiry, ":now": current_time},
                ReturnValues="ALL_NEW",
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            response = table.update_item(
                Key=key,
                UpdateExpression="ADD #count :one",
                ExpressionAttributeNames={"#count": "count"},
                ExpressionAttributeValues={":one": 1},
                ReturnValues="ALL_NEW",
            )
        count = int(response.get("Attributes", {}).get("count", max_requests + 1))
        return count <= max_requests
    except Exception:
        return not fail_closed


def _expected_hostnames():
    # Secure production default; non-production/custom domains must opt in via
    # an explicit comma-separated override rather than silently accepting any.
    raw = os.environ.get("TURNSTILE_EXPECTED_HOSTNAMES", "iantruongphotography.com")
    return {value.strip().lower() for value in raw.split(",") if value.strip()}


def verify_turnstile(token, ip_address=None, *, expected_action=None):
    if not isinstance(token, str) or not token or len(token) > 4096:
        return False
    try:
        secret = resolve_secret(
            direct_env="TURNSTILE_SECRET_KEY",
            arn_env="TURNSTILE_SECRET_ARN",
            json_keys=("secretKey", "turnstileSecret", "TURNSTILE_SECRET_KEY"),
        )
    except Exception:
        return False

    data = {"secret": secret, "response": token}
    if ip_address:
        data["remoteip"] = str(ip_address)[:64]
    request = urllib.request.Request(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        data=urllib.parse.urlencode(data).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        timeout = max(1.0, min(float(os.environ.get("TURNSTILE_TIMEOUT_SECONDS", "5")), 10.0))
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            return False
        result = json.loads(raw.decode("utf-8"))
    except Exception:
        return False

    if result.get("success") is not True:
        return False
    expected_hostnames = _expected_hostnames()
    if expected_hostnames and str(result.get("hostname", "")).lower() not in expected_hostnames:
        return False
    if expected_action:
        configured_action = os.environ.get(f"TURNSTILE_{expected_action.upper()}_ACTION", expected_action)
        if result.get("action") != configured_action:
            return False
    return True


def sanitize_text(text, *, maximum=5000):
    if text is None:
        return ""
    value = str(text).strip()
    if len(value) > maximum:
        value = value[:maximum]
    return html.escape(value, quote=True)
