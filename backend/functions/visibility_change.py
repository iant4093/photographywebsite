"""Durable, bounded privacy transitions on the existing album and work queue."""
import hashlib
import json
import os
import time
import uuid
import drive_backup_jobs
from cleanup_work import schedule

from cache_invalidation import _queue_client, prepare_media_revocation, advance_media_revocation
from dynamodb_helpers import ensure_album_item_budget
from media_access import album_media_prefixes, bucket_name, get_s3_client, retag_album_objects
from media_mutation import MediaMutationBusy
import ownership_guard

BATCH_SIZE = 64
MAX_BATCHES = 8


def request_hash(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def enqueue(album_id, kind="album-visibility", *, delay=0):
    queue = os.environ.get("CACHE_INVALIDATION_QUEUE_URL", "").strip()
    if not queue:
        raise RuntimeError("Privacy continuation queue is not configured")
    _queue_client().send_message(
        QueueUrl=queue,
        **({"DelaySeconds": min(900, max(0, int(delay)))} if delay else {}),
        MessageBody=json.dumps({"version": 1, "kind": kind, "albumId": album_id}, separators=(",", ":")),
    )


def begin(table, album, updated, body, mutable_fields):
    pending = {
        "id": uuid.uuid4().hex,
        "requestHash": request_hash(body),
        "oldVisibility": album["visibility"],
        "values": {field: updated[field] for field in mutable_fields if field in updated},
        "remove": sorted(field for field in mutable_fields if field not in updated),
        "phase": "objects", "prefix": 0,
    }
    candidate = {**album, "status": "updating", "pendingVisibilityChange": pending}
    owner_target = updated.get("ownerSub") if updated.get("ownerSub") != album.get("ownerSub") else None
    # An accepted private-owner assignment is discoverable immediately, even
    # while its media tags are still transitioning. Deletion can wait for it.
    ownership = {field: updated[field] for field in ("ownerSub", "ownerEmail") if owner_target and field in updated}
    candidate.update(ownership)
    ensure_album_item_budget(candidate)
    names = {"#status": "status", "#visibility": "visibility"}
    values = {":updating": "updating", ":pending": pending, ":active": "active",
              ":visibility": album["visibility"], ":images": album.get("images", [])}
    assignment = ""
    for index, (field, value) in enumerate(ownership.items()):
        names[f"#owner{index}"] = field
        values[f":owner{index}"] = value
        assignment += f", #owner{index} = :owner{index}"
    ownership_guard.write(table, "Update", owner_target,
        Key={"albumId": album["albumId"]},
        UpdateExpression="SET #status = :updating, pendingVisibilityChange = :pending" + assignment,
        ConditionExpression=("attribute_exists(albumId) AND attribute_not_exists(pendingVisibilityChange) "
                             "AND attribute_not_exists(pendingMediaDeletion) "
                             "AND (attribute_not_exists(#status) OR #status = :active) "
                             "AND #visibility = :visibility AND (attribute_not_exists(images) OR images = :images)"),
        ExpressionAttributeNames=names, ExpressionAttributeValues=values,
    )
    # Queue before doing provider work: a browser disconnect or Lambda timeout
    # cannot erase the durable intent. If dispatch fails, repeating Save repairs it.
    enqueue(album["albumId"])
    return candidate


def desired_album(album):
    pending = album["pendingVisibilityChange"]
    result = {**album, **pending["values"], "status": "active"}
    for name in pending["remove"]:
        result.pop(name, None)
    result.pop("pendingVisibilityChange", None)
    return result


def save_progress(table, album):
    pending = album["pendingVisibilityChange"]
    table.update_item(
        Key={"albumId": album["albumId"]},
        UpdateExpression="SET pendingVisibilityChange = :pending",
        ConditionExpression="#status = :updating AND pendingVisibilityChange.id = :id",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":pending": pending, ":updating": "updating", ":id": pending["id"]},
    )


