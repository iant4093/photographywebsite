"""Admin user deletion with subject-based, version-aware data erasure."""

import os

import boto3

from auth_helpers import AuthError, auth_error_response, require_admin
from deletion_helpers import DeletionTooLargeError, delete_prefix_all_versions, preflight_deletion
from media_access import album_media_prefixes
from owner_helpers import assert_admin_target_mutable, albums_owned_by, cognito_identity, table
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_email, validate_uuid


cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]


def handler(event, context):
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
        return json_response(
            200,
            {
                "message": "User and owned albums deleted",
                "albumsDeleted": deleted_albums,
                "deletedObjectVersions": deleted_versions,
            },
        )
    except AuthError as error:
        return auth_error_response(error)
    except DeletionTooLargeError:
        return error_response(
            409,
            "User data is too large for synchronous deletion; use the maintenance deletion workflow",
            code="deletion_too_large",
        )
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_request")
    except cognito.exceptions.UserNotFoundException:
        return error_response(404, "User not found", code="not_found")
    except Exception as error:
        return internal_error(context, error, "delete_user")
