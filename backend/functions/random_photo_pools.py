"""Materialized, sharded random-photo decks shared by the builder and API."""

from __future__ import annotations

import datetime as dt
import hashlib
import re
import secrets

from media_access import media_id_for_key
from validation_helpers import ValidationError


POOL_PARTITION = "__random_photo_pools_v1__"
POOL_SCHEMA_VERSION = 1
POOL_RECORD_TYPE = "randomPhotoPool"
POOL_SHARD_RECORD_TYPE = "randomPhotoPoolShard"
POOL_SHARD_SIZE = 256
POOL_WINDOW_SECONDS = 300
DEFAULT_SAMPLE_LIMIT = 80
GENERATION_PATTERN = re.compile(r"^[a-f0-9]{16}$")
REFERENCE_PATTERN = re.compile(
    r"^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([a-f0-9]{24})$"
)


def normalized_category(value):
    if not isinstance(value, str):
        return "Uncategorized"
    normalized = " ".join(value.strip().split())[:100]
    return normalized or "Uncategorized"


def pool_id(category=None):
    if category is None:
        return "all"
    return hashlib.sha256(normalized_category(category).encode("utf-8")).hexdigest()[:24]


def metadata_sort_key(category=None):
    return f"pool#{pool_id(category)}#meta"


def shard_sort_key(pool_identifier, generation, index):
    return f"pool#{pool_identifier}#generation#{generation}#shard#{index:04d}"


def compact_reference(album_id, media_id):
    reference = f"{album_id}:{media_id}"
    if not REFERENCE_PATTERN.fullmatch(reference):
        raise ValidationError("Invalid random photo reference")
    return reference


def parse_reference(value):
    match = REFERENCE_PATTERN.fullmatch(value or "")
    if not match:
        raise ValidationError("Invalid random photo reference")
    return {"albumId": match.group(1), "mediaId": match.group(2)}


def _active_public_photo_album(album):
    return bool(
        isinstance(album, dict)
        and album.get("visibility") == "public"
        and album.get("status", "active") == "active"
        and album.get("type", "photo") == "photo"
    )


def build_reference_pools(albums, *, legacy_loader=None, randomizer=None):
    """Build one shuffled deck for all photos and one for every category."""
    pools = {None: []}
    seen = {None: set()}
    for album in albums:
        if not _active_public_photo_album(album):
            continue
        album_id = album.get("albumId")
        category = normalized_category(album.get("category"))
        images = album.get("images")
        if not isinstance(images, list) or not images:
            images = legacy_loader(album) if legacy_loader else []
        pools.setdefault(category, [])
        seen.setdefault(category, set())
        for image in images if isinstance(images, list) else []:
            raw_key = image.get("rawKey") if isinstance(image, dict) else None
            if not isinstance(raw_key, str) or not raw_key:
                continue
            try:
                reference = compact_reference(album_id, media_id_for_key(raw_key))
            except (TypeError, ValidationError):
                continue
            if reference in seen[None]:
                continue
            seen[None].add(reference)
            seen[category].add(reference)
            pools[None].append(reference)
            pools[category].append(reference)

    shuffler = randomizer or secrets.SystemRandom()
    for references in pools.values():
        shuffler.shuffle(references)
    return pools


def _generated_at(value=None):
    if value is None:
        value = dt.datetime.now(dt.timezone.utc)
    if not isinstance(value, dt.datetime):
        raise TypeError("generated_at must be a datetime")
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def replace_materialized_pools(table, pools, *, generation=None, generated_at=None):
    """Publish new immutable shards, switch metadata, then delete old shards."""
    generation = generation or secrets.token_hex(8)
    if not GENERATION_PATTERN.fullmatch(generation):
        raise ValueError("generation must be 16 lowercase hexadecimal characters")
    generated_at = _generated_at(generated_at)
    desired_keys = set()
    metadata_items = []

    with table.batch_writer() as batch:
        for category, references in pools.items():
            identifier = pool_id(category)
            shard_count = (len(references) + POOL_SHARD_SIZE - 1) // POOL_SHARD_SIZE
            for index in range(shard_count):
                sort_key = shard_sort_key(identifier, generation, index)
                desired_keys.add(sort_key)
                batch.put_item(Item={
                    "albumId": POOL_PARTITION,
                    "mediaId": sort_key,
                    "recordType": POOL_SHARD_RECORD_TYPE,
                    "schemaVersion": POOL_SCHEMA_VERSION,
                    "poolId": identifier,
                    "generation": generation,
                    "shardIndex": index,
                    "references": references[
                        index * POOL_SHARD_SIZE:(index + 1) * POOL_SHARD_SIZE
                    ],
                })
            meta_key = metadata_sort_key(category)
            desired_keys.add(meta_key)
            metadata_items.append({
                "albumId": POOL_PARTITION,
                "mediaId": meta_key,
                "recordType": POOL_RECORD_TYPE,
                "schemaVersion": POOL_SCHEMA_VERSION,
                "poolId": identifier,
                "generation": generation,
                "category": category if category is not None else "",
                "totalPhotos": len(references),
                "shardSize": POOL_SHARD_SIZE,
                "shardCount": shard_count,
                "generatedAt": generated_at,
            })

    # Each metadata write is the atomic pointer switch for one complete deck.
    for item in metadata_items:
        table.put_item(Item=item)

    existing_keys = set()
    cursor = None
    while True:
        query = {
            "KeyConditionExpression": "albumId = :partition",
            "ExpressionAttributeValues": {":partition": POOL_PARTITION},
            "ProjectionExpression": "mediaId",
        }
        if cursor:
            query["ExclusiveStartKey"] = cursor
        response = table.query(**query)
        existing_keys.update(
            item.get("mediaId")
            for item in response.get("Items", [])
            if isinstance(item, dict) and isinstance(item.get("mediaId"), str)
        )
        cursor = response.get("LastEvaluatedKey")
        if not cursor:
            break

    stale_keys = sorted(existing_keys - desired_keys)
    if stale_keys:
        with table.batch_writer() as batch:
            for sort_key in stale_keys:
                batch.delete_item(Key={"albumId": POOL_PARTITION, "mediaId": sort_key})
    return {
        "generation": generation,
        "poolCount": len(metadata_items),
        "totalPhotos": len(pools.get(None, [])),
    }


