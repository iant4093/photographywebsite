"""Strict, reusable request validation helpers."""

import base64
import json
import re
import uuid


class ValidationError(Exception):
    pass


MAX_JSON_BODY_BYTES = 256 * 1024
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
ALLOWED_VISIBILITIES = {"public", "private", "unlisted"}
ALLOWED_ALBUM_TYPES = {"photo", "video"}


def parse_json_body(event, *, max_bytes=MAX_JSON_BODY_BYTES):
    raw = (event or {}).get("body")
    if raw is None or raw == "":
        return {}
    if not isinstance(raw, str):
        raise ValidationError("Request body must be JSON")
    if (event or {}).get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw, validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            raise ValidationError("Request body must be valid JSON") from None
    if len(raw.encode("utf-8")) > max_bytes:
        raise ValidationError("Request body is too large")
    try:
        body = json.loads(raw)
    except (TypeError, ValueError):
        raise ValidationError("Request body must be valid JSON") from None
    if not isinstance(body, dict):
        raise ValidationError("Request body must be a JSON object")
    return body


def require_string(value, field, *, minimum=1, maximum=255, strip=True):
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be a string")
    normalized = value.strip() if strip else value
    if len(normalized) < minimum or len(normalized) > maximum:
        raise ValidationError(f"{field} must be between {minimum} and {maximum} characters")
    return normalized


def optional_string(value, field, *, maximum=2000, default=""):
    if value is None:
        return default
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be a string")
    normalized = value.strip()
    if len(normalized) > maximum:
        raise ValidationError(f"{field} must be at most {maximum} characters")
    return normalized


def validate_email(value, field="email", *, required=True):
    if value in (None, "") and not required:
        return ""
    email = require_string(value, field, maximum=254).lower()
    if not EMAIL_PATTERN.fullmatch(email):
        raise ValidationError(f"{field} must be a valid email address")
    return email


def validate_uuid(value, field="albumId"):
    text = require_string(value, field, maximum=64)
    try:
        return str(uuid.UUID(text))
    except (ValueError, AttributeError):
        raise ValidationError(f"{field} must be a valid UUID") from None


def validate_visibility(value, *, default=None):
    if value is None and default is not None:
        value = default
    if value not in ALLOWED_VISIBILITIES:
        raise ValidationError("visibility must be public, private, or unlisted")
    return value


def validate_album_type(value, *, default="photo"):
    if value is None:
        value = default
    if value not in ALLOWED_ALBUM_TYPES:
        raise ValidationError("type must be photo or video")
    return value


def validate_bool(value, field, *, default=False):
    if value is None:
        return default
    if not isinstance(value, bool):
        raise ValidationError(f"{field} must be a boolean")
    return value


def validate_list(value, field, *, maximum=1000, required=False):
    if value is None and not required:
        return []
    if not isinstance(value, list):
        raise ValidationError(f"{field} must be an array")
    if (required and not value) or len(value) > maximum:
        qualifier = "non-empty and " if required else ""
        raise ValidationError(f"{field} must be {qualifier}at most {maximum} items")
    return value


def validate_limit(value, *, default=20, maximum=50):
    if value in (None, ""):
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValidationError("limit must be an integer") from None
    if parsed < 1 or parsed > maximum:
        raise ValidationError(f"limit must be between 1 and {maximum}")
    return parsed
