"""Bounded, scope-bound cursor encoding shared by catalog handlers."""

import base64
import json

from validation_helpers import ValidationError


ALLOWED_CURSOR_KEY_NAMES = frozenset({"albumId", "createdAt", "ownerSub", "visibility"})


def _validated_key(value):
    if not isinstance(value, dict) or not value or len(value) > 6:
        raise ValidationError("Invalid cursor")
    if any(
        name not in ALLOWED_CURSOR_KEY_NAMES
        or not isinstance(item, str)
        or not item
        or len(item) > 2048
        for name, item in value.items()
    ):
        raise ValidationError("Invalid cursor")
    return value


def encode_cursor(last_evaluated_key, scope):
    if not last_evaluated_key:
        return None
    _validated_key(last_evaluated_key)
    raw = json.dumps(
        {"v": 1, "scope": scope, "key": last_evaluated_key},
        separators=(",", ":"),
        default=str,
    )
    return base64.urlsafe_b64encode(raw.encode("utf-8")).rstrip(b"=").decode("ascii")


def decode_cursor(cursor, expected_scope):
    if not cursor:
        return None
    if not isinstance(cursor, str) or len(cursor) > 4096:
        raise ValidationError("Invalid cursor")
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except (ValueError, UnicodeError, json.JSONDecodeError):
        raise ValidationError("Invalid cursor") from None
    if not isinstance(payload, dict):
        raise ValidationError("Invalid cursor")
    if payload.get("v") != 1 or payload.get("scope") != expected_scope:
        raise ValidationError("Invalid cursor")
    return _validated_key(payload.get("key"))
