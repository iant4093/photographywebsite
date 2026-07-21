"""Anonymous-only public catalog optimized for edge caching."""

import logging
import os
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from cursor_helpers import decode_cursor, encode_cursor
from media_access import serialize_album_summary
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_album_type, validate_limit


logger = logging.getLogger("photography_api.public_catalog")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])

ALLOWED_QUERY_PARAMETERS = frozenset({"cursor", "limit", "type"})


def _type_filter(album_type):
    if not album_type:
        return None
    expression = Attr("type").eq(album_type)
    if album_type == "photo":
        expression |= Attr("type").not_exists()
    return expression


def _valid_image_count(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value >= 0
    return isinstance(value, Decimal) and value >= 0 and value == value.to_integral_value()


def _index_enabled(index_name):
    phase = os.environ.get("ALBUM_INDEX_DEPLOYMENT_PHASE", "none").lower()
    if index_name == "summary":
        return phase in {"summary", "both"} and bool(os.environ.get("PUBLIC_SUMMARY_INDEX"))
    return phase in {"visibility", "summary", "both"} and bool(
        os.environ.get("VISIBILITY_CREATED_AT_INDEX")
    )


def _active_filter(album_type):
    expression = Attr("status").not_exists() | Attr("status").eq("active")
    type_filter = _type_filter(album_type)
    return expression if type_filter is None else expression & type_filter


def _fetch_page(*, album_type, limit, start_key):
    """Query the narrow index and retain security-equivalent rollout fallbacks."""
    query_kind = "summary" if _index_enabled("summary") else (
        "visibility" if _index_enabled("visibility") else None
    )
    cursor_key = start_key
    items = []
    loops = 0
    while len(items) < limit and loops < 12:
        loops += 1
        remaining = limit - len(items)
        common = {"Limit": remaining}
        if cursor_key:
            common["ExclusiveStartKey"] = cursor_key
        try:
            if query_kind:
                response = table.query(
                    **common,
                    IndexName=(
                        os.environ["PUBLIC_SUMMARY_INDEX"]
                        if query_kind == "summary"
                        else os.environ["VISIBILITY_CREATED_AT_INDEX"]
                    ),
                    KeyConditionExpression=Key("visibility").eq("public"),
                    FilterExpression=_active_filter(album_type),
                    ScanIndexForward=False,
                )
            else:
                response = table.scan(
                    **common,
                    FilterExpression=(
                        Attr("visibility").eq("public") & _active_filter(album_type)
                    ),
                )
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            if query_kind and code in {"ValidationException", "ResourceNotFoundException"}:
                logger.warning("public_catalog_index_unavailable kind=%s", query_kind)
                if query_kind == "summary" and _index_enabled("visibility"):
                    # Both public indexes have the same visibility/createdAt
                    # key schema. Resume from the exact failed page so a
                    # rollout fallback cannot repeat earlier albums.
                    query_kind = "visibility"
                else:
                    # A table scan has a different pagination contract, so it
                    # must restart rather than reuse an index cursor.
                    query_kind = None
                    cursor_key = None
                    items = []
                    loops = 0
                continue
            raise

        page_items = response.get("Items", [])
        if query_kind == "summary" and any(
            not _valid_image_count(item.get("imageCount")) for item in page_items
        ):
            # Legacy aggregates must never cause albums or counts to disappear.
            logger.warning("public_catalog_summary_incomplete field=image_count")
            if _index_enabled("visibility"):
                # The response has not been appended yet. Preserve both the
                # caller's cursor and any prior complete pages, then re-read
                # only this page from the full projection index.
                query_kind = "visibility"
            else:
                query_kind = None
                cursor_key = None
                items = []
                loops = 0
            continue

        items.extend(page_items)
        cursor_key = response.get("LastEvaluatedKey")
        if not cursor_key:
            break
    return items[:limit], cursor_key


from front_door import verify_front_door_request


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    try:
        params = (event or {}).get("queryStringParameters") or {}
        if not isinstance(params, dict) or any(name not in ALLOWED_QUERY_PARAMETERS for name in params):
            raise ValidationError("Unsupported public catalog parameter")
        album_type = validate_album_type(params.get("type"), default=None) if params.get("type") else None
        limit = validate_limit(params.get("limit"), default=100, maximum=100)
        scope = f"public:{album_type or '*'}"
        start_key = decode_cursor(params.get("cursor"), scope)
        records, last_key = _fetch_page(
            album_type=album_type,
            limit=limit,
            start_key=start_key,
        )

        records.sort(key=lambda item: item.get("createdAt", ""), reverse=True)
        items = []
        for record in records:
            if record.get("status", "active") != "active" or record.get("visibility") != "public":
                continue
            try:
                summary = serialize_album_summary(record)
                image_count = record.get("imageCount")
                if "images" not in record and _valid_image_count(image_count):
                    summary["imageCount"] = int(image_count)
                items.append(summary)
            except ValidationError:
                continue

        return json_response(
            200,
            {"items": items, "nextCursor": encode_cursor(last_key, scope)},
            cache_control="public, max-age=60, s-maxage=300, stale-while-revalidate=60",
        )
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_request")
    except Exception as error:
        return internal_error(context, error, "list_public_albums")
