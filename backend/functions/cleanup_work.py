"""Durable cleanup receipts and coalesced continuations on the existing queue."""
import json
import os
import time

from cache_invalidation import _queue_client, prepare_media_revocation, advance_media_revocation
from audit_helpers import actor_context, emit_audit_event


def audit_context(event):
    actor, auth = actor_context(event) if event is not None else ("service", "service")
    return {"actor": actor, "auth": auth}


def complete_audit(pending, save, resource, details):
    # All required cleanup is committed before the completion event. The
    # hidden receipt survives logging failure; duplicate emissions share the
    # same operation correlation ID if its final removal is interrupted.
    if not pending.get("cleanupComplete") or pending.get("auditDetails") != details:
        pending.update(cleanupComplete=True, auditDetails=details)
        save()
    actor = pending.get("audit", {"actor": "service", "auth": "service"})
    emitted = emit_audit_event(
        event_name=f"admin.{resource}_deleted", outcome="success", action={
            "album": "album.delete", "media": "album.media.delete", "user": "user.delete"}[resource],
        resource_type=resource, reason_code=f"{resource}_deleted",
        event={"requestContext": {"requestId": pending["id"]}},
        actor_type=actor["actor"], auth_method=actor["auth"], details=pending["auditDetails"],
    )
    if not emitted:
        raise RuntimeError("Deletion audit completion needs another attempt")


def schedule(album_id, pending, save, kind, delay=15):
    now = int(time.time())
    if "continuationStartedAt" not in pending:
        pending["continuationStartedAt"] = now
        # Persist intent even if the first send fails. Never claim an unsent
        # continuation, and never let an ordinary retry restart its age budget.
        save()
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


def counted_step(pending, save, step, action):
    """Persist confirmed counts; an interrupted provider reply is a lower bound.

    Saving intent before the provider call prevents a retry from pretending a
    partial/lost reply was an exact count. Actions enumerate remaining versions
    again, so late uploads during a CDN wait are also drained.
    """
    done = pending.setdefault('countedSteps', [])
    if pending.get('countInFlight'):
        pending['countExact'] = False
    pending.setdefault('countExact', False)
    pending['countInFlight'] = step
    save()
    count = action()
    pending['deletedVersions'] = int(pending.get('deletedVersions', 0)) + count
    if step not in done:
        done.append(step)
    pending.pop('countInFlight', None)
    save()


def completion_key(album_id):
    return {'albumId':'__ALBUM_DELETION__' + album_id}
