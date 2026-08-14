#!/usr/bin/env python3
"""Plan or apply the guarded album QR-code backfill; dry-run by default.

Output is aggregate-only: album IDs, share codes, object keys, titles, and
provider responses are never printed.
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
from botocore.exceptions import ClientError

from aws_stack import stack_resource


ROOT = pathlib.Path(__file__).resolve().parents[1]
FUNCTIONS = ROOT / "backend" / "functions"
if str(FUNCTIONS) not in sys.path:
    sys.path.insert(0, str(FUNCTIONS))

from album_qr import album_qr_key, write_album_qr  # noqa: E402


DEFAULT_FRONTEND_ORIGIN = "https://iantruongphotography.com"
DEFAULT_FRONTEND_DISTRIBUTION_ID = "EIOCCNR8XGQ1B"
ALLOWED_TYPES = {"photo", "video"}


def scan_albums(table) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    request = {
        "ProjectionExpression": (
            "albumId, #type, #status, #visibility, isShared, shareCode, qrCodeKey"
        ),
        "ExpressionAttributeNames": {
            "#type": "type",
            "#status": "status",
            "#visibility": "visibility",
        },
    }
    seen_tokens: set[str] = set()
    while True:
        page = table.scan(**request)
        page_items = page.get("Items", [])
        if not isinstance(page_items, list):
            raise RuntimeError("DynamoDB scan returned malformed Items")
        items.extend(page_items)
        start_key = page.get("LastEvaluatedKey")
        if not start_key:
            return items
        token = json.dumps(start_key, sort_keys=True, separators=(",", ":"))
        if token in seen_tokens:
            raise RuntimeError("DynamoDB pagination token repeated")
        seen_tokens.add(token)
        request["ExclusiveStartKey"] = start_key


def eligible_albums(albums: list[dict[str, Any]], origin: str) -> tuple[list[dict[str, Any]], dict[str, int]]:
    candidates: list[dict[str, Any]] = []
    counts = {
        "albumRecordCount": len(albums),
        "eligibleCount": 0,
        "eligiblePublicCount": 0,
        "eligibleLinkOnlyCount": 0,
        "inactiveSkippedCount": 0,
        "privateSkippedCount": 0,
        "revokedLinkSkippedCount": 0,
        "malformedSkippedCount": 0,
    }
    seen: set[str] = set()
    for album in albums:
        if not isinstance(album, dict) or album.get("status", "active") != "active":
            counts["inactiveSkippedCount"] += 1
            continue
        visibility = album.get("visibility")
        if visibility == "private":
            counts["privateSkippedCount"] += 1
            continue
        if visibility == "unlisted" and not bool(album.get("isShared")):
            counts["revokedLinkSkippedCount"] += 1
            continue
        if visibility not in {"public", "unlisted"} or album.get("type", "photo") not in ALLOWED_TYPES:
            counts["malformedSkippedCount"] += 1
            continue
        try:
            key = album_qr_key(album, origin=origin, require_active=True)
        except Exception:
            key = None
        album_id = album.get("albumId")
        if not key or not isinstance(album_id, str) or album_id in seen:
            counts["malformedSkippedCount"] += 1
            continue
        seen.add(album_id)
        candidates.append({"album": album, "key": key, "visibility": visibility})
        counts["eligibleCount"] += 1
        counts["eligiblePublicCount" if visibility == "public" else "eligibleLinkOnlyCount"] += 1
    candidates.sort(key=lambda item: item["album"]["albumId"])
    return candidates, counts


def object_visibility(s3, bucket: str, key: str) -> str | None:
    try:
        response = s3.get_object_tagging(Bucket=bucket, Key=key)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise
    tags = {
        item.get("Key"): item.get("Value")
        for item in response.get("TagSet", [])
        if isinstance(item, dict)
    }
    return tags.get("visibility")


def build_plan(candidates: list[dict[str, Any]], s3, bucket: str) -> tuple[list[dict[str, Any]], dict[str, int]]:
    plan: list[dict[str, Any]] = []
    counts = {
        "alreadyCompleteCount": 0,
        "missingObjectCount": 0,
        "metadataRepairCount": 0,
        "visibilityTagRepairCount": 0,
        "plannedRepairCount": 0,
    }
    for candidate in candidates:
        album = candidate["album"]
        expected_key = candidate["key"]
        tag = object_visibility(s3, bucket, expected_key)
        metadata_matches = album.get("qrCodeKey") == expected_key
        tag_matches = tag == candidate["visibility"]
        if metadata_matches and tag_matches:
            counts["alreadyCompleteCount"] += 1
            continue
        if tag is None:
            counts["missingObjectCount"] += 1
        if not metadata_matches:
            counts["metadataRepairCount"] += 1
        if not tag_matches:
            counts["visibilityTagRepairCount"] += 1
        plan.append(candidate)
    counts["plannedRepairCount"] = len(plan)
    return plan, counts


def plan_digest(plan: list[dict[str, Any]]) -> str:
    payload = "\n".join(
        "|".join((item["album"]["albumId"], item["key"], item["visibility"]))
        for item in plan
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def condition_for(candidate: dict[str, Any]) -> tuple[str, dict[str, str], dict[str, Any]]:
    album = candidate["album"]
    names = {"#status": "status", "#visibility": "visibility", "#type": "type"}
    values = {
        ":active": "active",
        ":visibility": candidate["visibility"],
        ":type": album.get("type", "photo"),
        ":key": candidate["key"],
    }
    condition = (
        "(attribute_not_exists(#status) OR #status = :active) "
        "AND #visibility = :visibility AND #type = :type"
    )
    if candidate["visibility"] == "unlisted":
        names["#shared"] = "isShared"
        names["#shareCode"] = "shareCode"
        values[":shared"] = True
        values[":shareCode"] = album["shareCode"]
        condition += " AND #shared = :shared AND #shareCode = :shareCode"
    return condition, names, values


def apply_plan(plan, table, s3, bucket: str, origin: str) -> tuple[int, int]:
    updated = 0
    conflicts = 0
    for candidate in plan:
        album = candidate["album"]
        # Overwriting creates a fresh pending-tagged version. Metadata is then
        # conditionally committed before the final visibility release.
        written = write_album_qr(album, origin=origin, s3_client=s3, bucket=bucket)
        if written != candidate["key"]:
            raise RuntimeError("QR renderer returned an unexpected key")
        condition, names, values = condition_for(candidate)
        try:
            table.update_item(
                Key={"albumId": album["albumId"]},
                UpdateExpression="SET qrCodeKey = :key",
                ConditionExpression=condition,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                conflicts += 1
                continue
            raise
        s3.put_object_tagging(
            Bucket=bucket,
            Key=candidate["key"],
            Tagging={"TagSet": [{"Key": "visibility", "Value": candidate["visibility"]}]},
        )
        updated += 1
    return updated, conflicts


def invalidate_public_album_details(cloudfront, distribution_id: str) -> None:
    cloudfront.create_invalidation(
        DistributionId=distribution_id,
        InvalidationBatch={
            "CallerReference": f"album-qr-backfill-{time.time_ns()}",
            "Paths": {"Quantity": 1, "Items": ["/api/public/albums/*"]},
        },
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--frontend-origin", default=DEFAULT_FRONTEND_ORIGIN)
    parser.add_argument("--frontend-distribution-id", default=DEFAULT_FRONTEND_DISTRIBUTION_ID)
    parser.add_argument("--expected-account-id")
    parser.add_argument("--expected-plan-count", type=int)
    parser.add_argument("--expected-plan-digest")
    parser.add_argument("--confirm")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    account = session.client("sts").get_caller_identity()["Account"]
    table_name = stack_resource(args.stack_name, "AlbumsTable", args.profile, args.region)
    bucket = stack_resource(args.stack_name, "ImagesBucket", args.profile, args.region)
    table = session.resource("dynamodb").Table(table_name)
    s3 = session.client("s3")
    albums = scan_albums(table)
    candidates, eligibility_counts = eligible_albums(albums, args.frontend_origin)
    plan, plan_counts = build_plan(candidates, s3, bucket)
    digest = plan_digest(plan)

    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        **eligibility_counts,
        **plan_counts,
        "planDigest": digest,
    }, indent=2, sort_keys=True))
    if not args.apply:
        print("Dry run only. No album record or QR object was changed.")
        return 0
    if args.expected_account_id != account:
        raise SystemExit("Refusing apply: --expected-account-id does not match.")
    if args.expected_plan_count != len(plan):
        raise SystemExit("Refusing apply: --expected-plan-count does not match the current plan.")
    if args.expected_plan_digest != digest:
        raise SystemExit("Refusing apply: --expected-plan-digest does not match the current plan.")
    if args.confirm != "APPLY_ALBUM_QR_BACKFILL":
        raise SystemExit("Refusing apply: --confirm must be exactly APPLY_ALBUM_QR_BACKFILL.")

    updated, conflicts = apply_plan(plan, table, s3, bucket, args.frontend_origin)
    if updated:
        invalidate_public_album_details(session.client("cloudfront"), args.frontend_distribution_id)

    verification_albums = scan_albums(table)
    verification_candidates, _ = eligible_albums(verification_albums, args.frontend_origin)
    remaining, _ = build_plan(verification_candidates, s3, bucket)
    print(json.dumps({
        "updatedCount": updated,
        "conditionConflictCount": conflicts,
        "remainingRepairCount": len(remaining),
    }, indent=2, sort_keys=True))
    return 1 if conflicts or remaining else 0


if __name__ == "__main__":
    raise SystemExit(main())
