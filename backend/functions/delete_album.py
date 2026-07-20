"""Admin-only album deletion with canonical, version-aware S3 cleanup."""

import os

import boto3

from auth_helpers import require_admin
from deletion_helpers import DeletionTooLargeError, delete_prefix_all_versions, preflight_deletion
from media_access import album_media_prefixes
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_uuid


table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])


def handler(event, context):
    denied = require_admin(event)
    if denied:
        return denied
    try:
        album_id = validate_uuid(((event or {}).get("pathParameters") or {}).get("albumId"))
        album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not album:
            return error_response(404, "Album not found", code="not_found")

        album["albumId"] = album_id
        prefixes = (*album_media_prefixes(album), f"temp-zips/{album_id}/")
        preflight_deletion(prefixes=prefixes)
        deleted_versions = 0
        for prefix in prefixes:
            deleted_versions += delete_prefix_all_versions(prefix)
        table.delete_item(
            Key={"albumId": album_id},
            ConditionExpression="attribute_exists(albumId)",
        )
        return json_response(
            200,
            {"message": "Album deleted", "deletedObjectVersions": deleted_versions},
        )
    except DeletionTooLargeError:
        return error_response(
            409,
            "Album is too large for synchronous deletion; use the maintenance deletion workflow",
            code="deletion_too_large",
        )
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_request")
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        return error_response(404, "Album not found", code="not_found")
    except Exception as error:
        return internal_error(context, error, "delete_album")
