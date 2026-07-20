"""Validated album metadata/visibility update with derivative retagging."""

import os
import secrets

import boto3

from album_mutation_helpers import resolve_owner as _resolve_owner
from album_mutation_helpers import validate_created_at as _validate_created_at
from auth_helpers import require_admin
from media_access import serialize_album_summary, tag_album_visibility, validate_album_media_key
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


def handler(event, context):
    denied = require_admin(event)
    if denied:
        return denied
    try:
        album_id = validate_uuid(((event or {}).get("pathParameters") or {}).get("albumId"))
        body = parse_json_body(event)
        if not body:
            return error_response(400, "No fields to update", code="invalid_album")
        album = table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not album or album.get("status", "active") != "active":
            return error_response(404, "Album not found", code="not_found")
        updated = _updated_album(album, body)
        old_visibility = album.get("visibility")
        new_visibility = updated["visibility"]

        # Restrictive transitions tag first; release-to-public transitions update
        # authorization metadata first. Both orders fail safe (unavailable rather
        # than anonymously exposed) if the second operation fails.
        if old_visibility == "public" and new_visibility != "public":
            tag_album_visibility(updated, new_visibility, include_derivatives=True)

        table.put_item(
            Item=updated,
            ConditionExpression="attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status = :active)",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":active": "active"},
        )

        if not (old_visibility == "public" and new_visibility != "public"):
            tag_album_visibility(updated, new_visibility, include_derivatives=True)
        return json_response(200, serialize_album_summary(updated, include_admin=True))
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_album")
    except Exception as error:
        return internal_error(context, error, "update_album")
