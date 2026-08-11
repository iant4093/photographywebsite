"""Secure, paginated album catalog/listing endpoint."""

import logging
import os
import hashlib
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from album_access import decode_cursor, encode_cursor
from auth_helpers import AuthError, auth_error_response, get_verified_claims, is_admin
from gallery_order import apply_gallery_order, load_gallery_settings
from media_access import serialize_album_summary
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_album_type, validate_email, validate_limit


logger = logging.getLogger("photography_api.catalog")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
settings_table = dynamodb.Table(os.environ["GALLERY_SETTINGS_TABLE"])


def _index_enabled(kind):
    phase = os.environ.get("ALBUM_INDEX_DEPLOYMENT_PHASE", "none").lower()
    if kind == "visibility":
        return phase in {"visibility", "summary", "both"} and bool(os.environ.get("VISIBILITY_CREATED_AT_INDEX"))
    if kind == "public_summary":
        return phase in {"summary", "both"} and bool(os.environ.get("PUBLIC_SUMMARY_INDEX"))
    return phase == "both" and bool(os.environ.get("OWNER_SUB_CREATED_AT_INDEX"))


def _type_filter(album_type):
    if not album_type:
        return None
    expression = Attr("type").eq(album_type)
    # Albums created before the type field was introduced were always photos.
    # Keep that established default when a caller explicitly requests photos.
    if album_type == "photo":
        expression |= Attr("type").not_exists()
    return expression


