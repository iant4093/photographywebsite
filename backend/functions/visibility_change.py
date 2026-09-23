"""Durable, bounded privacy transitions on the existing album and work queue."""
import hashlib
import json
import os
import time
import uuid
import drive_backup_jobs

from cache_invalidation import _queue_client, invalidate_album_media
from dynamodb_helpers import ensure_album_item_budget
from media_access import album_media_prefixes, bucket_name, get_s3_client, retag_album_objects
from media_mutation import MediaMutationBusy

BATCH_SIZE = 64
MAX_BATCHES = 8


def request_hash(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def enqueue(album_id, kind="album-visibility"):
    queue = os.environ.get("CACHE_INVALIDATION_QUEUE_URL", "").strip()
    if not queue:
        raise RuntimeError("Privacy continuation queue is not configured")
    _queue_client().send_message(
        QueueUrl=queue,
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
    ensure_album_item_budget(candidate)
    table.update_item(
        Key={"albumId": album["albumId"]},
        UpdateExpression="SET #status = :updating, pendingVisibilityChange = :pending",
        ConditionExpression=("attribute_exists(albumId) AND attribute_not_exists(pendingVisibilityChange) "
                             "AND attribute_not_exists(pendingMediaDeletion) "
                             "AND (attribute_not_exists(#status) OR #status = :active) "
                             "AND #visibility = :visibility AND (attribute_not_exists(images) OR images = :images)"),
        ExpressionAttributeNames={"#status": "status", "#visibility": "visibility"},
        ExpressionAttributeValues={":updating": "updating", ":pending": pending, ":active": "active",
                                   ":visibility": album["visibility"], ":images": album.get("images", [])},
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
        if pending["phase"] == "purge":
            # Preserve the old hover/QR namespace until every object was retagged.
            if not invalidate_album_media(album, reason="album-visibility-transition", strict=True):
                raise RuntimeError("Privacy cache invalidation is not configured")
            pending["phase"] = "commit"
            save_progress(table, album)
        if pending["phase"] == "commit":
            return target
        if pending["phase"] not in {"objects", "purge", "commit"}:
            raise MediaMutationBusy("Album privacy progress is invalid")
    enqueue(album["albumId"])
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
    commit_write(
        Key={"albumId": album["albumId"]},
        UpdateExpression="SET " + ", ".join(sets) + " REMOVE " + ", ".join(removes),
        ConditionExpression="#status = :updating AND pendingVisibilityChange.id = :id",
        ExpressionAttributeNames=names, ExpressionAttributeValues=values,
    )
    return target
