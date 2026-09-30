"""Central Cognito authentication and authorization helpers.

API Gateway-authenticated routes provide verified claims in requestContext. Routes
that deliberately allow anonymous access call the same helper, which verifies an
optional Bearer token against the Cognito JWKS before treating the caller as
authenticated.

Administrator privilege additionally requires the ``admin_mfa`` ID-token claim
to equal ``enabled``. The Cognito pre-token-generation trigger
(``pre_token_generation.py``) stamps that claim for Admins-group users from
their current Cognito MFA settings, so an administrator without TOTP can still
sign in (and enroll) but is treated as an ordinary user everywhere -- admin
routes deny, album reads fall back to owner/share checks, and catalog scope
falls back to public/owner -- until a token issued after enrollment is used. A
missing or any other value fails closed.
"""

import json
import os
import time
from typing import Any

from audit_helpers import actor_context, emit_audit_event

# Set only by the pre-token-generation trigger; Cognito signs it into the ID
# token, so callers cannot forge it without also forging the token.
ADMIN_MFA_CLAIM = "admin_mfa"


class AuthError(Exception):
    """An authentication/authorization error safe to map to an HTTP response."""

    def __init__(self, message="Unauthorized", status_code=401):
        super().__init__(message)
        self.public_message = message
        self.status_code = status_code


_jwks_client = None


def _configuration():
    pool_id = os.environ.get("COGNITO_USER_POOL_ID", "").strip()
    client_id = os.environ.get("COGNITO_CLIENT_ID", "").strip()
    region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-west-2"))
    issuer = os.environ.get(
        "COGNITO_ISSUER",
        f"https://cognito-idp.{region}.amazonaws.com/{pool_id}" if pool_id else "",
    ).rstrip("/")
    if not pool_id or not client_id or not issuer:
        raise AuthError("Authentication is unavailable", 503)
    return issuer, client_id


def _get_jwks_client():
    from jwt import PyJWKClient

    global _jwks_client
    issuer, _ = _configuration()
    expected_uri = f"{issuer}/.well-known/jwks.json"
    if _jwks_client is None or getattr(_jwks_client, "uri", None) != expected_uri:
        _jwks_client = PyJWKClient(
            expected_uri,
            # The set has a TTL; the optional per-key cache does not. Reuse the
            # set so retired keys stop being trusted after the next refresh.
            cache_keys=False,
            cache_jwk_set=True,
            lifespan=600,
            timeout=5,
            cooldown_duration=30,
        )
    return _jwks_client


def parse_groups(value: Any) -> set[str]:
    """Parse API Gateway/Cognito group formats and return exact group names."""
    if value is None:
        return set()
    if isinstance(value, (list, tuple, set)):
        return {str(group).strip() for group in value if str(group).strip()}
    if not isinstance(value, str):
        return set()

    raw = value.strip()
    if not raw:
        return set()
    try:
        decoded = json.loads(raw)
        if isinstance(decoded, list):
            return {str(group).strip() for group in decoded if str(group).strip()}
    except (TypeError, ValueError):
        pass

    # HTTP API commonly serializes a list as "[Admins,OtherGroup]".
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1]
    return {group.strip().strip('"\'') for group in raw.split(",") if group.strip()}


def _validate_claim_semantics(claims):
    if not isinstance(claims, dict):
        raise AuthError()
    issuer, client_id = _configuration()

    if claims.get("iss", "").rstrip("/") != issuer:
        raise AuthError()
    audience = claims.get("aud")
    audiences = audience if isinstance(audience, list) else [audience]
    if client_id not in audiences:
        raise AuthError()
    if claims.get("token_use") != "id":
        raise AuthError()
    try:
        if int(claims.get("exp", 0)) <= int(time.time()):
            raise AuthError("Session expired", 401)
    except (TypeError, ValueError):
        raise AuthError() from None
    if not claims.get("sub"):
        raise AuthError()
    return claims


def _gateway_claims(event):
    return (
        (event or {}).get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims")
    )


