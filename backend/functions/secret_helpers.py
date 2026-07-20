"""Cached Secrets Manager resolution without logging secret material."""

import base64
import json
import os

import boto3


_cache = {}
_client = None


def _secrets_client():
    global _client
    if _client is None:
        _client = boto3.client("secretsmanager")
    return _client


def _secret_text(response):
    if response.get("SecretString") is not None:
        return str(response["SecretString"])
    binary = response.get("SecretBinary")
    if isinstance(binary, bytes):
        return binary.decode("utf-8")
    if isinstance(binary, str):
        return base64.b64decode(binary, validate=True).decode("utf-8")
    raise RuntimeError("Secret has no value")


def resolve_secret(*, direct_env, arn_env, json_keys=()):
    """Prefer an ARN-backed secret, retaining a direct env rollout fallback."""
    arn = os.environ.get(arn_env, "").strip()
    cache_key = (arn_env, arn)
    if arn:
        if cache_key not in _cache:
            text = _secret_text(_secrets_client().get_secret_value(SecretId=arn)).strip()
            if not text:
                raise RuntimeError("Secret is empty")
            try:
                parsed = json.loads(text)
            except (TypeError, ValueError):
                parsed = None
            if isinstance(parsed, dict):
                value = next((parsed.get(key) for key in json_keys if parsed.get(key)), None)
                if value is None:
                    raise RuntimeError("Secret JSON does not contain the required key")
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
