"""Favorite-only decks, isolated from the unfiltered random-photo partition."""

from random_photo_pools import (
    build_reference_pools,
    load_pool_references,
    replace_materialized_pools,
)


FEATURED_POOL_PARTITION = "__featured_photo_pools_v1__"


def featured_images(album):
    """Normalize both manifest key formats supported by the favorite editor."""
    images = album.get("images")
    if not isinstance(images, list):
        return []
    result = []
    for image in images:
        if not isinstance(image, dict) or image.get("isFavorite") is not True:
            continue
        raw_key = image.get("rawKey") or image.get("key")
        if isinstance(raw_key, str) and raw_key:
            result.append({**image, "rawKey": raw_key})
    return result


def build_featured_reference_pools(albums, *, randomizer=None):
    # Favorites live in the album manifest. Legacy S3 listings have no favorite
    # metadata and must never become featured candidates.
    featured_albums = [
        {**album, "images": featured_images(album)}
        for album in albums if isinstance(album, dict)
    ]
    return build_reference_pools(featured_albums, randomizer=randomizer)


def replace_featured_pools(table, pools, *, previews=None):
    return replace_materialized_pools(
        table, pools, previews=previews, partition=FEATURED_POOL_PARTITION,
    )


def load_featured_references(table, resource, category=None, *, limit=80):
    return load_pool_references(
        table, resource, category, limit=limit, partition=FEATURED_POOL_PARTITION,
    )
