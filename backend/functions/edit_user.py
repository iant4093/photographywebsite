"""Admin email update that preserves stable subject-based album ownership."""

import os

import boto3

from auth_helpers import AuthError, auth_error_response, require_admin
from owner_helpers import assert_admin_target_mutable, albums_owned_by, cognito_identity, table
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, parse_json_body, validate_email


cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]


def handler(event, context):
    denied = require_admin(event)
    if denied:
        return denied
    try:
        old_email = validate_email(((event or {}).get("pathParameters") or {}).get("email"))
        body = parse_json_body(event, max_bytes=16 * 1024)
        if "password" in body or "newPassword" in body:
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
        return json_response(200, {"message": "User email updated", "albumsUpdated": updated})
    except AuthError as error:
        return auth_error_response(error)
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_request")
    except cognito.exceptions.UserNotFoundException:
        return error_response(404, "User not found", code="not_found")
    except (cognito.exceptions.AliasExistsException, cognito.exceptions.UsernameExistsException):
        return error_response(409, "That email address is already in use", code="conflict")
    except Exception as error:
        return internal_error(context, error, "edit_user")
