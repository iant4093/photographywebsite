"""Album-level access policy shared by detail, share, ZIP, and download routes."""

import base64
import json

from auth_helpers import AuthError, is_admin
from validation_helpers import ALLOWED_VISIBILITIES, ValidationError


def authorize_album(album, *, claims=None, share_code=None):
    """Return the access mode, denying every unknown/malformed visibility."""
    if not isinstance(album, dict):
        raise AuthError("Album not found", 404)
    if album.get("status", "active") != "active":
        raise AuthError("Album not found", 404)
    visibility = album.get("visibility")
    if visibility not in ALLOWED_VISIBILITIES:
        raise AuthError("Access denied", 403)

    if visibility == "public":
        return "public"

    if claims and is_admin(claims):
        return "admin"

    if visibility == "private":
        if not claims:
            raise AuthError("Authentication required", 401)
        subject = str(claims.get("sub", ""))
        owner_sub = str(album.get("ownerSub", ""))
        if owner_sub and subject == owner_sub:
            return "owner"
        # Compatibility only for records awaiting ownerSub migration. The email
        # comes from a verified ID token and is never accepted from query/body.
        if not owner_sub:
            email = str(claims.get("email", "")).strip().lower()
            owner_email = str(album.get("ownerEmail", "")).strip().lower()
            if email and email == owner_email:
                return "owner"
        raise AuthError("Access denied", 403)

    # Unlisted data is available through an active exact share grant. Admin is
    # handled above for management; a normal authenticated user gets no bypass.
    if (
        isinstance(share_code, str)
        and share_code
        and album.get("isShared") is True
        and share_code == album.get("shareCode")
    ):
        return "share"
    raise AuthError("Access denied", 403)


def encode_cursor(last_evaluated_key, scope):
    if not last_evaluated_key:
        return None
    raw = json.dumps({"v": 1, "scope": scope, "key": last_evaluated_key}, separators=(",", ":"), default=str)
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
    if payload.get("v") != 1 or payload.get("scope") != expected_scope:
        raise ValidationError("Invalid cursor")
    key = payload.get("key")
    if not isinstance(key, dict) or not key or len(key) > 6:
        raise ValidationError("Invalid cursor")
    if any(not isinstance(name, str) or not isinstance(value, (str, int, float)) for name, value in key.items()):
        raise ValidationError("Invalid cursor")
    return key
