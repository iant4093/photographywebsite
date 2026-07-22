#!/usr/bin/env python3
"""Dry-run or apply visibility tags to existing album objects.

Object keys, album IDs, titles, owners, and share codes are never printed. Apply
requires account, record-count, and confirmation guards. Existing unrelated S3
tags are preserved. Run only after the hardened backend/frontend are deployed.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import re
import subprocess
from typing import Any
from urllib.parse import unquote, urlparse
import uuid

from aws_stack import aws_json, stack_resource

try:
    import boto3
    from botocore.config import Config as BotoConfig
except ImportError:  # Keep the AWS CLI fallback for dependency-light operator hosts.
    boto3 = None
    BotoConfig = None


ALLOWED_VISIBILITIES = {"public", "private", "unlisted"}
# Distinct from upload-state "pending": the bucket lifecycle expires pending
# uploads, while migration orphans must be retained for manual recovery.
QUARANTINE_VISIBILITY = "quarantined"
LEGACY_PREFIX_PATTERN = re.compile(r"^albums/[a-z0-9](?:[a-z0-9._-]{0,198}[a-z0-9])?/$")


def create_s3_tag_client(profile: str | None, region: str, workers: int):
    """Use one pooled SDK client instead of starting an AWS CLI process per tag."""
    if boto3 is None or BotoConfig is None:
        return None
    session = boto3.Session(profile_name=profile, region_name=region)
    return session.client(
        "s3",
        config=BotoConfig(
            max_pool_connections=max(16, workers * 2),
            connect_timeout=3,
            read_timeout=15,
            retries={"mode": "standard", "max_attempts": 4},
        ),
    )


def scan_all(table: str, profile: str | None, region: str | None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    start_key: dict[str, Any] | None = None
    seen_tokens: set[str] = set()
    while True:
        arguments = [
            "dynamodb",
            "scan",
            "--no-paginate",
            "--table-name",
            table,
            "--projection-expression",
            "albumId, #visibility, images, coverImageUrl, coverThumbKey, legacyS3Prefix",
            "--expression-attribute-names",
            '{"#visibility":"visibility"}',
        ]
        if start_key:
            arguments.extend(
                ["--exclusive-start-key", json.dumps(start_key, separators=(",", ":"))]
            )
        page = aws_json(arguments, profile, region)
        page_items = page.get("Items", [])
        if not isinstance(page_items, list):
            raise RuntimeError("DynamoDB scan returned a malformed Items collection")
        items.extend(page_items)
        start_key = page.get("LastEvaluatedKey")
        if not start_key:
            return items
        token = json.dumps(start_key, sort_keys=True, separators=(",", ":"))
        if token in seen_tokens:
            raise RuntimeError("DynamoDB pagination token repeated; refusing an incomplete scan")
        seen_tokens.add(token)


def list_objects_all(
    bucket: str, prefix: str, profile: str | None, region: str | None
) -> list[str]:
    keys: list[str] = []
    continuation: str | None = None
    seen_tokens: set[str] = set()
    while True:
        arguments = [
            "s3api",
            "list-objects-v2",
            "--no-paginate",
            "--bucket",
            bucket,
            "--prefix",
            prefix,
        ]
        if continuation:
            arguments.extend(["--continuation-token", continuation])
        page = aws_json(arguments, profile, region)
        contents = page.get("Contents", []) or []
        if not isinstance(contents, list) or any(not isinstance(item.get("Key"), str) for item in contents):
            raise RuntimeError("S3 listing returned a malformed Contents collection")
        keys.extend(item["Key"] for item in contents)
        truncated = page.get("IsTruncated", False)
        next_token = page.get("NextContinuationToken")
        if not truncated:
            return keys
        if not isinstance(next_token, str) or not next_token:
            raise RuntimeError("S3 reported a truncated listing without a continuation token")
        if next_token in seen_tokens:
            raise RuntimeError("S3 continuation token repeated; refusing an incomplete listing")
        seen_tokens.add(next_token)
        continuation = next_token


def decode(value: Any) -> Any:
    if not isinstance(value, dict) or len(value) != 1:
        return value
    kind, payload = next(iter(value.items()))
    if kind == "S":
        return payload
    if kind == "N":
        return int(payload) if "." not in payload else float(payload)
    if kind == "BOOL":
        return payload
    if kind == "NULL":
        return None
    if kind == "L":
        return [decode(item) for item in payload]
    if kind == "M":
        return {key: decode(item) for key, item in payload.items()}
    return payload


def object_key(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    if value.startswith("http://") or value.startswith("https://"):
        return unquote(urlparse(value).path.lstrip("/")) or None
    return value.lstrip("/")


def approved_album_prefixes(album: dict[str, Any]) -> tuple[str, ...] | None:
    """Return only canonical and explicitly approved legacy ownership prefixes."""
    album_id = album.get("albumId")
    if not isinstance(album_id, str):
        return None
    try:
        normalized_id = str(uuid.UUID(album_id))
    except (ValueError, AttributeError):
        return None
    if normalized_id != album_id:
        return None

    prefixes = [f"albums/{album_id}/"]
    legacy_prefix = album.get("legacyS3Prefix")
    if legacy_prefix not in (None, ""):
        if not isinstance(legacy_prefix, str) or not LEGACY_PREFIX_PATTERN.fullmatch(legacy_prefix):
            return None
        if legacy_prefix not in prefixes:
            prefixes.append(legacy_prefix)
    return tuple(prefixes)


def key_belongs_to_prefixes(key: str, prefixes: tuple[str, ...]) -> bool:
    return any(key.startswith(prefix) and key != prefix.rstrip("/") for prefix in prefixes)


def classify_existing_objects(
    assignments: dict[str, str], object_keys: set[str]
) -> tuple[dict[str, str], set[str], set[str]]:
    """Build a complete plan: assigned objects retain visibility, orphans fail closed."""
    existing_assignments = {
        key: visibility for key, visibility in assignments.items() if key in object_keys
    }
    orphan_keys = object_keys - assignments.keys()
    missing_references = assignments.keys() - object_keys
    plan = dict(existing_assignments)
    plan.update({key: QUARANTINE_VISIBILITY for key in orphan_keys})
    if plan.keys() != object_keys:
        raise RuntimeError("Object classification plan is incomplete")
    return plan, orphan_keys, missing_references


def classification_digest(plan: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for key, visibility in sorted(plan.items()):
        digest.update(key.encode("utf-8"))
        digest.update(b"\0")
        digest.update(visibility.encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--max-objects", type=int, default=0)
    parser.add_argument("--expected-account-id")
    parser.add_argument("--expected-record-count", type=int)
    parser.add_argument("--expected-bucket-object-count", type=int)
    parser.add_argument("--expected-plan-digest")
    parser.add_argument("--confirm")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    if args.workers < 1 or args.workers > 16:
        raise SystemExit("--workers must be between 1 and 16.")
    if args.apply and args.max_objects:
        raise SystemExit("Refusing apply: --max-objects is a dry-run diagnostic only.")
    account = aws_json(["sts", "get-caller-identity"], args.profile, args.region)["Account"]
    table = stack_resource(args.stack_name, "AlbumsTable", args.profile, args.region)
    bucket = stack_resource(args.stack_name, "ImagesBucket", args.profile, args.region)
    albums = [
        {key: decode(value) for key, value in item.items()}
        for item in scan_all(table, args.profile, args.region)
    ]
    assignments: dict[str, str] = {}
    conflicts = 0
    invalid_visibility = 0
    invalid_prefix_records = 0
    cross_prefix_references = 0

    for album in albums:
        visibility = album.get("visibility")
        if visibility not in ALLOWED_VISIBILITIES:
            invalid_visibility += 1
            continue
        prefixes = approved_album_prefixes(album)
        if prefixes is None:
            invalid_prefix_records += 1
            continue
        candidates: set[str] = set()
        for image in album.get("images") or []:
            if isinstance(image, dict):
                for field in ("rawKey", "thumbKey", "hlsUrl"):
                    key = object_key(image.get(field))
                    if key and key_belongs_to_prefixes(key, prefixes):
                        candidates.add(key)
                    elif key:
                        cross_prefix_references += 1
        for field in ("coverImageUrl", "coverThumbKey"):
            key = object_key(album.get(field))
            if key and key_belongs_to_prefixes(key, prefixes):
                candidates.add(key)
            elif key:
                cross_prefix_references += 1

        for prefix in prefixes:
            candidates.update(list_objects_all(bucket, prefix, args.profile, args.region))

        for key in candidates:
            previous = assignments.get(key)
            if previous and previous != visibility:
                conflicts += 1
            else:
                assignments[key] = visibility

    if invalid_visibility or invalid_prefix_records or cross_prefix_references or conflicts:
        raise SystemExit(
            "Refusing to continue: "
            f"invalid_visibility_records={invalid_visibility}, "
            f"invalid_prefix_records={invalid_prefix_records}, "
            f"cross_prefix_references={cross_prefix_references}, "
            f"conflicting_keys={conflicts}."
        )
    bucket_object_keys = set(list_objects_all(bucket, "albums/", args.profile, args.region))
    plan, orphan_keys, missing_references = classify_existing_objects(
        assignments, bucket_object_keys
    )
    items = sorted(plan.items())
    if args.max_objects:
        items = items[: args.max_objects]

    summary = {
        "mode": "apply" if args.apply else "dry-run",
        "account": account,
        "stack": args.stack_name,
        "albumRecordCount": len(albums),
        "candidateObjectCount": len(assignments),
        "bucketAlbumObjectCount": len(bucket_object_keys),
        "existingAssignedObjectCount": len(bucket_object_keys) - len(orphan_keys),
        "orphanQuarantineCount": len(orphan_keys),
        "missingReferencedObjectCount": len(missing_references),
        "unclassifiedAfterPlanCount": len(bucket_object_keys - plan.keys()),
        "classificationPlanDigest": classification_digest(plan),
        "selectedObjectCount": len(items),
        "visibilityCounts": {
            visibility: sum(1 for selected in plan.values() if selected == visibility)
            for visibility in sorted(ALLOWED_VISIBILITIES | {QUARANTINE_VISIBILITY})
        },
    }
    print(json.dumps(summary, indent=2))
    if not args.apply:
        print("Dry run only. No object tags were read or changed.")
        return 0
    if args.expected_account_id != account:
        raise SystemExit("Refusing apply: --expected-account-id does not match.")
    if args.expected_record_count != len(albums):
        raise SystemExit("Refusing apply: --expected-record-count does not match the current table.")
    if args.expected_bucket_object_count != len(bucket_object_keys):
        raise SystemExit("Refusing apply: --expected-bucket-object-count does not match.")
    if args.expected_plan_digest != classification_digest(plan):
        raise SystemExit("Refusing apply: --expected-plan-digest does not match the current plan.")
    if args.confirm != "tag-existing-media":
        raise SystemExit("Refusing apply: --confirm must be exactly tag-existing-media.")

    tag_client = create_s3_tag_client(args.profile, args.region, args.workers)

    def read_tags(key: str) -> list[dict[str, str]]:
        if tag_client is not None:
            return tag_client.get_object_tagging(Bucket=bucket, Key=key).get("TagSet", [])
        return aws_json(
            ["s3api", "get-object-tagging", "--bucket", bucket, "--key", key],
            args.profile,
            args.region,
        ).get("TagSet", [])

    def write_tags(key: str, tag_set: list[dict[str, str]]) -> None:
        if tag_client is not None:
            tag_client.put_object_tagging(Bucket=bucket, Key=key, Tagging={"TagSet": tag_set})
            return
        aws_json(
            [
                "s3api",
                "put-object-tagging",
                "--bucket",
                bucket,
                "--key",
                key,
                "--tagging",
                json.dumps({"TagSet": tag_set}, separators=(",", ":")),
            ],
            args.profile,
            args.region,
        )

    def update(item: tuple[str, str]) -> str:
        key, visibility = item
        try:
            current = read_tags(key)
            tags = {tag["Key"]: tag["Value"] for tag in current}
            if tags.get("visibility") == visibility:
                return "unchanged"
            tags["visibility"] = visibility
            if len(tags) > 10:
                return "too_many_tags"
            write_tags(
                key,
                [{"Key": name, "Value": value} for name, value in sorted(tags.items())],
            )
            return "updated"
        except Exception:
            return "failed"

    results: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(update, item) for item in items]
        for future in as_completed(futures):
            status = future.result()
            results[status] = results.get(status, 0) + 1
    verification_results: dict[str, int] = {}

    def verify(item: tuple[str, str]) -> str:
        key, expected_visibility = item
        try:
            current = read_tags(key)
            actual = next(
                (tag.get("Value") for tag in current if tag.get("Key") == "visibility"), None
            )
            return "classified" if actual == expected_visibility else "unclassified"
        except Exception:
            return "verification_failed"

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(verify, item) for item in sorted(plan.items())]
        for future in as_completed(futures):
            status = future.result()
            verification_results[status] = verification_results.get(status, 0) + 1
    unclassified = verification_results.get("unclassified", 0) + verification_results.get(
        "verification_failed", 0
    )
    print(
        json.dumps(
            {
                "tagTransport": "boto3" if tag_client is not None else "aws-cli",
                "resultCounts": results,
                "verificationCounts": verification_results,
                "unclassifiedAfterApplyCount": unclassified,
            },
            indent=2,
        )
    )
    return 1 if results.get("failed") or results.get("too_many_tags") or unclassified else 0


if __name__ == "__main__":
    raise SystemExit(main())
