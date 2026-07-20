"""CAPTCHA/rate-limited Cognito password proxy with minimal responses."""

import os

import boto3

from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit, verify_turnstile
from validation_helpers import ValidationError, parse_json_body, require_string, validate_email


cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]
CLIENT_ID = os.environ["COGNITO_CLIENT_ID"]


def handler(event, context):
    try:
        body = parse_json_body(event, max_bytes=32 * 1024)
        email = validate_email(body.get("email"))
        password = require_string(body.get("password"), "password", minimum=1, maximum=128, strip=False)
        turnstile_token = require_string(body.get("turnstileToken"), "turnstileToken", maximum=4096)
        ip = ((event or {}).get("requestContext", {}).get("http", {}).get("sourceIp") or "unknown")

        if not verify_turnstile(turnstile_token, ip, expected_action="login"):
            return error_response(403, "Security verification failed", code="captcha_failed")
        if not check_rate_limit(ip, "login_ip", max_requests=15, window_seconds=600, fail_closed=True):
            return error_response(429, "Too many login attempts. Please try again later.", code="rate_limited")
        if not check_rate_limit(email, "login_user", max_requests=8, window_seconds=600, fail_closed=True):
            return error_response(429, "Too many login attempts. Please try again later.", code="rate_limited")

        response = cognito.admin_initiate_auth(
            UserPoolId=USER_POOL_ID,
            ClientId=CLIENT_ID,
            AuthFlow="ADMIN_USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": email, "PASSWORD": password},
        )
        if response.get("ChallengeName"):
            return json_response(
                200,
                {"ChallengeName": response["ChallengeName"], "Session": response.get("Session", "")},
            )
        auth_result = response.get("AuthenticationResult")
        if not auth_result:
            return internal_error(context, operation="login")
        return json_response(200, {"AuthenticationResult": auth_result})
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_request")
    except (cognito.exceptions.NotAuthorizedException, cognito.exceptions.UserNotFoundException):
        return error_response(401, "Incorrect email or password", code="invalid_credentials")
    except Exception as error:
        return internal_error(context, error, "login")
