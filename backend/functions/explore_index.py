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
TEMPORAL_VERSION = 1
INDEX_RECORD_TYPE = "explore-index-v1"
FACET_RECORD_TYPE = "explore-facet-v1"
READY_RECORD_TYPE = "explore-ready-v1"
INDEX_PREFIX = "__EXPLORE_V1__"
FACETS_PARTITION = f"{INDEX_PREFIX}#FACETS"
SYSTEM_PARTITION = f"{INDEX_PREFIX}#SYSTEM"
READY_SORT_KEY = "READY"
EXPOSURE_READY_SORT_KEY = "EXPOSURE_READY"
TEMPORAL_READY_SORT_KEY = "TEMPORAL_READY"
COLOR_FAMILIES = frozenset({
    "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "monochrome",
})
EXPOSURE_DEFINITIONS = {
    "aperture": ("wide", "middle", "deep"),
    "shutter": ("motion", "handheld", "frozen"),
    "iso": ("clean", "available", "low"),
    "focal": ("wide", "normal", "telephoto"),
}
TIME_OF_DAY_DEFINITIONS = ("dawn", "morning", "afternoon", "evening", "night")
SEASON_DEFINITIONS = ("winter", "spring", "summer", "autumn")
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
    if mode == "exposure":
        normalized = value.strip().lower() if isinstance(value, str) else ""
        group, separator, option = normalized.partition(":")
        if not separator or option not in EXPOSURE_DEFINITIONS.get(group, ()):
            raise ValueError("unsupported exposure facet")
        return f"{INDEX_PREFIX}#EXPOSURE#{group}:{option}"
    if mode == "time":
        normalized = value.strip().lower() if isinstance(value, str) else ""
        if normalized not in TIME_OF_DAY_DEFINITIONS:
            raise ValueError("unsupported time facet")
        return f"{INDEX_PREFIX}#TIME#{normalized}"
    if mode == "season":
        normalized = value.strip().lower() if isinstance(value, str) else ""
        if normalized not in SEASON_DEFINITIONS:
            raise ValueError("unsupported season facet")
        return f"{INDEX_PREFIX}#SEASON#{normalized}"
    raise ValueError("unsupported Explore facet mode")


def _number_from(value) -> float:
    match = re.search(r"(\d+(?:\.\d+)?)", str(value or "").replace(",", ""))
    return float(match.group(1)) if match else 0.0


def _shutter_seconds(value) -> float:
    normalized = re.sub(
        r"(?:seconds?|secs?|s)$", "", str(value or "").strip().lower()
    ).strip()
    fraction = re.fullmatch(r"(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)", normalized)
    if fraction:
        denominator = float(fraction.group(2))
        return float(fraction.group(1)) / denominator if denominator > 0 else 0.0
    try:
        numeric = float(normalized)
    except (TypeError, ValueError):
        return 0.0
    return numeric if numeric > 0 else 0.0


def exposure_bucket(exif, group: str) -> str | None:
    if not isinstance(exif, dict):
        return None
    if group == "aperture":
        value = _number_from(exif.get("focalRatio"))
        if 0 < value <= 2.8:
            return "wide"
        if 2.8 < value <= 7.1:
            return "middle"
        return "deep" if value > 7.1 else None
    if group == "shutter":
        value = _shutter_seconds(exif.get("shutterSpeed"))
        if value >= (1 / 60):
            return "motion"
        if value >= (1 / 320):
            return "handheld"
        return "frozen" if value > 0 else None
    if group == "iso":
        value = _number_from(exif.get("iso"))
        if 0 < value <= 200:
            return "clean"
        if 200 < value <= 800:
            return "available"
        return "low" if value > 800 else None
    if group == "focal":
        value = _number_from(exif.get("focalLength"))
        if 0 < value <= 24:
            return "wide"
        if 24 < value <= 70:
            return "normal"
        return "telephoto" if value > 70 else None
    return None


def exposure_buckets(exif) -> list[str]:
    return [
        f"{group}:{option}"
        for group in EXPOSURE_DEFINITIONS
        if (option := exposure_bucket(exif, group))
    ]


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
    buckets = metadata.get("exposureBuckets")
    if isinstance(buckets, list):
        for bucket in set(buckets):
            try:
                facets[facet_partition("exposure", bucket)] = bucket
            except ValueError:
                continue
    if (
        metadata.get("temporalVersion") == TEMPORAL_VERSION
        and metadata.get("timeOfDayBucket") in TIME_OF_DAY_DEFINITIONS
        and metadata.get("seasonBucket") in SEASON_DEFINITIONS
    ):
        time_of_day = metadata.get("timeOfDayBucket")
        season = metadata.get("seasonBucket")
        facets[facet_partition("time", time_of_day)] = time_of_day
        facets[facet_partition("season", season)] = season
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


def exposure_ready_marker() -> dict:
    return {
        "albumId": SYSTEM_PARTITION,
        "mediaId": EXPOSURE_READY_SORT_KEY,
        "recordType": READY_RECORD_TYPE,
        "indexVersion": INDEX_VERSION,
    }


def temporal_ready_marker() -> dict:
    return {
        "albumId": SYSTEM_PARTITION,
        "mediaId": TEMPORAL_READY_SORT_KEY,
        "recordType": READY_RECORD_TYPE,
        "indexVersion": INDEX_VERSION,
        "temporalVersion": TEMPORAL_VERSION,
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
    partitions = set(metadata_facets(metadata))
    # Exposure metadata was added after the original materialized index. Probe
    # all fixed partitions during reconciliation so legacy rows can never be
    # stranded when a photo changes or leaves the public catalog.
    if not isinstance(metadata.get("exposureBuckets"), list):
        partitions.update(
            facet_partition("exposure", f"{group}:{option}")
            for group, options in EXPOSURE_DEFINITIONS.items()
            for option in options
        )
    # Temporal partitions are fixed and small. Always probe all of them so a
    # pending repair, malformed legacy row, or bucket change cannot strand a
    # stale public reference.
    partitions.update(
        facet_partition("time", value) for value in TIME_OF_DAY_DEFINITIONS
    )
    partitions.update(
        facet_partition("season", value) for value in SEASON_DEFINITIONS
    )
    return [
        {"albumId": partition, "mediaId": sort_key}
        for partition in sorted(partitions)
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
    exposure_by_media_id = {}
    if isinstance(album, dict) and isinstance(album.get("images"), list):
        for image in album["images"]:
            if not isinstance(image, dict):
                continue
            raw_key = image.get("rawKey") or image.get("key")
            if not isinstance(raw_key, str) or not raw_key:
                continue
            media_id = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:24]
            exposure_by_media_id[media_id] = exposure_buckets(image.get("exif"))
    records = metadata_by_id.values() if isinstance(metadata_by_id, dict) else []
    with table.batch_writer(overwrite_by_pkeys=["albumId", "mediaId"]) as batch:
        for metadata in records:
            if public:
                enriched = {
                    **metadata,
                    "exposureBuckets": exposure_by_media_id.get(metadata.get("mediaId"), []),
                }
                for record in desired_index_records(enriched, public=True):
                    batch.put_item(Item=record)
            else:
                for key in index_entry_keys(metadata):
                    batch.delete_item(Key=key)
