"""Secure, paginated album catalog/listing endpoint."""

import logging
import os
import hashlib

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from album_access import decode_cursor, encode_cursor
from auth_helpers import AuthError, auth_error_response, get_verified_claims, is_admin
from media_access import serialize_album_summary
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_album_type, validate_email, validate_limit


logger = logging.getLogger("photography_api.catalog")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])


def _index_enabled(kind):
    phase = os.environ.get("ALBUM_INDEX_DEPLOYMENT_PHASE", "none").lower()
    if kind == "visibility":
        return phase in {"visibility", "both"} and bool(os.environ.get("VISIBILITY_CREATED_AT_INDEX"))
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
    admin_all=False, admin_owner_email=None
):
    """Use a configured index, falling back to a security-equivalent filtered scan."""
    query_kind = None
    if not admin_all and owner_sub and _index_enabled("owner"):
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
            elif query_kind == "visibility":
                params = {
                    **common,
                    "IndexName": os.environ["VISIBILITY_CREATED_AT_INDEX"],
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
                query_kind = None
                cursor_key = None
                items = []
                continue
            raise

        items.extend(response.get("Items", []))
        cursor_key = response.get("LastEvaluatedKey")
        if not cursor_key:
            break
    return items[:limit], cursor_key


def handler(event, context):
    try:
        params = (event or {}).get("queryStringParameters") or {}
        claims = get_verified_claims(event, required=False)
        admin = bool(claims and is_admin(claims))
        admin_owner_email = validate_email(params.get("ownerEmail")) if params.get("ownerEmail") else None
        if admin_owner_email and not admin:
            raise AuthError("Forbidden", 403)
        requested_visibility = params.get("visibility", "all" if admin_owner_email else "public")
        album_type = validate_album_type(params.get("type"), default=None) if params.get("type") else None
        limit = validate_limit(params.get("limit"))

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
        )

        records.sort(key=lambda item: item.get("createdAt", ""), reverse=True)
        items = []
        for record in records:
            # Malformed visibility records fail closed and disappear from lists.
            if record.get("status", "active") != "active":
                continue
            if not admin_all and record.get("visibility") != visibility:
                continue
            try:
                items.append(serialize_album_summary(record, include_admin=admin))
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
