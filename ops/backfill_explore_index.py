#!/usr/bin/env python3
"""Plan or reconcile the materialized Explore index; dry-run by default.

The command emits aggregate counts and a content-bound digest only. Album IDs,
media IDs, titles, object keys, and provider responses are never printed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import time
from typing import Any

import boto3

from aws_stack import stack_resource


ROOT = pathlib.Path(__file__).resolve().parents[1]
FUNCTIONS = ROOT / "backend" / "functions"
if str(FUNCTIONS) not in sys.path:
    sys.path.insert(0, str(FUNCTIONS))

from explore_index import (  # noqa: E402
    EXPLORE_VERSION,
    FACET_RECORD_TYPE,
    INDEX_RECORD_TYPE,
    READY_RECORD_TYPE,
    SEASON_DEFINITIONS,
    TEMPORAL_VERSION,
    TIME_OF_DAY_DEFINITIONS,
    desired_index_records,
    exposure_buckets,
    exposure_ready_marker,
    ready_marker,
    temporal_ready_marker,
)
from media_access import PREVIEW_VERSION, media_id_for_key  # noqa: E402


KNOWN_INDEX_TYPES = {INDEX_RECORD_TYPE, FACET_RECORD_TYPE, READY_RECORD_TYPE}
CONFIRMATION = "APPLY_EXPLORE_INDEX_BACKFILL"
DEFAULT_FRONTEND_DISTRIBUTION_ID = "EIOCCNR8XGQ1B"
TEMPORAL_READINESS_CACHE_DRAIN_SECONDS = 31


def scan_table(table) -> list[dict[str, Any]]:
    items = []
    request = {}
    seen = set()
    while True:
        page = table.scan(**request)
        values = page.get("Items", [])
        if not isinstance(values, list):
            raise RuntimeError("DynamoDB scan returned malformed Items")
        items.extend(item for item in values if isinstance(item, dict))
        cursor = page.get("LastEvaluatedKey")
        if not cursor:
            return items
        token = json.dumps(cursor, sort_keys=True, separators=(",", ":"))
        if token in seen:
            raise RuntimeError("DynamoDB pagination token repeated")
        seen.add(token)
        request["ExclusiveStartKey"] = cursor


def _raw_key(image) -> str:
    if not isinstance(image, dict):
        return ""
    value = image.get("rawKey") or image.get("key")
    return value if isinstance(value, str) and value else ""


def desired_records(albums, preview_records):
    eligible = {}
    counts = {
        "albumRecordCount": len(albums),
        "previewTableRecordCount": len(preview_records),
        "eligiblePublicPhotoAlbumCount": 0,
        "eligiblePublicPhotoCount": 0,
        "indexedPhotoCount": 0,
        "missingExploreMetadataCount": 0,
        "temporalProcessedPhotoCount": 0,
        "temporalClassifiedPhotoCount": 0,
        "temporalUndatedPhotoCount": 0,
        "missingTemporalMetadataCount": 0,
    }
    for album in albums:
        if not (
            album.get("visibility") == "public"
            and album.get("status", "active") == "active"
            and album.get("type", "photo") == "photo"
            and isinstance(album.get("images"), list)
        ):
            continue
        media = {
            media_id_for_key(raw_key): exposure_buckets(image.get("exif"))
            for image in album["images"]
            if isinstance(image, dict) and (raw_key := _raw_key(image))
        }
        eligible[album.get("albumId")] = media
        counts["eligiblePublicPhotoAlbumCount"] += 1
        counts["eligiblePublicPhotoCount"] += len(media)

    preview_by_key = {
        (item.get("albumId"), item.get("mediaId")): item
        for item in preview_records
        if isinstance(item.get("albumId"), str)
        and isinstance(item.get("mediaId"), str)
    }
    desired = {}
    indexed_media = set()
    for album_id, album_media in eligible.items():
        for media_id, derived_exposure_buckets in album_media.items():
            metadata = preview_by_key.get((album_id, media_id), {})
            time_of_day = metadata.get("timeOfDayBucket")
            season = metadata.get("seasonBucket")
            temporal_pair_valid = (
                time_of_day == "" and season == ""
            ) or (
                time_of_day in TIME_OF_DAY_DEFINITIONS
                and season in SEASON_DEFINITIONS
            )
            explore_ready = bool(
                metadata.get("status") == "ready"
                and metadata.get("previewVersion") == PREVIEW_VERSION
                and metadata.get("exploreVersion") == EXPLORE_VERSION
            )
            temporal_complete = bool(
                explore_ready
                and metadata.get("temporalVersion") == TEMPORAL_VERSION
                and isinstance(time_of_day, str)
                and isinstance(season, str)
                and temporal_pair_valid
            )
            if temporal_complete:
                counts["temporalProcessedPhotoCount"] += 1
                if time_of_day and season:
                    counts["temporalClassifiedPhotoCount"] += 1
                else:
                    counts["temporalUndatedPhotoCount"] += 1
            else:
                counts["missingTemporalMetadataCount"] += 1
            records = desired_index_records(
                {**metadata, "exposureBuckets": derived_exposure_buckets},
                public=True,
            )
            entries = [record for record in records if record.get("recordType") == INDEX_RECORD_TYPE]
            if not explore_ready or not entries:
                counts["missingExploreMetadataCount"] += 1
                continue
            indexed_media.add((album_id, media_id))
            for record in records:
                desired[(record["albumId"], record["mediaId"])] = record
    counts["indexedPhotoCount"] = len(indexed_media)
    marker = ready_marker()
    desired[(marker["albumId"], marker["mediaId"])] = marker
    exposure_marker = exposure_ready_marker()
    desired[(exposure_marker["albumId"], exposure_marker["mediaId"])] = exposure_marker
    return desired, counts


def current_index_records(preview_records):
    return {
        (item["albumId"], item["mediaId"]): item
        for item in preview_records
        if item.get("recordType") in KNOWN_INDEX_TYPES
        and isinstance(item.get("albumId"), str)
        and isinstance(item.get("mediaId"), str)
    }


def build_plan(desired, current):
    puts = [
        record for key, record in desired.items()
        if current.get(key) != record and record.get("recordType") != READY_RECORD_TYPE
    ]
    deletes = [
        {"albumId": key[0], "mediaId": key[1]}
        for key in current
        if key not in desired and current[key].get("recordType") != READY_RECORD_TYPE
    ]
    puts.sort(key=lambda item: (item["albumId"], item["mediaId"]))
    deletes.sort(key=lambda item: (item["albumId"], item["mediaId"]))
    return puts, deletes


def plan_digest(puts, deletes):
    payload = json.dumps(
        {"puts": puts, "deletes": deletes},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def apply_plan(table, puts, deletes):
    with table.batch_writer(overwrite_by_pkeys=["albumId", "mediaId"]) as batch:
        for key in deletes:
            batch.delete_item(Key=key)
        for item in puts:
            batch.put_item(Item=item)
    # Read traffic switches only after every entry and definition is durable.
    table.put_item(Item=ready_marker())
    table.put_item(Item=exposure_ready_marker())


def invalidate_explore_cache(cloudfront, distribution_id: str, phase: str) -> None:
    invalidation = cloudfront.create_invalidation(
        DistributionId=distribution_id,
        InvalidationBatch={
            "CallerReference": f"explore-index-backfill-{phase}-{time.time_ns()}",
            "Paths": {"Quantity": 1, "Items": ["/api/public/explore*"]},
        },
    )
    cloudfront.get_waiter("invalidation_completed").wait(
        DistributionId=distribution_id,
        Id=invalidation["Invalidation"]["Id"],
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--frontend-distribution-id", default=DEFAULT_FRONTEND_DISTRIBUTION_ID)
    parser.add_argument("--expected-account-id")
    parser.add_argument("--expected-put-count", type=int)
    parser.add_argument("--expected-delete-count", type=int)
    parser.add_argument("--expected-plan-digest")
    parser.add_argument("--confirm")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    account = session.client("sts").get_caller_identity()["Account"]
    albums_name = stack_resource(args.stack_name, "AlbumsTable", args.profile, args.region)
    preview_name = stack_resource(args.stack_name, "PreviewMetadataTable", args.profile, args.region)
    albums = scan_table(session.resource("dynamodb").Table(albums_name))
    preview_table = session.resource("dynamodb").Table(preview_name)
    preview_records = scan_table(preview_table)
    desired, inventory = desired_records(albums, preview_records)
    current = current_index_records(preview_records)
    puts, deletes = build_plan(desired, current)
    digest = plan_digest(puts, deletes)
    report = {
        "mode": "apply" if args.apply else "dry-run",
        **inventory,
        "desiredIndexRecordCount": len(desired),
        "currentIndexRecordCount": len(current),
        "plannedPutCount": len(puts),
        "plannedDeleteCount": len(deletes),
        "planDigest": digest,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    if not args.apply:
        print("Dry run only. No preview metadata or Explore index row was changed.")
        return 0
    if args.expected_account_id != account:
        raise SystemExit("Refusing apply: --expected-account-id does not match.")
    if args.expected_put_count != len(puts) or args.expected_delete_count != len(deletes):
        raise SystemExit("Refusing apply: expected operation counts do not match the current plan.")
    if args.expected_plan_digest != digest:
        raise SystemExit("Refusing apply: --expected-plan-digest does not match the current plan.")
    if args.confirm != CONFIRMATION:
        raise SystemExit(f"Refusing apply: --confirm must be exactly {CONFIRMATION}.")
    if inventory["missingTemporalMetadataCount"] or inventory["missingExploreMetadataCount"]:
        raise SystemExit("Refusing apply: Explore metadata backfill is incomplete.")

    temporal_marker = temporal_ready_marker()
    preview_table.delete_item(Key={
        "albumId": temporal_marker["albumId"],
        "mediaId": temporal_marker["mediaId"],
    })
    # Warm readers retain readiness for at most 30 seconds. Let that state
    # expire, then evict every edge response before changing index rows so a
    # failed repair remains fail-closed instead of serving a cached snapshot.
    time.sleep(TEMPORAL_READINESS_CACHE_DRAIN_SECONDS)
    cloudfront = session.client("cloudfront")
    invalidate_explore_cache(
        cloudfront,
        args.frontend_distribution_id,
        "closed",
    )
    apply_plan(preview_table, puts, deletes)
    # Re-read both tables so an upload or visibility edit concurrent with the
    # guarded reconciliation cannot make the READY marker bless stale rows.
    verification_albums = scan_table(session.resource("dynamodb").Table(albums_name))
    verification_records = scan_table(preview_table)
    verification_desired, verification_inventory = desired_records(
        verification_albums,
        verification_records,
    )
    remaining_puts, remaining_deletes = build_plan(
        verification_desired,
        current_index_records(verification_records),
    )
    temporal_ready = bool(
        not remaining_puts
        and not remaining_deletes
        and verification_inventory["missingTemporalMetadataCount"] == 0
        and verification_inventory["missingExploreMetadataCount"] == 0
    )
    if temporal_ready:
        preview_table.put_item(Item=temporal_ready_marker())
        marker = preview_table.get_item(
            Key={
                "albumId": temporal_ready_marker()["albumId"],
                "mediaId": temporal_ready_marker()["mediaId"],
            },
            ConsistentRead=True,
        ).get("Item")
        if marker != temporal_ready_marker():
            raise RuntimeError("Temporal readiness marker verification failed")
        invalidate_explore_cache(
            cloudfront,
            args.frontend_distribution_id,
            "ready",
        )
    print(json.dumps({
        "appliedPutCount": len(puts),
        "appliedDeleteCount": len(deletes),
        "remainingPutCount": len(remaining_puts),
        "remainingDeleteCount": len(remaining_deletes),
        "remainingTemporalMetadataCount": verification_inventory["missingTemporalMetadataCount"],
        "remainingExploreMetadataCount": verification_inventory["missingExploreMetadataCount"],
        "temporalReady": temporal_ready,
    }, indent=2, sort_keys=True))
    return 0 if temporal_ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
