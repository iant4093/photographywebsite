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
    FACET_RECORD_TYPE,
    INDEX_RECORD_TYPE,
    READY_RECORD_TYPE,
    desired_index_records,
    ready_marker,
)
from media_access import media_id_for_key  # noqa: E402


KNOWN_INDEX_TYPES = {INDEX_RECORD_TYPE, FACET_RECORD_TYPE, READY_RECORD_TYPE}
CONFIRMATION = "APPLY_EXPLORE_INDEX_BACKFILL"
DEFAULT_FRONTEND_DISTRIBUTION_ID = "EIOCCNR8XGQ1B"


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
    }
    for album in albums:
        if not (
            album.get("visibility") == "public"
            and album.get("status", "active") == "active"
            and album.get("type", "photo") == "photo"
            and isinstance(album.get("images"), list)
        ):
            continue
        media_ids = {
            media_id_for_key(raw_key)
            for image in album["images"]
            if (raw_key := _raw_key(image))
        }
        eligible[album.get("albumId")] = media_ids
        counts["eligiblePublicPhotoAlbumCount"] += 1
        counts["eligiblePublicPhotoCount"] += len(media_ids)

    desired = {}
    indexed_media = set()
    for metadata in preview_records:
        album_id = metadata.get("albumId")
        media_id = metadata.get("mediaId")
        if media_id not in eligible.get(album_id, set()):
            continue
        records = desired_index_records(metadata, public=True)
        entries = [record for record in records if record.get("recordType") == INDEX_RECORD_TYPE]
        if not entries:
            counts["missingExploreMetadataCount"] += 1
            continue
        indexed_media.add((album_id, media_id))
        for record in records:
            desired[(record["albumId"], record["mediaId"])] = record
    counts["indexedPhotoCount"] = len(indexed_media)
    marker = ready_marker()
    desired[(marker["albumId"], marker["mediaId"])] = marker
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

    apply_plan(preview_table, puts, deletes)
    # Re-read both tables so an upload or visibility edit concurrent with the
    # guarded reconciliation cannot make the READY marker bless stale rows.
    verification_albums = scan_table(session.resource("dynamodb").Table(albums_name))
    verification_records = scan_table(preview_table)
    verification_desired, _ = desired_records(verification_albums, verification_records)
    remaining_puts, remaining_deletes = build_plan(
        verification_desired,
        current_index_records(verification_records),
    )
    if not remaining_puts and not remaining_deletes:
        session.client("cloudfront").create_invalidation(
            DistributionId=args.frontend_distribution_id,
            InvalidationBatch={
                "CallerReference": f"explore-index-backfill-{time.time_ns()}",
                "Paths": {"Quantity": 1, "Items": ["/api/public/explore*"]},
            },
        )
    print(json.dumps({
        "appliedPutCount": len(puts),
        "appliedDeleteCount": len(deletes),
        "remainingPutCount": len(remaining_puts),
        "remainingDeleteCount": len(remaining_deletes),
    }, indent=2, sort_keys=True))
    return 1 if remaining_puts or remaining_deletes else 0


if __name__ == "__main__":
    raise SystemExit(main())
