"""Admin email update that preserves stable subject-based album ownership."""

import os

import boto3

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import AuthError, auth_error_response, require_admin
from owner_helpers import assert_admin_target_mutable, albums_owned_by, cognito_identity, table
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, parse_json_body, validate_email


cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]


def _audit(event, context, outcome, reason_code, *, album_count=None):
    actor_type, auth_method = actor_context(event)
    emit_audit_event(
        event_name="admin.user_updated",
        outcome=outcome,
        action="user.email.update",
        resource_type="user",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        details={"album_count": album_count} if album_count is not None else None,
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
        old_email = validate_email(((event or {}).get("pathParameters") or {}).get("email"))
        body = parse_json_body(event, max_bytes=16 * 1024)
        if "password" in body or "newPassword" in body:
            _audit(event, context, "denied", "password_change_not_allowed")
            return error_response(
                400,
                "Administrators cannot set user passwords; use Cognito account recovery",
                code="password_not_allowed",
            )
        new_email = validate_email(body.get("email"))
        username, subject, _ = cognito_identity(cognito, USER_POOL_ID, old_email)
        if not subject:
            raise RuntimeError("Cognito user has no stable subject")
        assert_admin_target_mutable(event, cognito, USER_POOL_ID, username, subject)
        if new_email != old_email:
            cognito.admin_update_user_attributes(
                UserPoolId=USER_POOL_ID,
                Username=username,
                UserAttributes=[
                    {"Name": "email", "Value": new_email},
                    {"Name": "email_verified", "Value": "true"},
                ],
            )
        updated = 0
        for album in albums_owned_by(subject, old_email):
            table.update_item(
                Key={"albumId": album["albumId"]},
                UpdateExpression="SET ownerEmail = :newEmail, ownerSub = :ownerSub",
                ExpressionAttributeValues={":newEmail": new_email, ":ownerSub": subject},
            )
            updated += 1
        _audit(event, context, "success", "user_updated", album_count=updated)
        return json_response(200, {"message": "User email updated", "albumsUpdated": updated})
    except AuthError as error:
        _audit(event, context, "denied", "protected_admin_target")
        return auth_error_response(error)
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_request")
        return error_response(400, str(error), code="invalid_request")
    except cognito.exceptions.UserNotFoundException:
        _audit(event, context, "denied", "user_not_found")
        return error_response(404, "User not found", code="not_found")
    except (cognito.exceptions.AliasExistsException, cognito.exceptions.UsernameExistsException):
        _audit(event, context, "denied", "user_conflict")
        return error_response(409, "That email address is already in use", code="conflict")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "edit_user")
