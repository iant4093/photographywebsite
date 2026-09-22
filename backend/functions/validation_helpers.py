"""Strict, reusable request validation helpers."""

import base64
import json
import math
import re
import uuid


class ValidationError(Exception):
    pass


MAX_JSON_BODY_BYTES = 256 * 1024
MAX_JSON_DEPTH = 32
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
ALLOWED_VISIBILITIES = {"public", "private", "unlisted"}
ALLOWED_ALBUM_TYPES = {"photo", "video"}


def _check_json_depth(raw):
    # Bound nesting before the decoder allocates containers. Braces inside
    # strings (including escaped quotes/backslashes) do not count as nesting.
    depth = 0
    in_string = False
    escaped = False
    for char in raw:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "[{":
            depth += 1
            if depth > MAX_JSON_DEPTH:
                raise ValidationError("Request body is nested too deeply")
        elif char in "]}":
            depth -= 1


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError("Request body contains duplicate fields")
        result[key] = value
    return result


def _finite_json_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValidationError("Request body contains an invalid number")
    return number


def _reject_json_constant(_value):
    raise ValidationError("Request body contains an invalid number")


def parse_json_body(event, *, max_bytes=MAX_JSON_BODY_BYTES):
    raw = (event or {}).get("body")
    if raw is None or raw == "":
        return {}
    if not isinstance(raw, str):
        raise ValidationError("Request body must be JSON")
    if (event or {}).get("isBase64Encoded"):
        if len(raw) > 4 * ((max_bytes + 2) // 3):
            raise ValidationError("Request body is too large")
        try:
            decoded = base64.b64decode(raw, validate=True)
            if len(decoded) > max_bytes:
                raise ValidationError("Request body is too large")
            raw = decoded.decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            raise ValidationError("Request body must be valid JSON") from None
    if len(raw) > max_bytes:
        raise ValidationError("Request body is too large")
    try:
        if len(raw.encode("utf-8")) > max_bytes:
            raise ValidationError("Request body is too large")
        _check_json_depth(raw)
        body = json.loads(
            raw,
            object_pairs_hook=_unique_json_object,
            parse_float=_finite_json_float,
            parse_constant=_reject_json_constant,
        )
    except (TypeError, ValueError, RecursionError):
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
