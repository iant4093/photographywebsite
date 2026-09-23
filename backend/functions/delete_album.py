"""Admin-only album deletion with canonical, version-aware S3 cleanup."""

import os
import logging
import time
import uuid

from botocore.exceptions import ClientError

import boto3
import drive_backup_jobs

from audit_helpers import actor_context, emit_audit_event
from album_media_store import delete_album_media
from auth_helpers import require_admin
from cache_invalidation import invalidate_album_media, request_public_api_invalidation
from deletion_helpers import DeletionTooLargeError, delete_prefix_all_versions, preflight_deletion
from explore_index import index_entry_keys
from media_access import album_media_prefixes, delete_preview_metadata, load_preview_metadata
from random_pool_refresh import request_random_photo_pool_refresh
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_uuid


table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])
logger = logging.getLogger("photography_api.album_write")


def _audit(event, context, outcome, reason_code, *, deleted_version_count=None):
    actor_type, auth_method = actor_context(event)
    emit_audit_event(
        event_name="admin.album_deleted",
        outcome=outcome,
        action="album.delete",
        resource_type="album",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        details={"deleted_version_count": deleted_version_count} if deleted_version_count is not None else None,
    )


from front_door import verify_front_door_request


class DeletionConflict(Exception):
    pass


def delete_album_record(album, context=None):
    """Claim a durable cleanup operation; keep its manifest until every step succeeds."""
    album_id = validate_uuid(album.get("albumId"))
    preview_metadata = load_preview_metadata(album, strict=True)
    prefixes = (*album_media_prefixes(album), f"temp-zips/{album_id}/", f"album-zips/{album_id}/")
    preflight_deletion(prefixes=prefixes)
    operation = album.get("deletionId") if album.get("status") == "deleting" else uuid.uuid4().hex
    if not isinstance(operation, str) or not operation:
        raise DeletionConflict("Album deletion state is invalid")
    owner = uuid.uuid4().hex
    now = int(time.time())
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    lease_seconds = max(60, int(remaining() / 1000) + 10) if callable(remaining) else 910
    names = {"#status": "status"}
    values = {":deleting": "deleting", ":operation": operation, ":owner": owner,
              ":until": now + lease_seconds, ":now": now}
    conditions = ["attribute_exists(albumId)", "(attribute_not_exists(deletionLeaseUntil) OR deletionLeaseUntil < :now)"]
    if album.get("status") == "deleting":
        conditions += ["#status = :deleting", "deletionId = :operation"]
    else:
        if album.get("status", "active") != "active":
            raise DeletionConflict("Album is not active")
        values[":active"] = "active"
        conditions.append("(attribute_not_exists(#status) OR #status = :active)")
    # Compare every field controlling the cleanup scope and account ownership.
    for index, field in enumerate(("images", "visibility", "legacyS3Prefix", "ownerSub", "ownerEmail", "pendingMediaDeletion", "backupToGoogleDrive", "driveFolderId", "type")):
        name = f"#snapshot{index}"
        names[name] = field
        if field in album:
            value = f":snapshot{index}"
            values[value] = album[field]
            conditions.append(f"{name} = {value}")
        else:
            conditions.append(f"attribute_not_exists({name})")
    try:
        table.update_item(
            Key={"albumId": album_id},
            UpdateExpression="SET #status = :deleting, deletionId = :operation, deletionLeaseOwner = :owner, deletionLeaseUntil = :until",
            ConditionExpression=" AND ".join(conditions),
            ExpressionAttributeNames=names, ExpressionAttributeValues=values,
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise DeletionConflict("Album changed or cleanup is already running. Please retry shortly.") from None
        raise
    completed = False
    try:
        retaining = drive_backup_jobs.begin_retention(album)
        deleted_versions = sum(delete_prefix_all_versions(prefix) for prefix in prefixes)
        if album.get("visibility") == "public":
            invalidate_album_media(album, reason="album-deleted", strict=True)
        pending = album.get("pendingMediaDeletion") or {}
        metadata_keys = {media_id: index_entry_keys(metadata) for media_id, metadata in preview_metadata.items()}
        metadata_keys.update(pending.get("indexKeys", {}))
        delete_preview_metadata(album_id, set(preview_metadata) | set(pending.get("mediaIds", [])), metadata_keys)
        # Required cleanup precedes the final authorization-row deletion, so a
        # provider failure retains everything needed for a safe retry.
        delete_album_media(album_id)
        if retaining:
            drive_backup_jobs.end_retention(album_id, True)
        table.delete_item(
            Key={"albumId": album_id},
            ConditionExpression="#status = :deleting AND deletionId = :operation AND deletionLeaseOwner = :owner",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":deleting": "deleting", ":operation": operation, ":owner": owner},
        )
        completed = True
        return deleted_versions
    finally:
        if not completed:
            try:
                table.update_item(
                    Key={"albumId": album_id},
                    UpdateExpression="REMOVE deletionLeaseOwner, deletionLeaseUntil",
                    ConditionExpression="deletionId = :operation AND deletionLeaseOwner = :owner",
                    ExpressionAttributeValues={":operation": operation, ":owner": owner},
                )
            except Exception as error:
                # An interrupted owner expires naturally; never erase its marker.
                logger.error("album_deletion_release_failed error_type=%s", type(error).__name__)
        if album.get("visibility") == "public":
            request_public_api_invalidation(album_id=album_id, catalog=True, reason="album-deleted")
            if album.get("type", "photo") == "photo":
                request_random_photo_pool_refresh()


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied
    album_id = None
    try:
        album_id = validate_uuid(((event or {}).get("pathParameters") or {}).get("albumId"))
        album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not album:
            _audit(event, context, "denied", "album_not_found")
            return error_response(404, "Album not found", code="not_found")

        album["albumId"] = album_id
        deleted_versions = delete_album_record(album, context)
        _audit(event, context, "success", "album_deleted", deleted_version_count=deleted_versions)
        return json_response(
            200,
            {"message": "Album deleted", "deletedObjectVersions": deleted_versions},
        )
    except DeletionConflict as error:
        return error_response(409, str(error), code="deletion_pending")
    except DeletionTooLargeError:
        _audit(event, context, "denied", "deletion_too_large")
        return error_response(
            409,
            "Album is too large for synchronous deletion; use the maintenance deletion workflow",
            code="deletion_too_large",
        )
    except drive_backup_jobs.DriveBackupBusy as error:
        return error_response(409, str(error), code="backup_busy")
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_request")
        return error_response(400, str(error), code="invalid_request")
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        _audit(event, context, "denied", "album_not_found")
        return error_response(404, "Album not found", code="not_found")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "delete_album")
