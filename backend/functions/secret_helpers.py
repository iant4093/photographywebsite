"""Cached SSM SecureString resolution without logging secret material."""

import json
import logging
import os
import time

import boto3
from aws_request_config import request_config


DEFAULT_CACHE_TTL_SECONDS = 300
MIN_CACHE_TTL_SECONDS = 30
MAX_CACHE_TTL_SECONDS = 3600

logger = logging.getLogger("photography_api.secret_helpers")
# (parameter_env, parameter_name) -> (value, monotonic refresh deadline)
_cache = {}
_client = None


def _ssm_client():
    global _client
    if _client is None:
        _client = boto3.client("ssm", config=request_config(attempts=1))
    return _client


def cache_ttl_seconds():
    """Bound how long a rotated parameter can remain stale in a warm container."""
    try:
        configured = int(os.environ.get("SECRET_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_SECONDS))
    except (TypeError, ValueError):
        return DEFAULT_CACHE_TTL_SECONDS
    return max(MIN_CACHE_TTL_SECONDS, min(configured, MAX_CACHE_TTL_SECONDS))


def _read_parameter(parameter_name, json_keys):
    response = _ssm_client().get_parameter(
        Name=parameter_name,
        WithDecryption=True,
    )
    text = str(response.get("Parameter", {}).get("Value", "")).strip()
    if not text:
        raise RuntimeError("Secure parameter is empty")
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        parsed = None
    if isinstance(parsed, dict):
        value = next((parsed.get(key) for key in json_keys if parsed.get(key)), None)
        if value is None:
            raise RuntimeError("Secure parameter JSON does not contain the required key")
        text = str(value).strip()
    return text


def resolve_secret(*, direct_env, parameter_env, json_keys=()):
    """Prefer an encrypted SSM parameter, retaining a local-only fallback."""
    parameter_name = os.environ.get(parameter_env, "").strip()
    cache_key = (parameter_env, parameter_name)
    if parameter_name:
        now = time.monotonic()
        cached = _cache.get(cache_key)
        if cached is not None and now < cached[1]:
            return cached[0]
        try:
            text = _read_parameter(parameter_name, json_keys)
        except Exception as error:
            if cached is None:
                raise
            # Availability: a transient SSM failure keeps the last good value.
            # Retry after a short interval rather than on every request.
            logger.warning("secret_refresh_failed error_type=%s", type(error).__name__)
            _cache[cache_key] = (cached[0], now + MIN_CACHE_TTL_SECONDS)
            return cached[0]
        _cache[cache_key] = (text, now + cache_ttl_seconds())
        return text

    direct = os.environ.get(direct_env, "").strip()
    if not direct:
        raise RuntimeError(f"{direct_env} is not configured")
    return direct


def clear_secret_cache():
    """Test hook; production containers refresh entries after the cache TTL."""
    _cache.clear()
