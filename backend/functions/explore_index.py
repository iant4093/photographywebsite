"""Deterministic contracts for the materialized Explore lookup partitions.

Explore rows live in reserved partitions of the retained preview-metadata table.
They contain references only; public serialization still joins the current
preview record and authoritative album manifest before returning any media.
"""

from __future__ import annotations

import hashlib
import re


INDEX_VERSION = 1
EXPLORE_VERSION = 2
INDEX_RECORD_TYPE = "explore-index-v1"
FACET_RECORD_TYPE = "explore-facet-v1"
READY_RECORD_TYPE = "explore-ready-v1"
INDEX_PREFIX = "__EXPLORE_V1__"
FACETS_PARTITION = f"{INDEX_PREFIX}#FACETS"
SYSTEM_PARTITION = f"{INDEX_PREFIX}#SYSTEM"
READY_SORT_KEY = "READY"
COLOR_FAMILIES = frozenset({
    "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "monochrome",
})
MEDIA_ID_PATTERN = re.compile(r"^[a-f0-9]{24}$")
ALBUM_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def facet_partition(mode: str, value: str) -> str:
    if mode == "color":
        normalized = value.strip().lower() if isinstance(value, str) else ""
        if normalized not in COLOR_FAMILIES:
            raise ValueError("unsupported color facet")
        return f"{INDEX_PREFIX}#COLOR#{normalized}"
    if mode == "lens":
        normalized = " ".join(value.strip().split()).casefold() if isinstance(value, str) else ""
        if not normalized or len(normalized) > 160:
            raise ValueError("invalid lens facet")
        return f"{INDEX_PREFIX}#LENS#{normalized}"
    raise ValueError("unsupported Explore facet mode")


def index_sort_key(album_id: str, media_id: str) -> str:
    if not isinstance(album_id, str) or not ALBUM_ID_PATTERN.fullmatch(album_id):
        raise ValueError("invalid album reference")
    if not isinstance(media_id, str) or not MEDIA_ID_PATTERN.fullmatch(media_id):
        raise ValueError("invalid media reference")
    random_key = hashlib.sha256(f"{album_id}\0{media_id}".encode("utf-8")).hexdigest()[:16]
    return f"{random_key}#{album_id}#{media_id}"


def metadata_facets(metadata) -> dict[str, str]:
    if not isinstance(metadata, dict):
        return {}
    if metadata.get("status") != "ready" or metadata.get("exploreVersion") != EXPLORE_VERSION:
        return {}
    facets = {}
    families = metadata.get("colorFamilies")
    if isinstance(families, list):
        for family in set(families):
            if family in COLOR_FAMILIES:
                facets[facet_partition("color", family)] = family
    lens = metadata.get("lens")
    lens_key = metadata.get("lensKey")
    if (
        isinstance(lens, str)
        and lens.strip()
        and len(lens.strip()) <= 160
        and isinstance(lens_key, str)
        and lens_key == " ".join(lens.strip().split()).casefold()
    ):
        facets[facet_partition("lens", lens_key)] = " ".join(lens.strip().split())
    return facets


def index_entry(metadata: dict, partition: str) -> dict:
    album_id = metadata.get("albumId")
    media_id = metadata.get("mediaId")
    return {
        "albumId": partition,
        "mediaId": index_sort_key(album_id, media_id),
        "recordType": INDEX_RECORD_TYPE,
        "indexVersion": INDEX_VERSION,
        "sourceAlbumId": album_id,
        "sourceMediaId": media_id,
    }


def facet_definition(partition: str, label: str) -> dict | None:
    if not partition.startswith(f"{INDEX_PREFIX}#LENS#"):
        return None
    return {
        "albumId": FACETS_PARTITION,
        "mediaId": partition.removeprefix(f"{INDEX_PREFIX}#"),
        "recordType": FACET_RECORD_TYPE,
        "indexVersion": INDEX_VERSION,
        "facetPartition": partition,
        "name": label,
    }


def ready_marker() -> dict:
    return {
        "albumId": SYSTEM_PARTITION,
        "mediaId": READY_SORT_KEY,
        "recordType": READY_RECORD_TYPE,
        "indexVersion": INDEX_VERSION,
    }


def desired_index_records(metadata: dict, *, public: bool) -> list[dict]:
    if not public:
        return []
    facets = metadata_facets(metadata)
    records = [index_entry(metadata, partition) for partition in sorted(facets)]
    records.extend(
        definition
        for partition, label in sorted(facets.items())
        if (definition := facet_definition(partition, label)) is not None
    )
    return records


def index_entry_keys(metadata: dict) -> list[dict]:
    try:
        sort_key = index_sort_key(metadata.get("albumId"), metadata.get("mediaId"))
    except (AttributeError, ValueError):
        return []
    return [
        {"albumId": partition, "mediaId": sort_key}
        for partition in sorted(metadata_facets(metadata))
    ]


def sync_metadata_index(table, previous: dict | None, current: dict | None, *, public: bool) -> None:
    """Idempotently reconcile one preview record's sparse Explore rows."""
    previous = previous if isinstance(previous, dict) else {}
    current = current if isinstance(current, dict) else {}
    previous_keys = {
        (key["albumId"], key["mediaId"]): key
        for key in index_entry_keys(previous)
    }
    desired_records = desired_index_records(current, public=public)
    desired_entry_keys = {
        (record["albumId"], record["mediaId"])
        for record in desired_records
        if record.get("recordType") == INDEX_RECORD_TYPE
    }
    with table.batch_writer(overwrite_by_pkeys=["albumId", "mediaId"]) as batch:
        for identity, key in sorted(previous_keys.items()):
            if identity not in desired_entry_keys:
                batch.delete_item(Key=key)
        for record in desired_records:
            batch.put_item(Item=record)


def sync_album_index(table, album: dict, metadata_by_id: dict) -> None:
    """Reconcile an album after an authoritative visibility transition."""
    public = bool(
        isinstance(album, dict)
        and album.get("visibility") == "public"
        and album.get("status", "active") == "active"
        and album.get("type", "photo") == "photo"
    )
    records = metadata_by_id.values() if isinstance(metadata_by_id, dict) else []
    with table.batch_writer(overwrite_by_pkeys=["albumId", "mediaId"]) as batch:
        for metadata in records:
            if public:
                for record in desired_index_records(metadata, public=True):
                    batch.put_item(Item=record)
            else:
                for key in index_entry_keys(metadata):
                    batch.delete_item(Key=key)
