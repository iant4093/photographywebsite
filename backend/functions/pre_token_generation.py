"""Cognito pre-token-generation trigger that stamps administrator MFA status.

Cognito invokes this function synchronously before it issues ID tokens for a
sign-in or a refresh. For members of the exact ``Admins`` group it adds an
``admin_mfa`` claim derived from the user's current Cognito MFA settings:

* ``enabled``    -- TOTP (``SOFTWARE_TOKEN_MFA``) is configured.
* ``missing``    -- the administrator has not enrolled TOTP yet.
* ``unverified`` -- the lookup failed, so the status is unknown.

The two failure directions are deliberately different. This trigger fails
open for *login*: raising here would make Cognito reject every administrator
sign-in and refresh, including the one needed to reach the enrollment page.
``auth_helpers.is_admin`` fails closed for *admin privilege*: only the exact
value ``enabled`` is accepted, so ``missing``, ``unverified``, or an absent
claim (for example if this trigger is ever detached) all leave the caller an
ordinary user, denied by every admin route and admin read scope.

Ordinary client users return immediately, with no Cognito API call, so the
trigger adds no latency or provider dependency to their sign-in path.
"""

import json
import logging

import boto3
from botocore.config import Config


logger = logging.getLogger("photography_api.pre_token_generation")

ADMIN_GROUP = "Admins"
ADMIN_MFA_CLAIM = "admin_mfa"
TOTP_MFA_SETTING = "SOFTWARE_TOKEN_MFA"
_cognito = None


def _client():
    global _cognito
    if _cognito is None:
        # Cognito abandons a synchronous trigger after five seconds and then
        # fails the sign-in, which would defeat the fail-open design. One short
        # attempt keeps the worst case well inside that budget (including a cold
        # start); a failed lookup degrades to "unverified", and the next token
        # refresh or sign-in tries again.
        _cognito = boto3.client(
            "cognito-idp",
            config=Config(
                connect_timeout=1,
                read_timeout=2,
                retries={"mode": "standard", "total_max_attempts": 1},
            ),
        )
    return _cognito


def _groups(value):
    """Return exact group names from a Cognito group list or its string forms.

    This mirrors ``auth_helpers.parse_groups`` instead of importing it so the
    trigger artifact stays a single file with no JWT or audit dependencies.
    """
    if isinstance(value, (list, tuple, set)):
        return {str(group).strip() for group in value if str(group).strip()}
    if not isinstance(value, str) or not value.strip():
        return set()
    raw = value.strip()
    try:
        decoded = json.loads(raw)
        if isinstance(decoded, list):
            return {str(group).strip() for group in decoded if str(group).strip()}
    except ValueError:
        pass
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1]
    return {group.strip().strip('"\'') for group in raw.split(",") if group.strip()}


def _admin_mfa_status(user_pool_id, username):
    try:
        user = _client().admin_get_user(UserPoolId=user_pool_id, Username=username)
    except Exception as error:
        # Any failure (throttling, timeout, missing user, bad configuration)
        # must not block login. Never log the event, username, or email; the
        # error class is enough to correlate with CloudTrail and metrics.
        logger.warning("admin_mfa_lookup_failed error_type=%s", type(error).__name__)
        return "unverified"
    settings = user.get("UserMFASettingList") or []
    return "enabled" if TOTP_MFA_SETTING in settings else "missing"


def handler(event, _context):
    request = event.get("request") or {}
    group_configuration = request.get("groupConfiguration") or {}
    if ADMIN_GROUP not in _groups(group_configuration.get("groupsToOverride")):
        return event

    status = _admin_mfa_status(event.get("userPoolId"), event.get("userName"))

    # Merge rather than replace so any group or claim overrides present in the
    # incoming response survive; only the admin_mfa claim is owned here.
    response = event.get("response")
    if not isinstance(response, dict):
        response = {}
        event["response"] = response
    details = response.get("claimsOverrideDetails")
    if not isinstance(details, dict):
        details = {}
    claims = details.get("claimsToAddOrOverride")
    if not isinstance(claims, dict):
        claims = {}
    claims[ADMIN_MFA_CLAIM] = status
    details["claimsToAddOrOverride"] = claims
    response["claimsOverrideDetails"] = details
    return event