def advance(table, album, context=None):
    """Return a fully tagged candidate or None after saving bounded progress.

    Call only while holding the shared publication lease. Published sources and
    manifests cannot change while status=updating. New service-produced HLS
    objects stay pending until their event worker can acquire the lease.
    """
    pending = album["pendingVisibilityChange"]
    target = desired_album(album)
    visibility = target["visibility"]
    deadline = time.monotonic() + 8
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    for _ in range(MAX_BATCHES):
        if time.monotonic() >= deadline or (callable(remaining) and remaining() < 20000):
            break
        if pending["phase"] == "objects":
            # Include obsolete previews/manifests as well as known HLS files:
            # a failed publication may have written an object before its pointer.
            prefixes = sorted(set(album_media_prefixes(album)))
            index = int(pending.get("prefix", 0))
            if index >= len(prefixes):
                pending["phase"] = "purge"
                save_progress(table, album)
                continue
            params = {"Bucket": bucket_name(), "Prefix": prefixes[index], "MaxKeys": BATCH_SIZE}
            if pending.get("token"):
                params["ContinuationToken"] = pending["token"]
            page = get_s3_client().list_objects_v2(**params)
            keys = [item["Key"] for item in page.get("Contents", []) if item.get("Key")]
            retag_album_objects(target, keys, visibility)
            token = page.get("NextContinuationToken")
            if page.get("IsTruncated"):
                if not isinstance(token, str) or not token or token == pending.get("token"):
                    raise RuntimeError("Invalid media pagination sequence")
                pending["token"] = token
            else:
                pending.pop("token", None)
                pending["prefix"] = index + 1
            save_progress(table, album)
            continue
        if pending["phase"] in {"purge", "commit"}:
            # Older in-flight transitions can already be at commit without a
            # tracked purge. Revoke again once using a stable provider token.
            if not pending.get("invalidation"):
                pending["invalidation"] = prepare_media_revocation(album, pending["id"])
                save_progress(table, album)
            complete = advance_media_revocation(pending["invalidation"])
            pending["phase"] = "commit" if complete else "purge"
            save_progress(table, album)
            if complete:
                return target
            schedule(album["albumId"], pending, lambda: save_progress(table, album), "album-visibility")
            return None
        if pending["phase"] not in {"objects", "purge", "commit"}:
            raise MediaMutationBusy("Album privacy progress is invalid")
    schedule(album["albumId"], pending, lambda: save_progress(table, album), "album-visibility")
    return None


def commit(table, album, target):
    pending = album["pendingVisibilityChange"]
    names = {"#status": "status"}
    values = {":active": "active", ":updating": "updating", ":id": pending["id"]}
    sets = ["#status = :active"]
    removes = ["pendingVisibilityChange"]
    for index, field in enumerate(sorted(pending["values"])):
        names[f"#field{index}"] = field
        values[f":value{index}"] = target[field]
        sets.append(f"#field{index} = :value{index}")
    for index, field in enumerate(pending["remove"]):
        names[f"#remove{index}"] = field
        removes.append(f"#remove{index}")
    commit_write = (lambda **kwargs: drive_backup_jobs.update_album(table, album, **kwargs)) if any(
        target.get(field) != album.get(field) for field in ("title", "category")
    ) else table.update_item
    if album.get("pendingMediaUpload") or album.get("videoJobs") or album.get("mediaStoreDirty"):
        # Long privacy transitions can outlast a different queue delivery's
        # retry budget. Redispatch its durable work before exposing active
        # state, so a crash after this commit cannot strand those receipts.
        enqueue(album["albumId"], "album-upload-followup", delay=15)
    commit_write(
        Key={"albumId": album["albumId"]},
        UpdateExpression="SET " + ", ".join(sets) + " REMOVE " + ", ".join(removes),
        ConditionExpression="#status = :updating AND pendingVisibilityChange.id = :id",
        ExpressionAttributeNames=names, ExpressionAttributeValues=values,
    )
    return target
