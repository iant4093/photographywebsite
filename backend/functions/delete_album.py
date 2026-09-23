"""Admin-only album deletion with canonical, version-aware S3 cleanup."""

import os
import logging
import time
import uuid

from botocore.exceptions import ClientError

import boto3
import drive_backup_jobs
import cleanup_work
import comparison_cleanup
import video_cleanup
from media_mutation import enabled as mutation_protocol_enabled

from audit_helpers import actor_context, emit_audit_event
from album_media_store import delete_album_media
from auth_helpers import require_admin
from cache_invalidation import invalidate_album_media, request_public_api_invalidation
from deletion_helpers import DeletionTooLargeError, delete_prefix_all_versions, preflight_deletion
from dynamodb_helpers import ensure_album_item_budget
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


class DeletionPending(Exception):
    pass


def delete_album_record(album, context=None, *, event=None, allow_pending=False, audit=None, operation_id=None):
    """Claim a durable cleanup operation; keep its manifest until every step succeeds."""
    album_id = validate_uuid(album.get("albumId"))
    preview_metadata = load_preview_metadata(album, strict=True)
    prefixes = (*album_media_prefixes(album), f"temp-zips/{album_id}/", f"album-zips/{album_id}/")
    preflight_deletion(prefixes=prefixes)
    operation = album.get("deletionId") if album.get("status") == "deleting" else operation_id or uuid.uuid4().hex
    if not isinstance(operation, str) or not operation:
        raise DeletionConflict("Album deletion state is invalid")
    pending_cleanup = album.get("pendingAlbumDeletion")
    if mutation_protocol_enabled() and not pending_cleanup:
        pending_cleanup = {"id": operation, "countExact": True, "audit": audit or cleanup_work.audit_context(event),
            "videoCleanup": video_cleanup.prepare(album, album.get("images", []))
                + (album.get("pendingMediaDeletion") or {}).get("videoCleanup", [])}
        try:
            ensure_album_item_budget({**album, "pendingAlbumDeletion": pending_cleanup})
        except ValidationError:
            # Reject before claiming status=deleting, like the existing object
            # count preflight, so an oversized receipt never strands an album.
            raise DeletionTooLargeError("Album cleanup receipt exceeds the item budget") from None
    owner = uuid.uuid4().hex
    now = int(time.time())
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    lease_seconds = max(60, int(remaining() / 1000) + 10) if callable(remaining) else 910
    names = {"#status": "status"}
    values = {":deleting": "deleting", ":operation": operation, ":owner": owner,
              ":until": now + lease_seconds, ":now": now}
    conditions = ["attribute_exists(albumId)", "(attribute_not_exists(deletionLeaseUntil) OR deletionLeaseUntil < :now)"]
    conditions.append("(attribute_not_exists(mediaLeaseUntil) OR mediaLeaseUntil < :now)")
    if album.get("status") == "deleting":
        conditions += ["#status = :deleting", "deletionId = :operation"]
    else:
        if album.get("status", "active") not in ({"active", "pending"} if allow_pending else {"active"}):
            raise DeletionConflict("Album is not active")
        values[":active"] = album.get("status", "active")
        conditions.append("(attribute_not_exists(#status) OR #status = :active)")
    # Compare every field controlling the cleanup scope and account ownership.
    for index, field in enumerate(("images", "visibility", "legacyS3Prefix", "ownerSub", "ownerEmail", "pendingMediaDeletion", "videoJobs", "backupToGoogleDrive", "driveFolderId", "type")):
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
        if mutation_protocol_enabled():
            if not album.get("pendingAlbumDeletion"):
                album["pendingAlbumDeletion"] = pending_cleanup
                cleanup_work.save_receipt(table, album, "pendingAlbumDeletion")
            pending_cleanup = album["pendingAlbumDeletion"]
            save = lambda: cleanup_work.save_receipt(table, album, "pendingAlbumDeletion")
            cleanup_work.schedule(album_id, pending_cleanup, save, "album-deletion", 30)
            if not video_cleanup.settle(album, pending_cleanup, save, context):
                raise DeletionPending()
        retaining = drive_backup_jobs.begin_retention(album)
        if mutation_protocol_enabled():
            for index, prefix in enumerate(prefixes):
                cleanup_work.counted_step(pending_cleanup, save, f'prefix:{index}', lambda prefix=prefix: delete_prefix_all_versions(prefix))
            deleted_versions = int(pending_cleanup.get('deletedVersions', 0))
            if not comparison_cleanup.clean(album_id):
                raise DeletionPending()
        else:
            deleted_versions = sum(delete_prefix_all_versions(prefix) for prefix in prefixes)
        if album.get("visibility") == "public":
            if mutation_protocol_enabled():
                if not cleanup_work.revoke(table, album, "pendingAlbumDeletion"):
                    raise DeletionPending()
            else:
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
        if mutation_protocol_enabled():
            cleanup_work.complete_audit(pending_cleanup, save, "album", {"deleted_version_count": deleted_versions,
                "count_accuracy": "exact" if pending_cleanup.get('countExact', False) else "lower_bound"})
            # Minimal suppression/count receipt survives removal of the album.
            table.update_item(Key=cleanup_work.completion_key(album_id),
                UpdateExpression='SET #status = :internal, payload = :value',
                ExpressionAttributeNames={'#status':'status'}, ExpressionAttributeValues={':internal':'internal', ':value':{
                    'id':operation, 'albumId':album_id, 'deletedVersions':deleted_versions,
                    'countExact':pending_cleanup.get('countExact', False), 'completedAt':int(time.time())}})
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
    if isinstance(event, dict) and set(event) == {"source", "albumId"} and event.get("source") == "album-deletion":
        album = table.get_item(Key={"albumId": validate_uuid(event["albumId"])}, ConsistentRead=True).get("Item")
        if album and album.get("status") == "deleting":
            try:
                delete_album_record(album, context)
            except DeletionPending:
                return json_response(202, {"pending": True, "retryAfter": 30})
        return json_response(200, {"complete": True})
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied
    album_id = None
    album = None
    try:
        album_id = validate_uuid(((event or {}).get("pathParameters") or {}).get("albumId"))
        album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not album:
            _audit(event, context, "denied", "album_not_found")
            return error_response(404, "Album not found", code="not_found")

        album["albumId"] = album_id
        deleted_versions = delete_album_record(album, context, event=event)
        if not mutation_protocol_enabled():
            _audit(event, context, "success", "album_deleted", deleted_version_count=deleted_versions)
        return json_response(
            200,
            {"message": "Album deleted", "deletedObjectVersions": deleted_versions,
             "deletedObjectVersionsExact": (album.get("pendingAlbumDeletion") or {}).get("countExact", False)},
        )
    except DeletionPending:
        return json_response(202, {"pending": True, "retryAfter": 30})
    except DeletionConflict as error:
        if album and album.get("status") == "deleting":
            return json_response(202, {"pending": True, "retryAfter": 30})
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
