"""Abuse-prevention helpers with privacy-preserving identifiers."""

import hashlib
import hmac
import html
import json
import os
import time
import urllib.parse
import urllib.request
from collections import OrderedDict
from threading import Lock

import boto3
from aws_request_config import request_config
from botocore.exceptions import ClientError

from secret_helpers import resolve_secret


_rate_table = None
_denied_requests = OrderedDict()
_denied_requests_lock = Lock()
_MAX_DENIED_REQUESTS = 1024


def _cached_denial(key, now):
    with _denied_requests_lock:
        expires_at = _denied_requests.get(key)
        if expires_at is None:
            return False
        if expires_at <= now:
            del _denied_requests[key]
            return False
        _denied_requests.move_to_end(key)
        return True


def _remember_denial(key, attributes, now, window_seconds):
    # Only cache a confirmed database decision, never a provider failure. Use
    # the stored window expiry so repeat requests cannot prolong a block.
    try:
        expires_at = int(attributes["ttl"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return
    if not now < expires_at <= now + window_seconds:
        return
    with _denied_requests_lock:
        _denied_requests[key] = expires_at
        _denied_requests.move_to_end(key)
        while len(_denied_requests) > _MAX_DENIED_REQUESTS:
            _denied_requests.popitem(last=False)


def _get_rate_table():
    global _rate_table
    if _rate_table is None:
        table_name = os.environ.get("RATE_LIMIT_TABLE", "").strip()
        if not table_name:
            raise RuntimeError("Rate-limit table is not configured")
        _rate_table = boto3.resource("dynamodb", config=request_config()).Table(table_name)
    return _rate_table


def _identifier_hash(identifier, action):
    normalized = str(identifier or "unknown").strip().lower().encode("utf-8")
    secret = resolve_secret(
        direct_env="RATE_LIMIT_HASH_SECRET",
        parameter_env="RATE_LIMIT_HASH_PARAMETER",
        json_keys=("secret", "hashSecret", "RATE_LIMIT_HASH_SECRET"),
    ).encode("utf-8")
    message = action.encode("utf-8") + b"\x00" + normalized
    digest = hmac.new(secret, message, hashlib.sha256).hexdigest()
    return f"{action}#{digest}"


def is_rate_limit_denied(identifier, action, max_requests, window_seconds, *, now=None):
    """Peek at a confirmed local block without consuming quota or querying its table.

    False means unknown, not allowed: callers must still verify Turnstile and
    use the authoritative rate limiter. Cache misses/errors cannot grant access.
    """
    with _denied_requests_lock:
        if not _denied_requests:
            return False
    try:
        if not isinstance(action, str) or not action or len(action) > 64:
            return False
        max_requests, window_seconds = int(max_requests), int(window_seconds)
        if max_requests < 1 or window_seconds < 1:
            return False
        key = (os.environ.get("RATE_LIMIT_TABLE", ""), _identifier_hash(identifier, action), max_requests, window_seconds)
        return _cached_denial(key, int(time.time() if now is None else now))
    except Exception:
        return False


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
        identifier_hash = _identifier_hash(identifier, action)
        # Policy/table changes must not inherit a decision from another scope.
        cache_key = (os.environ.get("RATE_LIMIT_TABLE", ""), identifier_hash, max_requests, window_seconds)
        if _cached_denial(cache_key, current_time):
            return False
        key = {"identifier": identifier_hash}
        table = _get_rate_table()
        for _ in range(3):
            try:
                response = table.update_item(
                    Key=key,
                    UpdateExpression="ADD #count :one",
                    ConditionExpression="#ttl > :now AND #count >= :zero AND #count < :limit",
                    ExpressionAttributeNames={"#count": "count", "#ttl": "ttl"},
                    ExpressionAttributeValues={":one": 1, ":zero": 0, ":now": current_time, ":limit": max_requests},
                    ReturnValues="ALL_NEW",
                    ReturnValuesOnConditionCheckFailure="ALL_OLD",
                )
                attributes = response.get("Attributes", {})
                return 1 <= int(attributes.get("count", 0)) <= max_requests
            except ClientError as error:
                if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                    raise
                previous = error.response.get("Item", {})
                # Botocore exceptions retain the low-level DynamoDB wire shape.
                if previous and isinstance(previous.get("ttl"), dict):
                    from boto3.dynamodb.types import TypeDeserializer
                    decoder = TypeDeserializer()
                    previous = {name: decoder.deserialize(value) for name, value in previous.items()}
                if previous and int(previous.get("ttl", 0)) > current_time:
                    if int(previous.get("count", -1)) >= max_requests:
                        _remember_denial(cache_key, previous, current_time, window_seconds)
                    return False
            try:
                response = table.update_item(
                    Key=key,
                    UpdateExpression="SET #count = :one, #ttl = :expiry",
                    ConditionExpression="attribute_not_exists(#ttl) OR #ttl <= :now",
                    ExpressionAttributeNames={"#count": "count", "#ttl": "ttl"},
                    ExpressionAttributeValues={":one": 1, ":expiry": expiry, ":now": current_time},
                    ReturnValues="ALL_NEW",
                )
                return response.get("Attributes", {}).get("count") == 1
            except ClientError as error:
                if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                    raise
                # Another request reset the window; compete for its remaining quota.
        return False
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
            parameter_env="TURNSTILE_SECRET_PARAMETER",
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