def _valid_metadata(item, category):
    if not isinstance(item, dict):
        return None
    identifier = pool_id(category)
    try:
        total = int(item.get("totalPhotos"))
        shard_size = int(item.get("shardSize"))
        shard_count = int(item.get("shardCount"))
        schema_version = int(item.get("schemaVersion"))
    except (TypeError, ValueError):
        return None
    generation = item.get("generation")
    expected_category = normalized_category(category) if category is not None else ""
    if (
        item.get("recordType") != POOL_RECORD_TYPE
        or schema_version != POOL_SCHEMA_VERSION
        or item.get("poolId") != identifier
        or item.get("category", "") != expected_category
        or not isinstance(generation, str)
        or not GENERATION_PATTERN.fullmatch(generation)
        or total < 0
        or shard_size != POOL_SHARD_SIZE
        or shard_count != (total + POOL_SHARD_SIZE - 1) // POOL_SHARD_SIZE
    ):
        return None
    return {
        "poolId": identifier,
        "generation": generation,
        "totalPhotos": total,
        "shardCount": shard_count,
        "generatedAt": item.get("generatedAt", ""),
    }


def _batch_get_shards(resource, table, keys):
    request = {
        table.name: {
            "Keys": [{"albumId": POOL_PARTITION, "mediaId": key} for key in keys],
            "ConsistentRead": False,
        }
    }
    items = {}
    for _attempt in range(3):
        response = resource.batch_get_item(RequestItems=request)
        for item in response.get("Responses", {}).get(table.name, []):
            if isinstance(item, dict) and isinstance(item.get("mediaId"), str):
                items[item["mediaId"]] = item
        unprocessed = response.get("UnprocessedKeys", {}).get(table.name, {}).get("Keys", [])
        if not unprocessed:
            return items
        request[table.name]["Keys"] = unprocessed
    raise RuntimeError("Random photo pool shard reads remained unprocessed")


def load_pool_references(table, resource, category=None, *, now=None, limit=DEFAULT_SAMPLE_LIMIT):
    """Read only the shards needed for this five-minute sample window."""
    metadata = table.get_item(
        Key={"albumId": POOL_PARTITION, "mediaId": metadata_sort_key(category)},
        ConsistentRead=False,
    ).get("Item")
    valid = _valid_metadata(metadata, category)
    if valid is None:
        # A valid all-photo record is also the readiness marker. Once present,
        # a missing category is a cheap empty result instead of a legacy scan.
        if category is None:
            return None
        ready = table.get_item(
            Key={"albumId": POOL_PARTITION, "mediaId": metadata_sort_key(None)},
            ConsistentRead=False,
        ).get("Item")
        return {
            "references": [],
            "totalPhotos": 0,
            "generatedAt": ready.get("generatedAt", ""),
        } if _valid_metadata(ready, None) is not None else None

    total = valid["totalPhotos"]
    take = min(max(1, int(limit)), DEFAULT_SAMPLE_LIMIT, total) if total else 0
    if take == 0:
        return {"references": [], "totalPhotos": 0, "generatedAt": valid["generatedAt"]}
    if now is None:
        now = dt.datetime.now(dt.timezone.utc).timestamp()
    elif isinstance(now, dt.datetime):
        now = now.timestamp()
    window = int(float(now)) // POOL_WINDOW_SECONDS
    material = f"{valid['generation']}\0{valid['poolId']}\0{window}".encode("utf-8")
    start = int.from_bytes(hashlib.sha256(material).digest()[:8], "big") % total
    positions = [(start + offset) % total for offset in range(take)]
    shard_indexes = sorted({position // POOL_SHARD_SIZE for position in positions})
    shard_keys = [
        shard_sort_key(valid["poolId"], valid["generation"], index)
        for index in shard_indexes
    ]
    shards = _batch_get_shards(resource, table, shard_keys)

    references_by_position = {}
    for index, key in zip(shard_indexes, shard_keys):
        item = shards.get(key)
        values = item.get("references") if isinstance(item, dict) else None
        try:
            schema_version = int(item.get("schemaVersion"))
            shard_index = int(item.get("shardIndex"))
        except (AttributeError, TypeError, ValueError):
            return None
        if (
            item is None
            or item.get("recordType") != POOL_SHARD_RECORD_TYPE
            or schema_version != POOL_SCHEMA_VERSION
            or item.get("poolId") != valid["poolId"]
            or item.get("generation") != valid["generation"]
            or shard_index != index
            or not isinstance(values, list)
            or len(values) > POOL_SHARD_SIZE
        ):
            return None
        for offset, value in enumerate(values):
            references_by_position[(index * POOL_SHARD_SIZE) + offset] = value

    try:
        references = [parse_reference(references_by_position[position]) for position in positions]
    except (KeyError, ValidationError):
        return None
    return {
        "references": references,
        "totalPhotos": total,
        "generatedAt": valid["generatedAt"],
    }
