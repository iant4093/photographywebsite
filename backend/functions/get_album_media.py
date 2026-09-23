"""Paginated admin media manager backed by a guarded normalized store."""

import os
import hashlib
import json
import re

import boto3

from album_access import decode_cursor, encode_cursor
from album_media_store import MEDIA_STORE_VERSION, normalized_media_item, query_album_media
from auth_helpers import require_admin
from front_door import verify_front_door_request
from media_access import media_id_for_key, serialize_album_detail, serialize_images
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_limit, validate_uuid


albums_table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])


def _raw(image):
    return (image.get("rawKey") or image.get("key") or "") if isinstance(image, dict) else image


def _page_start(cursor, album_id, images, revision):
    if cursor is None:
        return 0
    fields = set(cursor)
    if fields == {"after", "offset", "version"}:
        if not re.fullmatch(r"[0-9]{1,6}", cursor["offset"]) or not re.fullmatch(r"v2:[a-f0-9]{32}", cursor["version"]):
            raise ValidationError("Invalid media cursor")
        if cursor["version"] == revision:
            offset = int(cursor["offset"])
            if offset < 1 or offset > len(images) or _raw(images[offset - 1]) != cursor["after"]:
                raise ValidationError("Invalid media cursor")
            return offset
        # Append/delete/repair can move the anchor. A missing anchor restarts
        # automatically; the existing manager deduplicates by canonical key.
        return next((index + 1 for index, image in enumerate(images) if _raw(image) == cursor["after"]), 0)
    if fields == {"offset"}:  # Cursors already in open pre-upgrade browsers.
        if not re.fullmatch(r"[0-9]{1,6}", cursor["offset"]):
            raise ValidationError("Invalid media cursor")
        return min(int(cursor["offset"]), len(images))
    if fields == {"albumId", "mediaId", "orderKey"}:
        if cursor["albumId"] != album_id or not re.fullmatch(r"[0-9]{12}#[a-f0-9]+", cursor["orderKey"]):
            raise ValidationError("Invalid media cursor")
        if cursor["orderKey"].split("#", 1)[1] != cursor["mediaId"]:
            raise ValidationError("Invalid media cursor")
        return next((index + 1 for index, image in enumerate(images) if media_id_for_key(_raw(image)) == cursor["mediaId"]), 0)
    raise ValidationError("Invalid media cursor")


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    denied = require_admin(event)
    if denied:
        return denied
    try:
        album_id = validate_uuid(((event or {}).get("pathParameters") or {}).get("albumId"))
        params = (event or {}).get("queryStringParameters") or {}
        limit = validate_limit(params.get("limit"), default=48, maximum=100)
        scope = f"admin-media:{album_id}"
        cursor = decode_cursor(params.get("cursor"), scope)
        album = albums_table.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
        if not album or album.get("status", "active") != "active":
            return error_response(404, "Album not found", code="not_found")

        images = album.get("images", []) if isinstance(album.get("images"), list) else []
        revision = "v2:" + hashlib.sha256(json.dumps([_raw(image) for image in images], separators=(",", ":")).encode()).hexdigest()[:32]
        offset = _page_start(cursor, album_id, images, revision)
        items = images[offset:offset + limit]
        if album.get("mediaStoreVersion") == MEDIA_STORE_VERSION:
            start = normalized_media_item(album_id, images[offset - 1], offset - 1) if offset else None
            start_key = {key: start[key] for key in ("albumId", "mediaId", "orderKey")} if start else None
            normalized, _ = query_album_media(album_id, limit, start_key)
            # A GSI can briefly lag a completed repair. The manifest is already
            # in this read, so never lose a page to a partial/stale index view.
            if [_raw(item) for item in normalized] == [_raw(item) for item in items]:
                items = normalized
        next_offset = offset + len(items)
        next_key = {"after": _raw(items[-1]), "offset": str(next_offset), "version": revision} if items and next_offset < len(images) else None
        removed = set((album.get("pendingMediaDeletion") or {}).get("requested", []))
        if removed:
            items = [item for item in items if _raw(item) not in removed]

        media_album = {**album, "images": items}
        album_detail = serialize_album_detail(album, include_admin=True)
        album_detail["imageCount"] = max(
            0,
            int(album.get("imageCount", len(album.get("images", [])))),
        )
        return json_response(
            200,
            {
                "album": album_detail,
                "items": serialize_images(media_album, include_internal=True),
                "nextCursor": encode_cursor(next_key, scope),
                **({"pendingDeletionKeys": album["pendingMediaDeletion"]["requested"]}
                   if album.get("pendingMediaDeletion") else {}),
            },
            cache_control="private, no-store",
        )
    except (TypeError, ValueError, ValidationError) as error:
        return error_response(400, str(error), code="invalid_request")
    except Exception as error:
        return internal_error(context, error, "get_album_media")
