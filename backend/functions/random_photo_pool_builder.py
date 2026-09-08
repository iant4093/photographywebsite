"""Rebuild materialized random-photo decks after public album mutations."""

import logging
import os

import boto3
from boto3.dynamodb.conditions import Attr, Key

from media_access import album_media_prefixes, bucket_name, load_preview_metadata_for_albums
from cache_invalidation import request_public_api_invalidation
from random_photo_pools import build_pool_previews, build_reference_pools, replace_materialized_pools


logger = logging.getLogger("photography_api.random_photo_pool_builder")
dynamodb = boto3.resource("dynamodb")
albums_table = dynamodb.Table(os.environ["ALBUMS_TABLE"])
preview_table = dynamodb.Table(os.environ["PREVIEW_METADATA_TABLE"])
s3 = boto3.client("s3")


def _public_photo_albums():
    albums = []
    cursor = None
    while True:
        query = {
            "IndexName": os.environ["VISIBILITY_CREATED_AT_INDEX"],
            "KeyConditionExpression": Key("visibility").eq("public"),
            "FilterExpression": (
                (Attr("status").not_exists() | Attr("status").eq("active"))
                & (Attr("type").not_exists() | Attr("type").eq("photo"))
            ),
            "ScanIndexForward": False,
        }
        if cursor:
            query["ExclusiveStartKey"] = cursor
        response = albums_table.query(**query)
        albums.extend(item for item in response.get("Items", []) if isinstance(item, dict))
        cursor = response.get("LastEvaluatedKey")
        if not cursor:
            return albums


def _legacy_images(album):
    images = []
    seen = set()
    paginator = s3.get_paginator("list_objects_v2")
    for prefix in album_media_prefixes(album):
        for page in paginator.paginate(Bucket=bucket_name(), Prefix=prefix):
            for item in page.get("Contents", []):
                key = item.get("Key")
                basename = key.rsplit("/", 1)[-1] if isinstance(key, str) else ""
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
    return images


def handler(event, context):
    albums = _public_photo_albums()
    for album in albums:
        if not album.get("images"):
            album["images"] = _legacy_images(album)
    pools = build_reference_pools(albums)
    metadata = load_preview_metadata_for_albums([(album, None) for album in albums])
    previews = build_pool_previews(albums, metadata)
    result = replace_materialized_pools(preview_table, pools, previews=previews)
    logger.info(
        "random_photo_pools_refreshed pool_count=%d total_photos=%d changed=%s",
        result["poolCount"],
        result["totalPhotos"],
        result["changed"],
    )
    if result["changed"] and os.environ.get("CACHE_INVALIDATION_QUEUE_URL", "").strip():
        request_public_api_invalidation(random_photos=True, reason="random-photo-pool-refreshed")
    return result
