"""Anonymous-only public album detail optimized for edge caching."""

import os

import boto3

from media_access import (
    album_media_prefixes,
    bucket_name,
    serialize_album_detail,
    serialize_images,
)
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, validate_uuid


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
s3 = boto3.client("s3")


def _legacy_images(album):
    images = []
    seen = set()
    remaining = 1000
    paginator = s3.get_paginator("list_objects_v2")
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
    try:
        if (event or {}).get("queryStringParameters"):
            raise ValidationError("Public album detail does not accept query parameters")
        album_id = validate_uuid(((event or {}).get("pathParameters") or {}).get("albumId"))
        album = table.get_item(Key={"albumId": album_id}).get("Item")
        # Hide the existence and state of every non-public or malformed record.
        if (
            not album
            or album.get("visibility") != "public"
            or album.get("status", "active") != "active"
        ):
            return error_response(404, "Album not found", code="not_found")
        if not album.get("images"):
            album = {**album, "images": _legacy_images(album)}
        body = {
            "album": serialize_album_detail(album),
            "images": serialize_images(album),
        }
        return json_response(
            200,
            body,
            cache_control="public, max-age=60, s-maxage=300, stale-while-revalidate=60",
        )
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_request")
    except Exception as error:
        return internal_error(context, error, "get_public_album")