def _valid_image_count(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value >= 0
    return isinstance(value, Decimal) and value >= 0 and value == value.to_integral_value()


def _filter_for(visibility, album_type=None, *, owner_sub=None, owner_email=None):
    expression = Attr("visibility").eq(visibility)
    type_filter = _type_filter(album_type)
    if type_filter is not None:
        expression &= type_filter
    if owner_sub and owner_email:
        expression &= (
            Attr("ownerSub").eq(owner_sub)
            | (Attr("ownerSub").not_exists() & Attr("ownerEmail").eq(owner_email))
        )
    elif owner_sub:
        expression &= Attr("ownerSub").eq(owner_sub)
    elif owner_email:
        expression &= Attr("ownerEmail").eq(owner_email)
    return expression


def _fetch_page(
    *, visibility, album_type, limit, start_key, owner_sub=None, owner_email=None,
    admin_all=False, admin_owner_email=None, public_summary_only=False,
):
    """Use a configured index, falling back to a security-equivalent filtered scan."""
    query_kind = None
    if public_summary_only and visibility == "public" and _index_enabled("public_summary"):
        query_kind = "public_summary"
    elif not admin_all and owner_sub and _index_enabled("owner"):
        query_kind = "owner"
    elif not admin_all and not owner_sub and _index_enabled("visibility"):
        query_kind = "visibility"

    items = []
    cursor_key = start_key
    loops = 0
    while len(items) < limit and loops < 12:
        loops += 1
        remaining = limit - len(items)
        common = {"Limit": remaining, "ExclusiveStartKey": cursor_key} if cursor_key else {"Limit": remaining}
        try:
            if query_kind == "owner":
                params = {
                    **common,
                    "IndexName": os.environ["OWNER_SUB_CREATED_AT_INDEX"],
                    "KeyConditionExpression": Key("ownerSub").eq(owner_sub),
                    "ScanIndexForward": False,
                    "FilterExpression": _filter_for(visibility, album_type),
                }
                response = table.query(**params)
            elif query_kind in {"visibility", "public_summary"}:
                params = {
                    **common,
                    "IndexName": (
                        os.environ["PUBLIC_SUMMARY_INDEX"]
                        if query_kind == "public_summary"
                        else os.environ["VISIBILITY_CREATED_AT_INDEX"]
                    ),
                    "KeyConditionExpression": Key("visibility").eq(visibility),
                    "ScanIndexForward": False,
                }
                filter_expression = _type_filter(album_type)
                if admin_owner_email:
                    owner_filter = Attr("ownerEmail").eq(admin_owner_email)
                    filter_expression = owner_filter if filter_expression is None else filter_expression & owner_filter
                if filter_expression is not None:
                    params["FilterExpression"] = filter_expression
                response = table.query(**params)
            else:
                if admin_all:
                    filter_expression = _type_filter(album_type)
                    if admin_owner_email:
                        owner_filter = Attr("ownerEmail").eq(admin_owner_email)
                        filter_expression = owner_filter if filter_expression is None else filter_expression & owner_filter
                else:
                    filter_expression = _filter_for(
                        visibility,
                        album_type,
                        owner_sub=owner_sub,
                        owner_email=owner_email,
                    )
                    if admin_owner_email:
                        filter_expression &= Attr("ownerEmail").eq(admin_owner_email)
                params = {**common}
                if filter_expression is not None:
                    params["FilterExpression"] = filter_expression
                response = table.scan(**params)
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            if query_kind and code in {"ValidationException", "ResourceNotFoundException"}:
                logger.warning("album_index_unavailable kind=%s", query_kind)
                # A summary index rollout can fall back to the existing ALL
                # visibility index before using the bounded filtered scan.
                # Those two indexes share an exact key schema, so retain the
                # cursor and completed pages when switching between them.
                if query_kind == "public_summary" and _index_enabled("visibility"):
                    query_kind = "visibility"
                else:
                    query_kind = None
                    cursor_key = None
                    items = []
                    loops = 0
                continue
            raise

        page_items = response.get("Items", [])
        if query_kind == "public_summary" and any(
            not _valid_image_count(item.get("imageCount")) for item in page_items
        ):
            # Existing legacy records may predate the aggregate. Until they are
            # backfilled, use the established ALL index so counts never regress.
            logger.warning("album_summary_index_incomplete field=image_count")
            if _index_enabled("visibility"):
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
        claims = get_verified_claims(event, required=False)
        admin = bool(claims and is_admin(claims))
        admin_owner_email = validate_email(params.get("ownerEmail")) if params.get("ownerEmail") else None
        if admin_owner_email and not admin:
            raise AuthError("Forbidden", 403)
        requested_visibility = params.get("visibility", "all" if admin_owner_email else "public")
        album_type = validate_album_type(params.get("type"), default=None) if params.get("type") else None
        # Catalog summaries are intentionally small and the public inventory is
        # currently below 100, so one bounded query avoids sequential page RTTs.
        limit = validate_limit(params.get("limit"), maximum=100)

        if not claims:
            # Anonymous query parameters never elevate or select protected data.
            visibility = "public"
            owner_sub = owner_email = None
            admin_all = False
            scope = f"public:{album_type or '*'}"
        elif admin and requested_visibility == "all":
            visibility = "all"
            owner_sub = owner_email = None
            admin_all = True
            owner_scope = hashlib.sha256(admin_owner_email.encode("utf-8")).hexdigest()[:16] if admin_owner_email else "*"
            scope = f"admin:all:{album_type or '*'}:{owner_scope}"
        elif admin and requested_visibility in {"public", "private", "unlisted"}:
            visibility = requested_visibility
            owner_sub = owner_email = None
            admin_all = False
            owner_scope = hashlib.sha256(admin_owner_email.encode("utf-8")).hexdigest()[:16] if admin_owner_email else "*"
            scope = f"admin:{visibility}:{album_type or '*'}:{owner_scope}"
        elif requested_visibility == "public":
            visibility = "public"
            owner_sub = owner_email = None
            admin_all = False
            scope = f"public:{album_type or '*'}"
        elif requested_visibility == "private":
            visibility = "private"
            owner_sub = str(claims.get("sub", ""))
            owner_email = str(claims.get("email", "")).strip().lower()
            admin_all = False
            scope = f"owner:{owner_sub}:{album_type or '*'}"
        else:
            raise AuthError("Forbidden", 403)

        start_key = decode_cursor(params.get("cursor"), scope)
        records, last_key = _fetch_page(
            visibility=visibility,
            album_type=album_type,
            limit=limit,
            start_key=start_key,
            owner_sub=owner_sub,
            owner_email=owner_email,
            admin_all=admin_all,
            admin_owner_email=admin_owner_email,
            public_summary_only=visibility == "public" and not admin_owner_email,
        )

        records.sort(key=lambda item: item.get("createdAt", ""), reverse=True)
        gallery_settings = (
            load_gallery_settings(settings_table, logger)
            if visibility == "public" and album_type in {None, "photo", "video"}
            else {}
        )
        items = []
        for record in records:
            # Malformed visibility records fail closed and disappear from lists.
            if record.get("status", "active") != "active":
                continue
            if not admin_all and record.get("visibility") != visibility:
                continue
            try:
                summary = serialize_album_summary(record, include_admin=admin)
                # The summary-only GSI intentionally excludes the media
                # manifest. Preserve the established count from the dedicated
                # aggregate attribute instead of hydrating `images`.
                image_count = record.get("imageCount")
                if "images" not in record and _valid_image_count(image_count):
                    summary["imageCount"] = max(0, int(image_count))
                items.append(apply_gallery_order(summary, gallery_settings))
            except ValidationError:
                continue

        # Compatibility bridge for the current public homepage. Updated clients
        # request type/limit/cursor and receive the paginated object.
        compatibility_array = (
            claims is None
            and not any(name in params for name in ("limit", "cursor", "type", "ownerEmail"))
            and requested_visibility in {None, "", "public"}
        )
        cache_control = "public, max-age=60, s-maxage=300" if visibility == "public" and not admin else "no-store"
        if compatibility_array:
            return json_response(200, items, cache_control=cache_control)
        return json_response(
            200,
            {"items": items, "nextCursor": encode_cursor(last_key, scope)},
            cache_control=cache_control,
        )
    except AuthError as error:
        return auth_error_response(error)
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_request")
    except Exception as error:
        return internal_error(context, error, "list_albums")
