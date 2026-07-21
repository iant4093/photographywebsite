"""Admin user invitation using Cognito-generated temporary credentials."""

import os

import boto3

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import require_admin
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, parse_json_body, validate_email


cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]


def _audit(event, context, outcome, reason_code):
    actor_type, auth_method = actor_context(event)
    emit_audit_event(
        event_name="admin.user_created",
        outcome=outcome,
        action="user.invitation.create",
        resource_type="user",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
    )


from front_door import verify_front_door_request


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
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
        _audit(event, context, "success", "invitation_created")
        return json_response(
            201,
            {"message": "User invitation created", "challenge": "NEW_PASSWORD_REQUIRED"},
        )
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_request")
        return error_response(400, str(error), code="invalid_user")
    except cognito.exceptions.UsernameExistsException:
        _audit(event, context, "denied", "user_conflict")
        return error_response(409, "A user with that email already exists", code="conflict")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "create_user")
