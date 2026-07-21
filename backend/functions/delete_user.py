"""Admin user deletion with subject-based, version-aware data erasure."""

import os

import boto3

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import AuthError, auth_error_response, require_admin
from deletion_helpers import DeletionTooLargeError, delete_prefix_all_versions, preflight_deletion
from media_access import album_media_prefixes
from owner_helpers import assert_admin_target_mutable, albums_owned_by, cognito_identity, table
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_email, validate_uuid


cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]


def _audit(event, context, outcome, reason_code, *, album_count=None, deleted_version_count=None):
    actor_type, auth_method = actor_context(event)
    details = {}
    if album_count is not None:
        details["album_count"] = album_count
    if deleted_version_count is not None:
        details["deleted_version_count"] = deleted_version_count
    emit_audit_event(
        event_name="admin.user_deleted",
        outcome=outcome,
        action="user.delete",
        resource_type="user",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        details=details or None,
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
        email = validate_email(((event or {}).get("pathParameters") or {}).get("email"))
        username, subject, _ = cognito_identity(cognito, USER_POOL_ID, email)
        if not subject:
            raise RuntimeError("Cognito user has no stable subject")
        assert_admin_target_mutable(event, cognito, USER_POOL_ID, username, subject)
        albums = albums_owned_by(subject, email)
        deletion_targets = []
        validated_albums = []
        for album in albums:
            album_id = validate_uuid(album.get("albumId", ""))
            record = dict(album)
            record["albumId"] = album_id
            prefixes = (*album_media_prefixes(record), f"temp-zips/{album_id}/")
            deletion_targets.extend(prefixes)
            validated_albums.append((record, prefixes))
        # Bound the entire cascade before deleting the first byte. This avoids
        # partially deleting many albums before discovering an oversized tail.
        preflight_deletion(prefixes=deletion_targets)
        deleted_versions = 0
        deleted_albums = 0
        for album, prefixes in validated_albums:
            album_id = album["albumId"]
            for prefix in prefixes:
                deleted_versions += delete_prefix_all_versions(prefix)
            table.delete_item(Key={"albumId": album_id})
            deleted_albums += 1

        # Delete Cognito last. A partial S3/Dynamo failure leaves the identity in
        # place, making the operation safely retryable instead of orphaning data.
        cognito.admin_delete_user(UserPoolId=USER_POOL_ID, Username=username)
        _audit(
            event,
            context,
            "success",
            "user_deleted",
            album_count=deleted_albums,
            deleted_version_count=deleted_versions,
        )
        return json_response(
            200,
            {
                "message": "User and owned albums deleted",
                "albumsDeleted": deleted_albums,
                "deletedObjectVersions": deleted_versions,
            },
        )
    except AuthError as error:
        _audit(event, context, "denied", "protected_admin_target")
        return auth_error_response(error)
    except DeletionTooLargeError:
        _audit(event, context, "denied", "deletion_too_large")
        return error_response(
            409,
            "User data is too large for synchronous deletion; use the maintenance deletion workflow",
            code="deletion_too_large",
        )
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_request")
        return error_response(400, str(error), code="invalid_request")
    except cognito.exceptions.UserNotFoundException:
        _audit(event, context, "denied", "user_not_found")
        return error_response(404, "User not found", code="not_found")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "delete_user")
