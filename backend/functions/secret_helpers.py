"""Cached SSM SecureString resolution without logging secret material."""

import json
import os

import boto3


_cache = {}
_client = None


def _ssm_client():
    global _client
    if _client is None:
        _client = boto3.client("ssm")
    return _client


def resolve_secret(*, direct_env, parameter_env, json_keys=()):
    """Prefer an encrypted SSM parameter, retaining a local-only fallback."""
    parameter_name = os.environ.get(parameter_env, "").strip()
    cache_key = (parameter_env, parameter_name)
    if parameter_name:
        if cache_key not in _cache:
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
            _cache[cache_key] = text
        return _cache[cache_key]

    direct = os.environ.get(direct_env, "").strip()
    if not direct:
        raise RuntimeError(f"{direct_env} is not configured")
    return direct


def clear_secret_cache():
    """Test hook; production containers normally retain the cache."""
    _cache.clear()
