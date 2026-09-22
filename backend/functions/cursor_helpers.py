"""Bounded, scope-bound cursor encoding shared by catalog handlers."""

import base64
import json

from validation_helpers import ValidationError, parse_json_body, validate_uuid


ALLOWED_CURSOR_KEY_NAMES = frozenset({
    "after", "albumId", "createdAt", "mediaId", "offset", "orderKey", "ownerSub", "phase", "seed",
    "total", "version", "visibility",
})


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
    try:
        if any(len(item.encode("utf-8")) > 2048 for item in value.values()):
            raise ValidationError("Invalid cursor")
    except UnicodeError:
        raise ValidationError("Invalid cursor") from None
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
        raw = base64.b64decode(padded.encode("ascii"), altchars=b"-_", validate=True).decode("utf-8")
        payload = parse_json_body({"body": raw}, max_bytes=3072)
    except (ValueError, UnicodeError, ValidationError):
        raise ValidationError("Invalid cursor") from None
    if set(payload) != {"v", "scope", "key"} or type(payload.get("v")) is not int or payload["v"] != 1 or payload.get("scope") != expected_scope:
        raise ValidationError("Invalid cursor")
    return _validated_key(payload.get("key"))


def validate_catalog_cursor(key, *, visibility, owner_sub=None, admin_all=False):
    """Accept only table/index keys belonging to this catalog's query scope."""
    if key is None:
        return
    _validated_key(key)
    partition = "ownerSub" if owner_sub else "visibility"
    index_fields = {"albumId", partition, "createdAt"}
    if set(key) != {"albumId"} and (admin_all or set(key) != index_fields):
        raise ValidationError("Invalid cursor")
    if validate_uuid(key["albumId"]) != key["albumId"]:
        raise ValidationError("Invalid cursor")
    if "createdAt" in key:
        if key[partition] != (owner_sub or visibility) or len(key["createdAt"].encode("utf-8")) > 1024:
            raise ValidationError("Invalid cursor")


def catalog_index_unavailable(error):
    """A bad starting key must never activate the index-rollout scan fallback."""
    detail = error.response.get("Error", {})
    if detail.get("Code") == "ResourceNotFoundException":
        return True
    message = detail.get("Message", "").lower()
    return detail.get("Code") == "ValidationException" and (
        "does not have the specified index" in message
        or "cannot read from backfilling global secondary index" in message
    )
