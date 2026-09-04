"""Read-only Drive indexing and resumable discovery of existing/future gallery photos."""
import gzip
import json
import logging
import os
import time
import uuid

import boto3
from botocore.exceptions import ClientError

from original_comparison_jobs import enqueue_original_comparisons
from original_comparison_store import INDEX_KEY, comparison_table, load_snapshot, needs_work, scan_all
from original_drive import OriginalDrive
from original_match import project_archive

logger = logging.getLogger("photography_api.original_comparison")


def apply_changes(files, changes):
    by_id = {item["id"]: item for item in files}
    for change in changes:
        file_id = change.get("fileId")
        if not file_id:
            continue
        if change.get("removed"):
            by_id.pop(file_id, None)
        elif isinstance(change.get("file"), dict):
            item = change["file"]
            if item.get("id") != file_id:
                raise ValueError("Drive change identity mismatch")
            if item.get("trashed"):
                by_id.pop(file_id, None)
            else:
                by_id[file_id] = item
    return list(by_id.values())


def refresh_index(drive, previous, now):
    # A cursor gap is covered by getting the initial cursor BEFORE the inventory
    # and replaying its changes AFTER it. Every published snapshot is complete.
    full_scan = (not previous.get("indexKey") or previous.get("rootId") != drive.root_id
                 or now - int(previous.get("lastFullScanAt", 0)) >= 86400)
    files = None
    if not full_scan:
        try:
            old = load_snapshot(previous)
            changes, token = drive.changes(previous["pageToken"])
            files = apply_changes(old["files"], changes)
        except Exception as error:
            # Rebuild only invalid/expired cursors; provider failures must not
            # erase the previous complete inventory or falsely mark files missing.
            if getattr(error, "status", None) != 410 and type(error).__name__ != "DriveCursorExpired":
                raise
            full_scan = True
    if full_scan:
        token = drive.start_page_token()
        files = drive.list_inventory()
        changes, token = drive.changes(token)
        files = apply_changes(files, changes)
    candidates = project_archive(files, drive.root_id)
    generation = uuid.uuid4().hex
    snapshot = {"schemaVersion": 1, "rootId": drive.root_id, "files": files}
    payload = json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False).encode()
    if len(payload) > 100 * 1024 * 1024:
        raise ValueError("Original index exceeds size limit")
    key = f"index/{generation}.json.gz"
    boto3.client("s3").put_object(
        Bucket=os.environ["ORIGINAL_PREVIEW_BUCKET"], Key=key,
        Body=gzip.compress(payload), ContentType="application/gzip",
        ServerSideEncryption="AES256", CacheControl="private, no-store",
    )
    state = {"indexKey": key, "generation": generation, "rootId": drive.root_id,
             "pageToken": token, "updatedAt": now,
             "lastFullScanAt": now if full_scan else int(previous["lastFullScanAt"]),
             "jpgCount": len(candidates)}
    return state, candidates


def reconcile(state, candidates):
    originals = {item["id"]: item for item in candidates}
    records = {(item["albumId"], item["mediaId"]): item
               for item in scan_all(comparison_table(), ConsistentRead=True)
               if item.get("albumId") != "__SYSTEM__"}
    from media_access import media_id_for_key
    albums = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])
    count = 0
    for album in scan_all(albums, ConsistentRead=True):
        if album.get("type", "photo") != "photo" or album.get("status", "active") != "active":
            continue
        selected = []
        for image in album.get("images", []):
            if not isinstance(image, dict):
                continue
            key = image.get("rawKey") or image.get("key")
            if key and needs_work(image, records.get((album["albumId"], media_id_for_key(key))),
                                  originals, state["generation"]):
                selected.append(image)
        if selected:
            count += enqueue_original_comparisons(album["albumId"], selected)
    return count


def handler(event, context):
    table = comparison_table()
    now = int(time.time())
    owner = uuid.uuid4().hex
    try:
        claimed = table.update_item(
            Key=INDEX_KEY, UpdateExpression="SET leaseOwner = :owner, leaseUntil = :until",
            ConditionExpression="attribute_not_exists(leaseUntil) OR leaseUntil < :now",
            ExpressionAttributeValues={":owner": owner, ":until": now + 960, ":now": now},
            ReturnValues="ALL_NEW",
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return {"status": "busy"}
        raise
    try:
        previous = claimed.get("Attributes", {})
        state, candidates = refresh_index(OriginalDrive.from_environment(), previous, now)
        table.update_item(
            Key=INDEX_KEY,
            UpdateExpression="SET " + ", ".join(f"#{key} = :{key}" for key in state),
            ConditionExpression="leaseOwner = :owner",
            ExpressionAttributeNames={f"#{key}": key for key in state},
            ExpressionAttributeValues={**{f":{key}": value for key, value in state.items()}, ":owner": owner},
        )
        queued = reconcile(state, candidates)
        logger.info("original_index_refresh_completed jpg_count=%s queued_count=%s", len(candidates), queued)
        return {"status": "ready", "jpgCount": len(candidates), "queued": queued}
    except Exception as error:
        logger.error("original_index_refresh_failed error_type=%s", type(error).__name__)
        raise RuntimeError("Original index refresh failed") from None
    finally:
        try:
            table.update_item(
                Key=INDEX_KEY, UpdateExpression="REMOVE leaseOwner, leaseUntil",
                ConditionExpression="leaseOwner = :owner", ExpressionAttributeValues={":owner": owner},
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                logger.error("original_index_lease_release_failed error_type=%s", type(error).__name__)
