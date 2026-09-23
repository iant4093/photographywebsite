"""Recoverable Cognito/email synchronization using existing internal album rows."""
from copy import deepcopy
import hashlib
import time
import uuid

from botocore.exceptions import ClientError
from dynamodb_helpers import ensure_album_item_budget
from media_mutation import album_lease, MediaAlbumMissing, MediaMutationBusy
from owner_helpers import albums_owned_by, cognito_identity, assert_admin_target_mutable
from validation_helpers import require_string


def _key(kind, value):
    return {"albumId": f"__USER_EMAIL_{kind}__" + hashlib.sha256(value.encode()).hexdigest()}


def _conditional_failure(error):
    return isinstance(error, ClientError) and error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"


def update(table, cognito, pool, old_email, new_email, body, event, context):
    user_id = body.get("userId")
    if user_id is not None:
        user_id = require_string(user_id, "userId", maximum=128)
    alias_key = _key("LOOKUP", old_email)
    alias = table.get_item(Key=alias_key, ConsistentRead=True).get("Item", {}).get("payload", {})
    try:
        username, subject, attrs = cognito_identity(cognito, pool, user_id or old_email)
    except cognito.exceptions.UserNotFoundException:
        if user_id or not alias.get("username"):
            raise
        username, subject, attrs = cognito_identity(cognito, pool, alias["username"])
    if not subject:
        raise RuntimeError("Account has no stable subject")
    if not user_id and alias and alias.get("subject") != subject:
        raise MediaMutationBusy("The account changed. Reload the user list and retry.")
    assert_admin_target_mutable(event, cognito, pool, username, subject)
    key = _key("UPDATE", subject)
    operation = hashlib.sha256(f"{subject}\n{old_email}\n{new_email}".encode()).hexdigest()
    existing = table.get_item(Key=key, ConsistentRead=True).get("Item", {})
    previous = existing.get("payload", {})
    same_operation = previous.get("operation") == operation
    if previous and previous.get("phase") != "complete" and not same_operation:
        raise MediaMutationBusy("The previous account update is still being completed. Retry that update first.")
    current_email = str(attrs.get("email", "")).strip().lower()
    if current_email != old_email and not (same_operation and current_email == new_email):
        raise MediaMutationBusy("The account email changed. Reload the user list and retry.")
    if same_operation and previous.get("phase") == "complete":
        return int(previous.get("updated", 0))

    payload = deepcopy(previous) if same_operation else {
        "operation": operation, "username": username, "subject": subject,
        "phase": "pending",
        # Preserve the legacy records through owner-index propagation delays.
        "albumIds": sorted({album["albumId"] for album in albums_owned_by(subject, old_email) if album.get("albumId")}),
    }
    ensure_album_item_budget({**key, "status": "internal", "payload": payload})
    now = int(time.time())
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    duration = max(60, int(remaining() / 1000) + 60) if callable(remaining) else 960
    owner = uuid.uuid4().hex
    try:
        table.update_item(
            Key=key, UpdateExpression="SET #status = :internal, payload = :payload, leaseOwner = :owner, leaseUntil = :until",
            ConditionExpression="(attribute_not_exists(leaseUntil) OR leaseUntil < :now) AND (attribute_not_exists(payload) OR payload.operation = :operation OR payload.phase = :complete)",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":internal": "internal", ":payload": payload, ":owner": owner,
                                       ":until": now + duration, ":now": now, ":operation": operation, ":complete": "complete"},
        )
    except ClientError as error:
        if _conditional_failure(error):
            raise MediaMutationBusy("The account is being updated. Please retry shortly.") from None
        raise
    try:
        # This server-written receipt lets a legacy client retry its old-email
        # URL after Cognito has already switched to the new sign-in address.
        table.update_item(
            Key=alias_key, UpdateExpression="SET #status = :internal, payload = :payload",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":internal": "internal", ":payload": {
                "username": username, "subject": subject, "operation": operation}},
        )
        # Stabilize email-only ownership before changing Cognito. Never replace
        # an existing subject, a transferred album or a deleted record.
        for album_id in payload["albumIds"]:
            try:
                with album_lease(table, album_id, context):
                    table.update_item(
                        Key={"albumId": album_id}, UpdateExpression="SET ownerSub = :subject",
                        ConditionExpression="attribute_exists(albumId) AND attribute_not_exists(ownerSub) AND ownerEmail = :oldEmail",
                        ExpressionAttributeValues={":subject": subject, ":oldEmail": old_email},
                    )
            except MediaAlbumMissing:
                continue
            except ClientError as error:
                if not _conditional_failure(error):
                    raise
        if current_email != new_email:
            cognito.admin_update_user_attributes(UserPoolId=pool, Username=username, UserAttributes=[
                {"Name": "email", "Value": new_email}, {"Name": "email_verified", "Value": "true"},
            ])
        updated = 0
        for album_id in payload["albumIds"]:
            try:
                with album_lease(table, album_id, context):
                    table.update_item(
                        Key={"albumId": album_id}, UpdateExpression="SET ownerEmail = :newEmail",
                        ConditionExpression="attribute_exists(albumId) AND ownerSub = :subject",
                        ExpressionAttributeValues={":subject": subject, ":newEmail": new_email},
                    )
                updated += 1
            except MediaAlbumMissing:
                continue
            except ClientError as error:
                if not _conditional_failure(error):
                    raise
        payload.update(phase="complete", updated=updated)
        table.update_item(
            Key=key, UpdateExpression="SET payload = :payload",
            ConditionExpression="leaseOwner = :owner AND payload.operation = :operation",
            ExpressionAttributeValues={":owner": owner, ":operation": operation, ":payload": payload},
        )
        return updated
    finally:
        try:
            table.update_item(Key=key, UpdateExpression="REMOVE leaseOwner, leaseUntil",
                              ConditionExpression="leaseOwner = :owner", ExpressionAttributeValues={":owner": owner})
        except Exception:
            pass  # The account lease expires after the invoking Lambda.
