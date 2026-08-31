"""Paginated admin media manager backed by a guarded normalized store."""

import os

import boto3

from album_access import decode_cursor, encode_cursor
from album_media_store import MEDIA_STORE_VERSION, query_album_media
from auth_helpers import require_admin
from front_door import verify_front_door_request
from media_access import serialize_album_detail, serialize_images
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_limit, validate_uuid


albums_table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])


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
        album = albums_table.get_item(Key={"albumId": album_id}, ConsistentRead=False).get("Item")
        if not album or album.get("status", "active") != "active":
            return error_response(404, "Album not found", code="not_found")

        if album.get("mediaStoreVersion") == MEDIA_STORE_VERSION:
            items, next_key = query_album_media(album_id, limit, cursor)
        else:
            images = album.get("images", []) if isinstance(album.get("images"), list) else []
            offset = int((cursor or {}).get("offset", "0"))
            items = images[offset:offset + limit]
            next_offset = offset + len(items)
            next_key = {"offset": str(next_offset)} if next_offset < len(images) else None

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
            },
            cache_control="private, no-store",
        )
    except (TypeError, ValueError, ValidationError) as error:
        return error_response(400, str(error), code="invalid_request")
    except Exception as error:
        return internal_error(context, error, "get_album_media")
