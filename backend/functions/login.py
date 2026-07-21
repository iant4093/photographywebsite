"""CAPTCHA/rate-limited Cognito password proxy with minimal responses."""

import os

import boto3

from audit_helpers import emit_audit_event
from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit, verify_turnstile
from validation_helpers import ValidationError, parse_json_body, require_string, validate_email


cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]
CLIENT_ID = os.environ["COGNITO_CLIENT_ID"]


def _audit(event, context, outcome, reason_code, *, challenge_type=None):
    details = {"challenge_type": challenge_type} if challenge_type else None
    emit_audit_event(
        event_name="auth.login",
        outcome=outcome,
        action="authentication.login",
        resource_type="authentication",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type="anonymous",
        auth_method="none",
        details=details,
    )


def _challenge_type(value):
    return {
        "NEW_PASSWORD_REQUIRED": "new_password_required",
        "SOFTWARE_TOKEN_MFA": "software_token_mfa",
    }.get(value, "other")


from front_door import verify_front_door_request


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    try:
        body = parse_json_body(event, max_bytes=32 * 1024)
        email = validate_email(body.get("email"))
        password = require_string(body.get("password"), "password", minimum=1, maximum=128, strip=False)
        turnstile_token = require_string(body.get("turnstileToken"), "turnstileToken", maximum=4096)
        ip = ((event or {}).get("requestContext", {}).get("http", {}).get("sourceIp") or "unknown")

        if not verify_turnstile(turnstile_token, ip, expected_action="login"):
            _audit(event, context, "denied", "captcha_failed")
            return error_response(403, "Security verification failed", code="captcha_failed")
        if not check_rate_limit(ip, "login_ip", max_requests=15, window_seconds=600, fail_closed=True):
            _audit(event, context, "denied", "rate_limited_ip")
            return error_response(429, "Too many login attempts. Please try again later.", code="rate_limited")
        if not check_rate_limit(email, "login_user", max_requests=8, window_seconds=600, fail_closed=True):
            _audit(event, context, "denied", "rate_limited_user")
            return error_response(429, "Too many login attempts. Please try again later.", code="rate_limited")

        response = cognito.admin_initiate_auth(
            UserPoolId=USER_POOL_ID,
            ClientId=CLIENT_ID,
            AuthFlow="ADMIN_USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": email, "PASSWORD": password},
        )
        if response.get("ChallengeName"):
            _audit(
                event,
                context,
                "success",
                "challenge_required",
                challenge_type=_challenge_type(response["ChallengeName"]),
            )
            return json_response(
                200,
                {"ChallengeName": response["ChallengeName"], "Session": response.get("Session", "")},
            )
        auth_result = response.get("AuthenticationResult")
        if not auth_result:
            _audit(event, context, "failure", "missing_authentication_result")
            return internal_error(context, operation="login")
        _audit(event, context, "success", "authenticated")
        return json_response(200, {"AuthenticationResult": auth_result})
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_request")
        return error_response(400, str(error), code="invalid_request")
    except (cognito.exceptions.NotAuthorizedException, cognito.exceptions.UserNotFoundException):
        _audit(event, context, "denied", "invalid_credentials")
        return error_response(401, "Incorrect email or password", code="invalid_credentials")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "login")
