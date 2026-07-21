"""Default-deny album detail endpoint with protected media URLs."""

import os

import boto3

from audit_helpers import actor_context, emit_audit_event
from album_access import authorize_album
from auth_helpers import AuthError, auth_error_response, get_verified_claims, is_admin
from media_access import album_media_prefixes, bucket_name, serialize_album_detail, serialize_images
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_uuid


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
s3 = boto3.client("s3")


def _audit(event, context, outcome, reason_code, *, actor_type=None, auth_method=None):
    classified_actor, classified_auth = actor_context(event)
    emit_audit_event(
        event_name="media.protected_album_access",
        outcome=outcome,
        action="album.protected.access",
        resource_type="album",
        reason_code=reason_code,
        event=event,
        context=context,
        actor_type=actor_type or classified_actor,
        auth_method=auth_method or classified_auth,
    )


def _legacy_images(album):
    images = []
    paginator = s3.get_paginator("list_objects_v2")
    remaining = 1000
    seen = set()
    for prefix in album_media_prefixes(album):
        if remaining <= 0:
            break
        for page in paginator.paginate(
            Bucket=bucket_name(),
            Prefix=prefix,
            PaginationConfig={"MaxItems": remaining},
        ):
            for obj in page.get("Contents", []):
                key = obj.get("Key", "")
                basename = key.rsplit("/", 1)[-1]
                if (
                    not key
                    or key in seen
                    or key.endswith("/")
                    or "_hls/" in key
                    or "/thumbnail/" in key
                    or "/preview/" in key
                    or basename.startswith("thumb_")
                ):
                    continue
                seen.add(key)
                images.append({"rawKey": key})
            remaining = 1000 - len(images)
            if remaining <= 0:
                break
    return images


from front_door import verify_front_door_request


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    protected_request = False
    access_actor = access_auth = None
    try:
        album_id = validate_uuid(((event or {}).get("pathParameters") or {}).get("albumId"))
        response = table.get_item(Key={"albumId": album_id})
        album = response.get("Item")
        if not album:
            return error_response(404, "Album not found", code="not_found")

        protected_request = album.get("visibility") != "public"
        claims = get_verified_claims(event, required=False)
        if claims:
            access_actor, access_auth = ("admin" if is_admin(claims) else "user"), "jwt"
        access_mode = authorize_album(album, claims=claims)
        if not album.get("images"):
            album = {**album, "images": _legacy_images(album)}

        include_admin = access_mode == "admin"
        body = {
            "album": serialize_album_detail(album, include_admin=include_admin),
            "images": serialize_images(album, include_internal=include_admin),
        }
        cache_control = "public, max-age=60, s-maxage=300" if access_mode == "public" else "no-store"
        if protected_request:
            _audit(
                event, context, "success", "protected_access_granted",
                actor_type=access_actor, auth_method=access_auth,
            )
        return json_response(200, body, cache_control=cache_control)
    except AuthError as error:
        if protected_request:
            _audit(
                event, context, "denied", "protected_access_denied",
                actor_type=access_actor, auth_method=access_auth,
            )
        return auth_error_response(error)
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_request")
    except Exception as error:
        if protected_request:
            _audit(
                event, context, "failure", "unexpected_error",
                actor_type=access_actor, auth_method=access_auth,
            )
        return internal_error(context, error, "get_album")