def _bearer_token(event):
    headers = (event or {}).get("headers") or {}
    normalized = {str(key).lower(): value for key, value in headers.items()}
    header = str(normalized.get("authorization", "")).strip()
    if not header:
        return None
    scheme, separator, token = header.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not token or len(token) > 16384:
        raise AuthError()
    return token.strip()


def get_verified_claims(event, required=True):
    """Return verified Cognito ID-token claims or None for an anonymous request."""
    claims = _gateway_claims(event)
    if claims:
        return _validate_claim_semantics(claims)

    token = _bearer_token(event)
    if token is None:
        if required:
            raise AuthError()
        return None

    try:
        import jwt

        issuer, client_id = _configuration()
        # Reject unsupported/oversized headers before any key lookup. These
        # unverified fields only restrict work; jwt.decode still verifies trust.
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")
        if header.get("alg") != "RS256" or not isinstance(kid, str) or not 1 <= len(kid) <= 256:
            raise AuthError()
        signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=client_id,
            issuer=issuer,
            options={"require": ["exp", "iss", "aud", "sub", "token_use"]},
        )
        return _validate_claim_semantics(claims)
    except AuthError:
        raise
    except Exception:
        # Do not leak token/JWKS parsing details to callers or logs.
        raise AuthError() from None


def has_admin_mfa(claims) -> bool:
    """Return True only when the token proves TOTP was enrolled at issue time."""
    return (claims or {}).get(ADMIN_MFA_CLAIM) == "enabled"


def is_admin_group(claims):
    """Group membership only; never sufficient for admin privilege on its own."""
    return "Admins" in parse_groups((claims or {}).get("cognito:groups"))


def is_admin(claims):
    """Return True only for an Admins member whose token proves TOTP enrollment.

    Every privilege decision (admin routes, private-album reads, catalog scope,
    and the matching audit actor labels) uses this, so an un-enrolled admin is
    indistinguishable from an ordinary user rather than partially privileged.
    """
    return is_admin_group(claims) and has_admin_mfa(claims)


def auth_error_response(error):
    return {
        "statusCode": getattr(error, "status_code", 401),
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps({"error": getattr(error, "public_message", "Unauthorized")}),
    }


def require_admin(event):
    """Return None only for an exact Admins group claim with admin MFA enabled."""
    try:
        claims = get_verified_claims(event, required=True)
    except AuthError as error:
        emit_audit_event(
            event_name="authorization.admin_access",
            outcome="denied",
            action="authorization.admin.require",
            resource_type="authorization",
            reason_code="authentication_required" if error.status_code == 401 else "authentication_unavailable",
            event=event,
            actor_type="anonymous",
            auth_method="none",
        )
        return auth_error_response(error)
    if not is_admin_group(claims):
        actor_type, auth_method = actor_context(event)
        emit_audit_event(
            event_name="authorization.admin_access",
            outcome="denied",
            action="authorization.admin.require",
            resource_type="authorization",
            reason_code="admin_group_required",
            event=event,
            actor_type=actor_type,
            auth_method=auth_method,
        )
        return auth_error_response(AuthError("Forbidden — admin access required", 403))
    # Checked after the group so audit reason codes distinguish non-admins from
    # administrators who still need to enroll TOTP (or whose status is unknown).
    if not is_admin(claims):
        actor_type, auth_method = actor_context(event)
        emit_audit_event(
            event_name="authorization.admin_access",
            outcome="denied",
            action="authorization.admin.require",
            resource_type="authorization",
            reason_code="admin_mfa_required",
            event=event,
            actor_type=actor_type,
            auth_method=auth_method,
        )
        return auth_error_response(
            AuthError("Forbidden — administrator two-factor authentication is required", 403)
        )
    return None


def get_caller_claims(event):
    return get_verified_claims(event, required=True)


def get_caller_email(event):
    return str(get_caller_claims(event).get("email", "")).strip().lower()


def get_caller_sub(event):
    return str(get_caller_claims(event).get("sub", "")).strip()
