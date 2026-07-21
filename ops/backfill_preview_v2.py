#!/usr/bin/env python3
"""Plan or dispatch the guarded responsive-preview V2 backfill.

Dry-run is the default. The script prints aggregate counts and a deterministic
plan digest, never album IDs or object keys. Apply sends the exact in-memory
plan to the stack's PreviewQueue in bounded batches; it never edits album
manifests, metadata records, or media objects.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from typing import Any
import uuid

from aws_stack import aws_json, stack_resource


PREVIEW_VERSION = 2
PREVIEW_WIDTHS = (640, 1280)
ALLOWED_VISIBILITIES = {"public", "private", "unlisted"}
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
LEGACY_PREFIX_PATTERN = re.compile(r"^albums/[a-z0-9](?:[a-z0-9._-]{0,198}[a-z0-9])?/$")


def decode(value: Any) -> Any:
    if not isinstance(value, dict) or len(value) != 1:
        return None
    kind, payload = next(iter(value.items()))
    if kind == "S":
        return payload if isinstance(payload, str) else None
    if kind == "N":
        try:
            number = float(payload)
            return int(number) if number.is_integer() else number
        except (TypeError, ValueError):
            return None
    if kind == "L" and isinstance(payload, list):
        return [decode(item) for item in payload]
    if kind == "M" and isinstance(payload, dict):
        return {key: decode(item) for key, item in payload.items()}
    if kind == "BOOL" and isinstance(payload, bool):
        return payload
    if kind == "NULL":
        return None
    return None


def decoded_item(item: dict[str, Any]) -> dict[str, Any]:
    return {key: decode(value) for key, value in item.items()}


def normalized_uuid(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        normalized = str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return None
    return normalized if normalized == value else None


def normalized_key(value: Any) -> str | None:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 1024
        or value != value.strip()
        or value.startswith("/")
        or "\\" in value
        or "\x00" in value
    ):
        return None
    normalized = posixpath.normpath(value)
    return value if normalized == value and not value.endswith("/") and not normalized.startswith("../") else None


def media_id_for_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:24]


def expected_preview_keys(album_id: str, raw_key: str) -> dict[str, str]:
    media_id = media_id_for_key(raw_key)
    prefix = f"albums/{album_id}/preview/v{PREVIEW_VERSION}/"
    return {str(width): f"{prefix}{media_id}-w{width}.webp" for width in PREVIEW_WIDTHS}


def scan_all(
    table: str,
    projection: str,
    profile: str | None,
    region: str | None,
    expression_names: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    start_key: dict[str, Any] | None = None
    seen_tokens: set[str] = set()
    while True:
        arguments = [
            "dynamodb", "scan", "--no-paginate", "--table-name", table,
            "--projection-expression", projection,
        ]
        if expression_names:
            arguments.extend([
                "--expression-attribute-names",
                json.dumps(expression_names, sort_keys=True, separators=(",", ":")),
            ])
        if start_key:
            arguments.extend(["--exclusive-start-key", json.dumps(start_key, separators=(",", ":"))])
        page = aws_json(arguments, profile, region)
        items = page.get("Items", [])
        if not isinstance(items, list):
            raise RuntimeError("DynamoDB scan returned malformed Items")
        records.extend(items)
        start_key = page.get("LastEvaluatedKey")
        if not start_key:
            return records
        token = json.dumps(start_key, sort_keys=True, separators=(",", ":"))
        if token in seen_tokens:
            raise RuntimeError("DynamoDB pagination token repeated")
        seen_tokens.add(token)


def metadata_index(records: list[dict[str, Any]]) -> tuple[dict[tuple[str, str], dict[str, Any]], int]:
    index: dict[tuple[str, str], dict[str, Any]] = {}
    duplicates = 0
    for raw in records:
        item = decoded_item(raw)
        key = (item.get("albumId"), item.get("mediaId"))
        if not all(isinstance(value, str) and value for value in key) or key in index:
            duplicates += 1
            continue
        index[key] = item
    return index, duplicates


def build_backfill_plan(
    raw_albums: list[dict[str, Any]],
    raw_metadata: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    metadata, duplicate_metadata = metadata_index(raw_metadata)
    counts = {
        "albumRecordCount": len(raw_albums),
        "previewMetadataRecordCount": len(raw_metadata),
        "eligiblePhotoCount": 0,
        "plannedJobCount": 0,
        "alreadyCompleteCount": 0,
        "pendingRetryCount": 0,
        "smallSourceSkippedCount": 0,
        "unsupportedSourceSkippedCount": 0,
        "inactiveAlbumSkippedCount": 0,
        "nonPhotoAlbumSkippedCount": 0,
        "malformedAlbumCount": 0,
        "malformedMediaCount": 0,
        "duplicateManifestMediaCount": 0,
        "conflictingMetadataCount": duplicate_metadata,
    }
    jobs: list[dict[str, Any]] = []
    seen_jobs: set[tuple[str, str]] = set()
    for raw_album in raw_albums:
        album = decoded_item(raw_album)
        album_id = normalized_uuid(album.get("albumId"))
        if not album_id or album.get("visibility") not in ALLOWED_VISIBILITIES or not isinstance(album.get("images"), list):
            counts["malformedAlbumCount"] += 1
            continue
        if album.get("status") not in (None, "active"):
            counts["inactiveAlbumSkippedCount"] += 1
            continue
        if album.get("type") not in (None, "photo"):
            counts["nonPhotoAlbumSkippedCount"] += 1
            continue
        canonical_prefix = f"albums/{album_id}/"
        legacy_prefix = album.get("legacyS3Prefix")
        allowed_prefixes = [canonical_prefix]
        if isinstance(legacy_prefix, str) and LEGACY_PREFIX_PATTERN.fullmatch(legacy_prefix):
            allowed_prefixes.append(legacy_prefix)

        for image in album["images"]:
            counts["eligiblePhotoCount"] += 1
            if not isinstance(image, dict):
                counts["malformedMediaCount"] += 1
                continue
            raw_key = normalized_key(image.get("rawKey") or image.get("key"))
            if not raw_key or not any(raw_key.startswith(prefix) for prefix in allowed_prefixes):
                counts["malformedMediaCount"] += 1
                continue
            extension = posixpath.splitext(raw_key.lower())[1]
            if extension not in ALLOWED_EXTENSIONS:
                counts["unsupportedSourceSkippedCount"] += 1
                continue
            try:
                width = int(image.get("width"))
            except (TypeError, ValueError):
                width = 0
            if width and width < max(PREVIEW_WIDTHS):
                counts["smallSourceSkippedCount"] += 1
                continue

            job_key = (album_id, raw_key)
            if job_key in seen_jobs:
                counts["duplicateManifestMediaCount"] += 1
                continue
            seen_jobs.add(job_key)

            media_id = media_id_for_key(raw_key)
            preview_keys = expected_preview_keys(album_id, raw_key)
            existing = metadata.get((album_id, media_id))
            if existing:
                valid_contract = (
                    existing.get("previewVersion") == PREVIEW_VERSION
                    and existing.get("previewKeys") == preview_keys
                    and existing.get("status") in {"ready", "pending"}
                )
                if not valid_contract:
                    counts["conflictingMetadataCount"] += 1
                    continue
                if existing["status"] == "ready":
                    counts["alreadyCompleteCount"] += 1
                    continue
                counts["pendingRetryCount"] += 1
            jobs.append({"albumId": album_id, "rawKey": raw_key, "previewVersion": PREVIEW_VERSION})

    jobs.sort(key=lambda item: (item["albumId"], item["rawKey"]))
    if len(jobs) != len({(job["albumId"], job["rawKey"]) for job in jobs}):
        raise AssertionError("Backfill plan contains duplicate albumId/rawKey jobs")
    counts["plannedJobCount"] = len(jobs)
    return jobs, counts


def plan_digest(jobs: list[dict[str, Any]]) -> str:
    payload = "\n".join(json.dumps(job, sort_keys=True, separators=(",", ":")) for job in jobs)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def validate_source_heads(
    jobs: list[dict[str, Any]],
    bucket: str,
    profile: str | None,
    region: str | None,
    maximum_bytes: int,
) -> tuple[list[dict[str, Any]], int]:
    def valid(job: dict[str, Any]) -> bool:
        try:
            head = aws_json(
                ["s3api", "head-object", "--bucket", bucket, "--key", job["rawKey"]],
                profile,
                region,
            )
            length = int(head.get("ContentLength", 0))
            content_type = str(head.get("ContentType", "")).lower()
            return 0 < length <= maximum_bytes and content_type in ALLOWED_CONTENT_TYPES
        except (RuntimeError, subprocess.CalledProcessError, TypeError, ValueError):
            return False

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(jobs)))) as executor:
        validity = list(executor.map(valid, jobs))
    return [job for job, is_valid in zip(jobs, validity) if is_valid], validity.count(False)


def validate_apply_guards(args: argparse.Namespace, account: str, counts: dict[str, int], digest: str) -> None:
    checks = [
        (args.expected_account_id == account, "--expected-account-id does not match"),
        (args.expected_record_count == counts["albumRecordCount"], "--expected-record-count does not match"),
        (
            args.expected_preview_record_count == counts["previewMetadataRecordCount"],
            "--expected-preview-record-count does not match",
        ),
        (args.expected_job_count == counts["plannedJobCount"], "--expected-job-count does not match"),
        (args.expected_plan_digest == digest, "--expected-plan-digest does not match"),
        (args.confirm_stack_name == args.stack_name, "--confirm-stack-name must exactly match"),
        (args.confirm == "backfill-preview-v2", "--confirm must be exactly backfill-preview-v2"),
        (counts["conflictingMetadataCount"] == 0, "conflicting preview metadata exists"),
        (counts.get("sourceValidationFailureCount", 0) == 0, "source HEAD validation failed"),
    ]
    for passed, message in checks:
        if not passed:
            raise SystemExit(f"Refusing apply: {message}.")
def dispatch_jobs(
    jobs: list[dict[str, Any]],
    queue_url: str,
    profile: str | None,
    region: str | None,
) -> int:
    """Send a deterministic, unique plan to SQS and stop on any batch defect."""
    unique_keys = {(job.get("albumId"), job.get("rawKey")) for job in jobs}
    if len(unique_keys) != len(jobs):
        raise ValueError("Refusing dispatch: duplicate albumId/rawKey jobs exist")
    if not jobs:
        return 0

    dispatched = 0
    for offset in range(0, len(jobs), 10):
        batch = jobs[offset:offset + 10]
        entries = [
            {
                "Id": f"job-{offset + index:08d}",
                "MessageBody": json.dumps(job, sort_keys=True, separators=(",", ":")),
            }
            for index, job in enumerate(batch)
        ]
        response = aws_json(
            [
                "sqs",
                "send-message-batch",
                "--queue-url",
                queue_url,
                "--entries",
                json.dumps(entries, sort_keys=True, separators=(",", ":")),
            ],
            profile,
            region,
        )
        failures = response.get("Failed", [])
        if not isinstance(failures, list) or failures:
            failure_codes = sorted(
                str(item.get("Code", "unknown"))
                for item in failures
                if isinstance(item, dict)
            )
            raise RuntimeError(
                f"SQS rejected preview jobs in batch {offset // 10 + 1}: "
                f"{failure_codes or ['malformed-response']}"
            )
        successful = response.get("Successful", [])
        successful_ids = {
            item.get("Id") for item in successful if isinstance(item, dict)
        } if isinstance(successful, list) else set()
        expected_ids = {entry["Id"] for entry in entries}
        if successful_ids != expected_ids:
            raise RuntimeError(
                f"SQS returned an incomplete acknowledgement for batch {offset // 10 + 1}"
            )
        dispatched += len(batch)
    return dispatched


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--max-source-bytes", type=int, default=100 * 1024 * 1024)
    parser.add_argument(
        "--max-jobs",
        type=int,
        help="Deterministic sorted canary size; omit to plan the complete backfill.",
    )
    parser.add_argument("--expected-account-id")
    parser.add_argument("--expected-record-count", type=int)
    parser.add_argument("--expected-preview-record-count", type=int)
    parser.add_argument("--expected-job-count", type=int)
    parser.add_argument("--expected-plan-digest")
    parser.add_argument("--confirm-stack-name")
    parser.add_argument("--confirm")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    account = aws_json(["sts", "get-caller-identity"], args.profile, args.region)["Account"]
    albums_table = stack_resource(args.stack_name, "AlbumsTable", args.profile, args.region)
    preview_table = stack_resource(args.stack_name, "PreviewMetadataTable", args.profile, args.region)
    images_bucket = stack_resource(args.stack_name, "ImagesBucket", args.profile, args.region)
    preview_queue_url = stack_resource(args.stack_name, "PreviewQueue", args.profile, args.region)
    albums = scan_all(
        albums_table,
        "albumId,#type,#status,#visibility,legacyS3Prefix,images",
        args.profile,
        args.region,
        {"#type": "type", "#status": "status", "#visibility": "visibility"},
    )
    metadata = scan_all(
        preview_table,
        "albumId,mediaId,previewVersion,previewKeys,#status",
        args.profile,
        args.region,
        {"#status": "status"},
    )
    jobs, counts = build_backfill_plan(albums, metadata)
    if args.max_jobs is not None and args.max_jobs < 1:
        raise SystemExit("--max-jobs must be a positive integer")
    total_planned_jobs = len(jobs)
    if args.max_jobs is not None:
        jobs = jobs[:args.max_jobs]
    jobs, head_failures = validate_source_heads(
        jobs, images_bucket, args.profile, args.region, args.max_source_bytes
    )
    counts["sourceValidationFailureCount"] = head_failures
    counts["plannedJobCount"] = len(jobs)
    digest = plan_digest(jobs)
    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "account": account,
        "stack": args.stack_name,
        "previewVersion": PREVIEW_VERSION,
        "planDigest": digest,
        "requestedMaxJobs": args.max_jobs,
        "totalEligiblePlannedJobCount": total_planned_jobs,
        **counts,
    }, indent=2, sort_keys=True))
    if not args.apply:
        print("Dry run only. No queue message, object, or table item was changed.")
        return 0

    validate_apply_guards(args, account, counts, digest)
    dispatched = dispatch_jobs(jobs, preview_queue_url, args.profile, args.region)
    print(json.dumps({
        "dispatch": "accepted",
        "jobCount": dispatched,
        "planDigest": digest,
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
