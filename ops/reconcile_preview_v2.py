#!/usr/bin/env python3
"""Read-only, aggregate-only reconciliation for responsive preview V2.

The command verifies the digest-bound eligible inventory, ready metadata,
stored preview bytes/properties/tags, and public-versus-protected CloudFront
behavior. It never prints album IDs, media IDs, object keys, URLs, titles,
owners, share codes, or per-item failure details.
"""

from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import pathlib
import re
import subprocess
import tempfile
from typing import Any
import urllib.error
import urllib.parse
import urllib.request

from aws_stack import aws_json, stack_resource
import backfill_preview_v2 as backfill


EXPECTED_CACHE_CONTROL = "public, max-age=31536000, immutable"
EXPECTED_GENERATOR = "responsive-preview-v2"
CHECKSUM_FIELDS = (
    "ChecksumCRC32",
    "ChecksumCRC32C",
    "ChecksumCRC64NVME",
    "ChecksumSHA1",
    "ChecksumSHA256",
)
ETAG_PATTERN = re.compile(r'^"?[0-9a-fA-F]{32}"?$')
CLOUDFRONT_DOMAIN_PATTERN = re.compile(r"^[a-z0-9]+\.cloudfront\.net$")


def expected_inventory(
    raw_albums: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    jobs, counts = backfill.build_backfill_plan(raw_albums, [])
    facts = backfill.selection_facts(raw_albums, jobs)
    inventory = []
    for job in jobs:
        key = (job["albumId"], job["rawKey"])
        visibility = facts.get(key, {}).get("visibility")
        if visibility not in backfill.ALLOWED_VISIBILITIES:
            raise RuntimeError("Eligible inventory is missing a valid access classification")
        inventory.append({"job": job, "visibility": visibility})
    return inventory, counts


def inventory_digest(inventory: list[dict[str, Any]]) -> str:
    return backfill.plan_digest([item["job"] for item in inventory])


def parse_webp_dimensions(data: bytes) -> tuple[int, int]:
    """Parse dimensions from the bounded leading WebP chunk."""
    if len(data) < 25 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("invalid WebP container")
    chunk = data[12:16]
    if chunk == b"VP8X":
        if len(data) < 30:
            raise ValueError("truncated VP8X header")
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
    elif chunk == b"VP8 ":
        if len(data) < 30 or data[23:26] != b"\x9d\x01\x2a":
            raise ValueError("invalid VP8 frame header")
        width = int.from_bytes(data[26:28], "little") & 0x3FFF
        height = int.from_bytes(data[28:30], "little") & 0x3FFF
    elif chunk == b"VP8L":
        if len(data) < 25 or data[20] != 0x2F:
            raise ValueError("invalid VP8L frame header")
        b1, b2, b3, b4 = data[21:25]
        width = 1 + b1 + ((b2 & 0x3F) << 8)
        height = 1 + ((b2 & 0xC0) >> 6) + (b3 << 2) + ((b4 & 0x0F) << 10)
    else:
        raise ValueError("unsupported leading WebP chunk")
    if width < 1 or height < 1:
        raise ValueError("invalid WebP dimensions")
    return width, height


def read_object_prefix(
    bucket: str,
    key: str,
    version_id: str | None,
    profile: str | None,
    region: str | None,
) -> bytes:
    """Read only the bounded bytes required for WebP dimension validation."""
    with tempfile.TemporaryDirectory(prefix="preview-v2-reconcile-") as directory:
        destination = pathlib.Path(directory) / "header.bin"
        command = ["aws"]
        if profile:
            command.extend(["--profile", profile])
        if region:
            command.extend(["--region", region])
        command.extend([
            "s3api", "get-object",
            "--bucket", bucket,
            "--key", key,
            "--range", "bytes=0-63",
        ])
        if version_id and version_id != "null":
            command.extend(["--version-id", version_id])
        command.extend([str(destination), "--output", "json"])
        subprocess.run(command, check=True, text=True, capture_output=True)
        return destination.read_bytes()


def edge_head(domain: str, key: str, timeout_seconds: float) -> tuple[int, dict[str, str]]:
    path = urllib.parse.quote(key, safe="/-_.~")
    request = urllib.request.Request(
        f"https://{domain}/{path}",
        method="HEAD",
        headers={"User-Agent": "preview-v2-reconcile/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return response.status, {name.lower(): value for name, value in response.headers.items()}
    except urllib.error.HTTPError as error:
        headers = error.headers or {}
        return error.code, {name.lower(): value for name, value in headers.items()}
    except (urllib.error.URLError, TimeoutError, ValueError):
        return 0, {}


def validate_bucket_controls(
    bucket: str,
    profile: str | None,
    region: str | None,
) -> tuple[str | None, Counter[str]]:
    failures: Counter[str] = Counter()
    public_access = aws_json(
        ["s3api", "get-public-access-block", "--bucket", bucket], profile, region
    ).get("PublicAccessBlockConfiguration", {})
    if not all(public_access.get(name) is True for name in (
        "BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"
    )):
        failures["bucketPublicAccessBlockInvalid"] += 1
    policy_status = aws_json(
        ["s3api", "get-bucket-policy-status", "--bucket", bucket], profile, region
    ).get("PolicyStatus", {})
    if policy_status.get("IsPublic") is not False:
        failures["bucketPolicyPublicOrUnknown"] += 1
    versioning = aws_json(
        ["s3api", "get-bucket-versioning", "--bucket", bucket], profile, region
    )
    if versioning.get("Status") != "Enabled":
        failures["bucketVersioningNotEnabled"] += 1
    encryption = aws_json(
        ["s3api", "get-bucket-encryption", "--bucket", bucket], profile, region
    )
    rules = encryption.get("ServerSideEncryptionConfiguration", {}).get("Rules", [])
    algorithms = {
        rule.get("ApplyServerSideEncryptionByDefault", {}).get("SSEAlgorithm")
        for rule in rules if isinstance(rule, dict)
    }
    algorithms.discard(None)
    if len(algorithms) != 1 or next(iter(algorithms), None) not in {"AES256", "aws:kms", "aws:kms:dsse"}:
        failures["bucketEncryptionInvalid"] += 1
        return None, failures
    return next(iter(algorithms)), failures


def validate_ready_metadata(
    metadata: dict[str, Any] | None,
    expected_keys: dict[str, str],
) -> tuple[str | None, dict[str, int] | None, Counter[str]]:
    failures: Counter[str] = Counter()
    if metadata is None:
        failures["metadataMissing"] += 1
        return None, None, failures
    if metadata.get("status") != "ready":
        failures["metadataNotReady"] += 1
    if metadata.get("previewVersion") != backfill.PREVIEW_VERSION:
        failures["metadataVersionInvalid"] += 1
    if metadata.get("previewKeys") != expected_keys:
        failures["metadataKeysInvalid"] += 1
    source_digest = metadata.get("sourceSha256")
    if not isinstance(source_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", source_digest):
        failures["metadataSourceChecksumInvalid"] += 1
        source_digest = None
    dimensions = metadata.get("dimensions")
    normalized_dimensions: dict[str, int] = {}
    if not isinstance(dimensions, dict) or set(dimensions) != {str(width) for width in backfill.PREVIEW_WIDTHS}:
        failures["metadataDimensionsInvalid"] += 1
    else:
        for width in backfill.PREVIEW_WIDTHS:
            value = dimensions.get(str(width))
            try:
                stored_width = int(value.get("width"))
                height = int(value.get("height"))
            except (AttributeError, TypeError, ValueError):
                stored_width = height = 0
            if stored_width != width or height < 1:
                failures["metadataDimensionsInvalid"] += 1
            else:
                normalized_dimensions[str(width)] = height
    if len(normalized_dimensions) == len(backfill.PREVIEW_WIDTHS):
        if abs(normalized_dimensions["1280"] - (2 * normalized_dimensions["640"])) > 1:
            failures["metadataAspectRatioMismatch"] += 1
    if "jobId" in metadata:
        failures["readyMetadataRetainsJobId"] += 1
    return source_digest, normalized_dimensions or None, failures


def validate_object(
    *,
    bucket: str,
    key: str,
    width: int,
    height: int,
    source_digest: str,
    visibility: str,
    expected_encryption: str,
    media_domain: str,
    profile: str | None,
    region: str | None,
    maximum_bytes: int,
    timeout_seconds: float,
) -> Counter[str]:
    failures: Counter[str] = Counter()
    try:
        head = aws_json([
            "s3api", "head-object", "--bucket", bucket, "--key", key,
            "--checksum-mode", "ENABLED",
        ], profile, region)
        try:
            length = int(head.get("ContentLength", 0))
        except (TypeError, ValueError):
            length = 0
        if not 0 < length <= maximum_bytes:
            failures["objectSizeInvalid"] += 1
        if head.get("ContentType") != "image/webp":
            failures["objectContentTypeInvalid"] += 1
        if head.get("CacheControl") != EXPECTED_CACHE_CONTROL:
            failures["objectCacheControlInvalid"] += 1
        if head.get("ServerSideEncryption") != expected_encryption:
            failures["objectEncryptionInvalid"] += 1
        metadata = head.get("Metadata", {})
        if not isinstance(metadata, dict) or (
            metadata.get("preview-version") != str(backfill.PREVIEW_VERSION)
            or metadata.get("preview-width") != str(width)
            or metadata.get("source-sha256") != source_digest
            or metadata.get("generator") != EXPECTED_GENERATOR
        ):
            failures["objectMetadataInvalid"] += 1
        checksum_present = any(isinstance(head.get(name), str) and head[name] for name in CHECKSUM_FIELDS)
        if not checksum_present and not ETAG_PATTERN.fullmatch(str(head.get("ETag", ""))):
            failures["objectChecksumMissing"] += 1

        dimensions = parse_webp_dimensions(read_object_prefix(
            bucket, key, head.get("VersionId"), profile, region
        ))
        if dimensions != (width, height):
            failures["objectDimensionsInvalid"] += 1

        tags = aws_json(
            ["s3api", "get-object-tagging", "--bucket", bucket, "--key", key],
            profile,
            region,
        ).get("TagSet", [])
        tag_values = [
            item.get("Value") for item in tags
            if isinstance(item, dict) and item.get("Key") == "visibility"
        ]
        if tag_values != [visibility]:
            failures["objectVisibilityTagInvalid"] += 1

        status, headers = edge_head(media_domain, key, timeout_seconds)
        if visibility == "public":
            if status != 200:
                failures["publicEdgeAccessInvalid"] += 1
            elif (
                headers.get("content-type", "").split(";", 1)[0].strip().lower() != "image/webp"
                or headers.get("cache-control") != EXPECTED_CACHE_CONTROL
            ):
                failures["publicEdgeHeadersInvalid"] += 1
        elif status != 403:
            failures["protectedEdgeAccessInvalid"] += 1
    # This is a privacy boundary: unexpected per-object SDK/HTTP/filesystem
    # errors collapse to a fixed aggregate code rather than escaping with a
    # command, URL, or object key in their exception text.
    except Exception:
        failures["objectInspectionError"] += 1
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--expected-account-id", required=True)
    parser.add_argument("--expected-inventory-count", type=int, required=True)
    parser.add_argument("--expected-inventory-digest", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--max-preview-bytes", type=int, default=20 * 1024 * 1024)
    parser.add_argument("--edge-timeout-seconds", type=float, default=10.0)
    args = parser.parse_args()
    if not 1 <= args.workers <= 32:
        raise SystemExit("--workers must be between 1 and 32")
    if (
        args.expected_inventory_count < 0
        or args.max_preview_bytes < 1
        or args.edge_timeout_seconds <= 0
    ):
        raise SystemExit("Expected counts, byte limits, and timeouts must be valid positive bounds")
    if not re.fullmatch(r"[0-9a-f]{64}", args.expected_inventory_digest):
        raise SystemExit("--expected-inventory-digest must be a lowercase SHA-256 digest")

    account = aws_json(["sts", "get-caller-identity"], args.profile, args.region).get("Account")
    if account != args.expected_account_id:
        raise SystemExit("Refusing reconciliation: --expected-account-id does not match")
    albums_table = stack_resource(args.stack_name, "AlbumsTable", args.profile, args.region)
    preview_table = stack_resource(args.stack_name, "PreviewMetadataTable", args.profile, args.region)
    bucket = stack_resource(args.stack_name, "ImagesBucket", args.profile, args.region)
    distribution_id = stack_resource(args.stack_name, "ImagesCloudFront", args.profile, args.region)
    distribution = aws_json(
        ["cloudfront", "get-distribution", "--id", distribution_id], args.profile, args.region
    ).get("Distribution", {})
    media_domain = distribution.get("DomainName")
    distribution_config = distribution.get("DistributionConfig", {})
    if (
        distribution.get("Status") != "Deployed"
        or distribution_config.get("Enabled") is not True
        or not isinstance(media_domain, str)
        or not CLOUDFRONT_DOMAIN_PATTERN.fullmatch(media_domain)
    ):
        raise SystemExit("Refusing reconciliation: media distribution is not enabled and deployed")

    albums = backfill.scan_all(
        albums_table,
        "albumId,#type,#status,#visibility,legacyS3Prefix,images",
        args.profile,
        args.region,
        {"#type": "type", "#status": "status", "#visibility": "visibility"},
    )
    raw_metadata = backfill.scan_all(
        preview_table,
        "albumId,mediaId,previewVersion,previewKeys,#status,sourceSha256,dimensions,jobId",
        args.profile,
        args.region,
        {"#status": "status"},
    )
    inventory, inventory_counts = expected_inventory(albums)
    digest = inventory_digest(inventory)
    if len(inventory) != args.expected_inventory_count:
        raise SystemExit("Refusing reconciliation: --expected-inventory-count does not match")
    if digest != args.expected_inventory_digest:
        raise SystemExit("Refusing reconciliation: --expected-inventory-digest does not match")

    expected_encryption, failures = validate_bucket_controls(bucket, args.profile, args.region)
    metadata, duplicate_metadata = backfill.metadata_index(raw_metadata)
    if duplicate_metadata:
        failures["duplicateMetadataRecord"] += duplicate_metadata
    expected_metadata_keys = {
        (item["job"]["albumId"], backfill.media_id_for_key(item["job"]["rawKey"]))
        for item in inventory
    }
    orphan_count = len(set(metadata) - expected_metadata_keys)
    if orphan_count:
        failures["orphanMetadataRecord"] += orphan_count

    object_validated = 0
    entry_validated = 0

    def reconcile(item: dict[str, Any]) -> tuple[Counter[str], int]:
        job = item["job"]
        expected_keys = backfill.expected_preview_keys(job["albumId"], job["rawKey"])
        record = metadata.get((job["albumId"], backfill.media_id_for_key(job["rawKey"])))
        source_digest, dimensions, item_failures = validate_ready_metadata(record, expected_keys)
        valid_objects = 0
        if item_failures or source_digest is None or dimensions is None or expected_encryption is None:
            return item_failures, valid_objects
        for width in backfill.PREVIEW_WIDTHS:
            object_failures = validate_object(
                bucket=bucket,
                key=expected_keys[str(width)],
                width=width,
                height=dimensions[str(width)],
                source_digest=source_digest,
                visibility=item["visibility"],
                expected_encryption=expected_encryption,
                media_domain=media_domain,
                profile=args.profile,
                region=args.region,
                maximum_bytes=args.max_preview_bytes,
                timeout_seconds=args.edge_timeout_seconds,
            )
            item_failures.update(object_failures)
            if not object_failures:
                valid_objects += 1
        return item_failures, valid_objects

    with ThreadPoolExecutor(max_workers=min(args.workers, max(1, len(inventory)))) as executor:
        results = list(executor.map(reconcile, inventory))
    for item_failures, valid_objects in results:
        failures.update(item_failures)
        object_validated += valid_objects
        if not item_failures and valid_objects == len(backfill.PREVIEW_WIDTHS):
            entry_validated += 1

    summary = {
        "account": account,
        "eligibleInventoryCount": len(inventory),
        "eligibleInventoryDigest": digest,
        "entryValidatedCount": entry_validated,
        "expectedObjectCount": len(inventory) * len(backfill.PREVIEW_WIDTHS),
        "failureCounts": dict(sorted(failures.items())),
        "metadataRecordCount": len(raw_metadata),
        "objectValidatedCount": object_validated,
        "privacy": "aggregate-only; no album, media, object, URL, owner, title, or share identifiers emitted",
        "reconciliationScope": "full",
        "stack": args.stack_name,
        "status": "pass" if not failures and entry_validated == len(inventory) else "fail",
        "sourceInventoryCounts": inventory_counts,
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
