"""Complete Cognito NEW_PASSWORD_REQUIRED from the protected login proxy."""

import os
import re

import boto3

from audit_helpers import emit_audit_event
from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit, verify_turnstile
from validation_helpers import ValidationError, parse_json_body, require_string, validate_email


cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]
CLIENT_ID = os.environ["COGNITO_CLIENT_ID"]


def _audit(event, context, outcome, reason_code, challenge_name=None):
    challenge_type = {
        "NEW_PASSWORD_REQUIRED": "new_password_required",
        "SOFTWARE_TOKEN_MFA": "software_token_mfa",
    }.get(challenge_name, "other")
    emit_audit_event(
        event_name="auth.challenge",
        outcome=outcome,
        action="authentication.challenge.complete",
        resource_type="authentication",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type="anonymous",
        auth_method="none",
        details={"challenge_type": challenge_type},
    )


def _validate_new_password(value):
    password = require_string(value, "newPassword", minimum=12, maximum=128, strip=False)
    if not any(char.isupper() for char in password) or not any(char.islower() for char in password):
        raise ValidationError("newPassword must contain uppercase and lowercase characters")
    if not any(char.isdigit() for char in password):
        raise ValidationError("newPassword must contain a number")
    if any(char.isspace() for char in password) or not any(not char.isalnum() for char in password):
        raise ValidationError("newPassword must contain a symbol and no whitespace")
    return password


from front_door import verify_front_door_request


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    try:
        body = parse_json_body(event, max_bytes=32 * 1024)
        email = validate_email(body.get("email"))
        session = require_string(body.get("session"), "session", minimum=10, maximum=8192, strip=False)
        token = require_string(body.get("turnstileToken"), "turnstileToken", maximum=4096)
        challenge_name = require_string(
            body.get("challengeName", "NEW_PASSWORD_REQUIRED"),
            "challengeName",
            maximum=40,
        )
        if challenge_name == "NEW_PASSWORD_REQUIRED":
            challenge_responses = {
                "USERNAME": email,
                "NEW_PASSWORD": _validate_new_password(body.get("newPassword")),
            }
        elif challenge_name == "SOFTWARE_TOKEN_MFA":
            code = require_string(body.get("code"), "code", minimum=6, maximum=6)
            if not re.fullmatch(r"[0-9]{6}", code):
                raise ValidationError("code must be a 6-digit number")
            challenge_responses = {"USERNAME": email, "SOFTWARE_TOKEN_MFA_CODE": code}
        else:
            raise ValidationError("Unsupported login challenge")
        ip = ((event or {}).get("requestContext", {}).get("http", {}).get("sourceIp") or "unknown")

        if not verify_turnstile(token, ip, expected_action="login"):
            _audit(event, context, "denied", "captcha_failed", challenge_name)
            return error_response(403, "Security verification failed", code="captcha_failed")
        if not check_rate_limit(ip, "login_challenge_ip", 10, 600, fail_closed=True):
            _audit(event, context, "denied", "rate_limited_ip", challenge_name)
            return error_response(429, "Too many attempts. Please try again later.", code="rate_limited")
        if not check_rate_limit(email, "login_challenge_user", 5, 600, fail_closed=True):
            _audit(event, context, "denied", "rate_limited_user", challenge_name)
            return error_response(429, "Too many attempts. Please try again later.", code="rate_limited")

        response = cognito.admin_respond_to_auth_challenge(
            UserPoolId=USER_POOL_ID,
            ClientId=CLIENT_ID,
            ChallengeName=challenge_name,
            Session=session,
            ChallengeResponses=challenge_responses,
        )
        if response.get("ChallengeName"):
            _audit(event, context, "success", "additional_challenge_required", response["ChallengeName"])
            return json_response(
                200,
                {"ChallengeName": response["ChallengeName"], "Session": response.get("Session", "")},
            )
        auth_result = response.get("AuthenticationResult")
        if not auth_result:
            _audit(event, context, "failure", "missing_authentication_result", challenge_name)
            return internal_error(context, operation="complete_login_challenge")
        _audit(event, context, "success", "challenge_completed", challenge_name)
        return json_response(200, {"AuthenticationResult": auth_result})
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_challenge", None)
        return error_response(400, str(error), code="invalid_challenge")
    except (cognito.exceptions.NotAuthorizedException, cognito.exceptions.UserNotFoundException):
        _audit(event, context, "denied", "challenge_rejected", None)
        return error_response(401, "Challenge could not be completed", code="invalid_challenge")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error", None)
        return internal_error(context, error, "complete_login_challenge")
