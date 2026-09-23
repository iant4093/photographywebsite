"""Durable cleanup receipts and coalesced continuations on the existing queue."""
import json
import os
import time

from cache_invalidation import _queue_client, prepare_media_revocation, advance_media_revocation


def schedule(album_id, pending, save, kind, delay=15):
    now = int(time.time())
    pending.setdefault("continuationStartedAt", now)
    if now - int(pending["continuationStartedAt"]) >= 86400:
        raise RuntimeError("Cleanup requires administrator reconciliation")
    if int(pending.get("scheduledUntil", 0)) > now:
        return
    queue = os.environ.get("CACHE_INVALIDATION_QUEUE_URL", "").strip()
    if not queue:
        raise RuntimeError("Cleanup continuation queue is unavailable")
    delay = min(900, max(1, int(delay)))
    # Send before marking scheduled. A crash may duplicate an idempotent
    # delivery but cannot leave a receipt claiming an unsent continuation.
    _queue_client().send_message(QueueUrl=queue, DelaySeconds=delay,
        MessageBody=json.dumps({"version": 1, "kind": kind, "albumId": album_id}))
    pending["scheduledUntil"] = now + delay
    save()


def save_receipt(table, album, field):
    if field not in {"pendingMediaDeletion", "pendingAlbumDeletion", "pendingThumbnailCleanup"}:
        raise ValueError("Unknown cleanup receipt")
    pending = album[field]
    table.update_item(Key={"albumId": album["albumId"]},
        UpdateExpression=f"SET {field} = :pending",
        ConditionExpression=f"attribute_exists(albumId) AND (attribute_not_exists({field}) OR {field}.id = :id)",
        ExpressionAttributeValues={":pending": pending, ":id": pending["id"]})


def revoke(table, album, field):
    pending = album[field]
    if not pending.get("invalidation"):
        pending["invalidation"] = prepare_media_revocation(album, pending["id"])
        save_receipt(table, album, field)
    complete = advance_media_revocation(pending["invalidation"])
    save_receipt(table, album, field)
    return complete
