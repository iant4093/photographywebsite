"""Validated album metadata/visibility update with derivative retagging."""

import os
import secrets

import boto3
from botocore.exceptions import ClientError

from audit_helpers import actor_context, emit_audit_event
from album_mutation_helpers import resolve_owner as _resolve_owner
from album_mutation_helpers import validate_created_at as _validate_created_at
from auth_helpers import require_admin
from media_access import serialize_album_summary, tag_album_visibility, tag_preview_visibility, validate_album_media_key
from response_helpers import error_response, internal_error, json_response
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
        updated["ownerEmail"] = ""
        updated["ownerSub"] = ""
    if new_visibility == "unlisted":
        sharing = validate_bool(body.get("isShared"), "isShared", default=bool(album.get("isShared", True)))
        updated["isShared"] = sharing
        if sharing and (old_visibility != "unlisted" or not album.get("shareCode")):
            updated["shareCode"] = secrets.token_urlsafe(24)
        elif not sharing:
            updated.pop("shareCode", None)
    else:
        updated["isShared"] = False
        updated.pop("shareCode", None)
    return updated


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
        old_visibility = album.get("visibility")
        new_visibility = updated["visibility"]

        # Restrictive transitions tag first; release-to-public transitions update
        # authorization metadata first. Both orders fail safe (unavailable rather
        # than anonymously exposed) if the second operation fails.
        if old_visibility == "public" and new_visibility != "public":
            tag_album_visibility(updated, new_visibility, include_derivatives=True)

        condition = (
            "attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status = :active) "
            "AND #visibility = :previous_visibility"
        )
        expression_names = {"#status": "status", "#visibility": "visibility", "#images": "images"}
        expression_values = {
            ":active": "active",
            ":previous_visibility": old_visibility,
        }
        if "images" in album:
            condition += " AND #images = :expected_images"
            expression_values[":expected_images"] = album["images"]
        else:
            condition += " AND attribute_not_exists(#images)"

        table.put_item(
            Item=updated,
            ConditionExpression=condition,
            ExpressionAttributeNames=expression_names,
            ExpressionAttributeValues=expression_values,
        )

        if not (old_visibility == "public" and new_visibility != "public"):
            tag_album_visibility(updated, new_visibility, include_derivatives=True)
        # A second metadata-table join closes the race with a preview worker
        # that registered derivatives while this visibility change was in
        # flight. The worker also re-reads visibility after tagging.
        tag_preview_visibility(updated, new_visibility)
        _audit(
            event,
            context,
            "success",
            "album_updated",
            previous_visibility=old_visibility,
            visibility=new_visibility,
        )
        return json_response(200, serialize_album_summary(updated, include_admin=True))
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
