"""Validated album metadata/visibility update with derivative retagging."""

import json
import os
import secrets

import boto3
from botocore.exceptions import ClientError

from audit_helpers import actor_context, emit_audit_event
from album_mutation_helpers import resolve_owner as _resolve_owner
from album_mutation_helpers import validate_created_at as _validate_created_at
from auth_helpers import require_admin
from cache_invalidation import invalidate_public_previews, request_public_api_invalidation
from explore_index import sync_album_index
from hover_preview_refresh import request_hover_preview_refresh
from album_qr import album_qr_key, write_album_qr
from media_access import (
    load_preview_metadata,
    serialize_album_summary,
    tag_album_visibility,
    tag_keys_visibility,
    tag_preview_visibility,
    validate_album_media_key,
    validated_album_qr_key,
)
from response_helpers import error_response, internal_error, json_response
from random_pool_refresh import request_random_photo_pool_refresh
from validation_helpers import (
    ValidationError,
    optional_string,
    parse_json_body,
    require_string,
    validate_bool,
    validate_uuid,
    validate_visibility,
)


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
MUTABLE_FIELDS = frozenset({
    "title",
    "description",
    "category",
    "createdAt",
    "coverImageUrl",
    "coverThumbKey",
    "coverBlurhash",
    "visibility",
    "ownerEmail",
    "ownerSub",
    "isShared",
    "shareCode",
    "qrCodeKey",
})
_MISSING = object()


def _sync_drive_folder(album):
    function_name = os.environ.get("GOOGLE_DRIVE_SYNC_FUNCTION_NAME", "").strip()
    if not function_name:
        return
    boto3.client("lambda").invoke(
        FunctionName=function_name,
        InvocationType="Event",
        Payload=json.dumps(
            {
                "albumId": album["albumId"],
                "albumType": album.get("type", "photo"),
                "albumTitle": album["title"],
                "bucket": os.environ["IMAGES_BUCKET"],
                "keys": [],
            }
        ),
    )


def _audit(event, context, outcome, reason_code, *, previous_visibility=None, visibility=None):
    actor_type, auth_method = actor_context(event)
    details = {}
    valid = {"public", "private", "unlisted"}
    if previous_visibility is not None:
        details["previous_visibility"] = previous_visibility if previous_visibility in valid else "unknown"
    if visibility is not None:
        details["visibility"] = visibility if visibility in valid else "unknown"
    emit_audit_event(
        event_name="admin.album_updated",
        outcome=outcome,
        action="album.update",
        resource_type="album",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        details=details or None,
    )


def _updated_album(album, body):
    updated = dict(album)
    if "title" in body:
        updated["title"] = require_string(body["title"], "title", maximum=200)
    if "description" in body:
        updated["description"] = optional_string(body["description"], "description", maximum=5000)
    if "category" in body:
        updated["category"] = optional_string(body["category"], "category", maximum=100) or "Uncategorized"
    if "createdAt" in body:
        updated["createdAt"] = _validate_created_at(body["createdAt"])
    if "coverBlurhash" in body:
        updated["coverBlurhash"] = optional_string(body["coverBlurhash"], "coverBlurhash", maximum=200)
    for field in ("coverImageUrl", "coverThumbKey"):
        if field in body:
            value = optional_string(body[field], field, maximum=1024)
            updated[field] = (
                validate_album_media_key(
                    value,
                    album=album,
                )
                if value
                else ""
            )

    if "shareCode" in body:
        raise ValidationError("shareCode is server-controlled; use isShared to rotate or revoke")
    old_visibility = album.get("visibility")
    new_visibility = validate_visibility(body.get("visibility"), default=old_visibility)
    updated["visibility"] = new_visibility

    if new_visibility == "private" and (
        old_visibility != "private" or "ownerEmail" in body or "ownerSub" in body
    ):
        updated["ownerEmail"], updated["ownerSub"] = _resolve_owner(body)
    elif new_visibility == "private" and (not updated.get("ownerEmail") or not updated.get("ownerSub")):
        raise ValidationError("Private albums require ownerEmail and ownerSub")
    if new_visibility != "private":
        if old_visibility == "private" or "ownerEmail" in album:
            updated["ownerEmail"] = ""
        # ownerSub backs OwnerSubCreatedAtIndex and therefore cannot be an
        # empty string. Omission keeps public/unlisted albums out of the index.
        updated.pop("ownerSub", None)
    if new_visibility == "unlisted":
        sharing = validate_bool(body.get("isShared"), "isShared", default=bool(album.get("isShared", True)))
        updated["isShared"] = sharing
        if sharing and (old_visibility != "unlisted" or not album.get("shareCode")):
            updated["shareCode"] = secrets.token_urlsafe(24)
        elif not sharing:
            updated.pop("shareCode", None)
    else:
        if old_visibility == "unlisted" or "isShared" in album:
            updated["isShared"] = False
        updated.pop("shareCode", None)
    return updated


