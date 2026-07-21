"""Album-level access policy shared by detail, share, ZIP, and download routes."""

from auth_helpers import AuthError, is_admin
from cursor_helpers import decode_cursor, encode_cursor
# ValidationError remains re-exported for compatibility with callers/tests that
# historically imported the cursor exception from this module.
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
