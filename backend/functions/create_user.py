"""Admin user invitation using Cognito-generated temporary credentials."""

import os

import boto3

from auth_helpers import require_admin
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, parse_json_body, validate_email


cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]


def handler(event, context):
    denied = require_admin(event)
    if denied:
        return denied
    try:
        body = parse_json_body(event, max_bytes=16 * 1024)
        email = validate_email(body.get("email"))
        # Deliberately ignore any legacy client `password` field. Cognito creates
        # and delivers a short-lived temporary credential, and the user must
        # complete NEW_PASSWORD_REQUIRED before receiving a normal session.
        cognito.admin_create_user(
            UserPoolId=USER_POOL_ID,
            Username=email,
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
            ],
            DesiredDeliveryMediums=["EMAIL"],
        )
        return json_response(
            201,
            {"message": "User invitation created", "challenge": "NEW_PASSWORD_REQUIRED"},
        )
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_user")
    except cognito.exceptions.UsernameExistsException:
        return error_response(409, "A user with that email already exists", code="conflict")
    except Exception as error:
        return internal_error(context, error, "create_user")