def _reconcile_album_qr(updated):
    desired_key = album_qr_key(updated)
    if not desired_key:
        updated.pop("qrCodeKey", None)
        return None
    if updated.get("qrCodeKey") != desired_key:
        written_key = write_album_qr(updated)
        if written_key != desired_key:
            raise RuntimeError("Album QR reconciliation failed")
        updated["qrCodeKey"] = written_key
    return desired_key


from front_door import verify_front_door_request


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied
    try:
        album_id = validate_uuid(((event or {}).get("pathParameters") or {}).get("albumId"))
        body = parse_json_body(event)
        if not body:
            _audit(event, context, "denied", "empty_update")
            return error_response(400, "No fields to update", code="invalid_album")
        album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not album or album.get("status", "active") != "active":
            _audit(event, context, "denied", "album_not_found")
            return error_response(404, "Album not found", code="not_found")
        updated = _updated_album(album, body)
        _reconcile_album_qr(updated)
        old_visibility = album.get("visibility")
        new_visibility = updated["visibility"]
        changed_fields = {
            field
            for field in MUTABLE_FIELDS
            if album.get(field, _MISSING) != updated.get(field, _MISSING)
        }
        if not changed_fields:
            _audit(
                event,
                context,
                "success",
                "album_updated",
                previous_visibility=old_visibility,
                visibility=new_visibility,
            )
            return json_response(200, serialize_album_summary(album, include_admin=True))

        visibility_changed = old_visibility != new_visibility
        old_qr_key = validated_album_qr_key(album)
        new_qr_key = validated_album_qr_key(updated)

        # Restrictive transitions tag first; release-to-public transitions update
        # authorization metadata first. Both orders fail safe (unavailable rather
        # than anonymously exposed) if the second operation fails.
        if visibility_changed and old_visibility == "public" and new_visibility != "public":
            if old_qr_key and old_qr_key != new_qr_key:
                tag_keys_visibility([old_qr_key], new_visibility)
            tag_album_visibility(updated, new_visibility, include_derivatives=True)
            # Submit the edge purge before committing a restrictive transition.
            # A purge failure therefore leaves media unavailable, not silently
            # less private than the requested album state.
            invalidate_public_previews(
                album_id,
                reason="album-visibility-restricted",
                strict=True,
            )

        # A cover or visibility transition invalidates the old frame set. Clear
        # its catalog pointer in the same conditional write so a newly fetched
        # catalog can never advertise a stale manifest while the targeted
        # builder is catching up. Restrictive transitions above still see the
        # old pointer and tag that object before it is detached.
        hover_pointer_fields = {
            "hoverPreviewStatus",
            "hoverPreviewVersion",
            "hoverPreviewManifestKey",
        }
        invalidate_hover_pointer = (
            updated.get("type", "photo") == "photo"
            and {"visibility", "coverImageUrl", "coverThumbKey"}.intersection(changed_fields)
        )
        if invalidate_hover_pointer:
            for field in hover_pointer_fields:
                updated.pop(field, None)

        condition = (
            "attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status = :active) "
            "AND #visibility = :previous_visibility"
        )
        expression_names = {"#status": "status", "#visibility": "visibility"}
        expression_values = {
            ":active": "active",
            ":previous_visibility": old_visibility,
        }
        assignments = []
        removals = []
        mutation_fields = set(changed_fields)
        if invalidate_hover_pointer:
            mutation_fields.update(hover_pointer_fields)
        for index, field in enumerate(sorted(mutation_fields)):
            name = f"#field{index}"
            expression_names[name] = field
            if field in updated:
                value = f":value{index}"
                assignments.append(f"{name} = {value}")
                expression_values[value] = updated[field]
            else:
                removals.append(name)
        update_parts = []
        if assignments:
            update_parts.append("SET " + ", ".join(assignments))
        if removals:
            update_parts.append("REMOVE " + ", ".join(removals))

        response = table.update_item(
            Key={"albumId": album_id},
            UpdateExpression=" ".join(update_parts),
            ConditionExpression=condition,
            ExpressionAttributeNames=expression_names,
            ExpressionAttributeValues=expression_values,
            ReturnValues="ALL_NEW",
        )
        committed = response.get("Attributes") or updated

        if visibility_changed:
            if not (old_visibility == "public" and new_visibility != "public"):
                tag_album_visibility(committed, new_visibility, include_derivatives=True)
            # A second metadata-table join closes the race with a preview worker
            # that registered derivatives while this visibility change was in
            # flight. The worker also re-reads visibility after tagging.
            tag_preview_visibility(committed, new_visibility)
        if visibility_changed and committed.get("type", "photo") == "photo":
            metadata_by_id = load_preview_metadata(committed, strict=True)
            if metadata_by_id:
                sync_album_index(
                    dynamodb.Table(os.environ["PREVIEW_METADATA_TABLE"]),
                    committed,
                    metadata_by_id,
                )
        if visibility_changed and old_visibility != "public" and new_visibility == "public":
            # Clear any cached denial produced while the source was protected.
            invalidate_public_previews(album_id, reason="album-visibility-public")
        if old_visibility == "public" or new_visibility == "public":
            request_public_api_invalidation(
                album_id=album_id,
                catalog=True,
                reason="album-updated",
            )
        if (
            committed.get("type", "photo") == "photo"
            and ("visibility" in changed_fields or "category" in changed_fields)
            and (old_visibility == "public" or new_visibility == "public")
        ):
            request_random_photo_pool_refresh()
        if (
            committed.get("type", "photo") == "photo"
            and {"visibility", "coverImageUrl", "coverThumbKey"}.intersection(changed_fields)
            and (old_visibility == "public" or new_visibility == "public")
        ):
            request_hover_preview_refresh(album_id)
        if album.get("title") != committed.get("title") or album.get("category") != committed.get("category"):
            try:
                _sync_drive_folder(committed)
            except Exception:
                # Metadata is already committed. Keep edits idempotent and let
                # the next upload or edit reconcile the Drive folder again.
                emit_audit_event(
                    event_name="provider.drive_backup",
                    outcome="failure",
                    action="provider.backup.dispatch",
                    resource_type="provider",
                    reason_code="dispatch_failed",
                    event=event,
                    context=context,
                    actor_type="service",
                    auth_method="service",
                )
        _audit(
            event,
            context,
            "success",
            "album_updated",
            previous_visibility=old_visibility,
            visibility=new_visibility,
        )
        return json_response(200, serialize_album_summary(committed, include_admin=True))
    except ValidationError as error:
        _audit(event, context, "denied", "invalid_album")
        return error_response(400, str(error), code="invalid_album")
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            _audit(event, context, "denied", "concurrent_update")
            return error_response(409, "Album changed while it was being updated", code="conflict")
        _audit(event, context, "failure", "provider_error")
        return internal_error(context, error, "update_album")
    except Exception as error:
        _audit(event, context, "failure", "unexpected_error")
        return internal_error(context, error, "update_album")
