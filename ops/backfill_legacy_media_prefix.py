#!/usr/bin/env python3
"""Approve validated legacy album media prefixes; dry-run by default.

This migration never prints album IDs, prefixes, object keys, titles, or user
data. It refuses the entire apply if any album identifier/prefix is malformed,
any prefix is shared, any manifest/cover key escapes its record's exact prefix,
or an existing approval conflicts with the historic prefix.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import subprocess
from typing import Any
import uuid

from aws_stack import aws_json, stack_resource


PREFIX_PATTERN = re.compile(r"^albums/[a-z0-9](?:[a-z0-9._-]{0,198}[a-z0-9])?/$")


def decode(value: Any) -> Any:
    if not isinstance(value, dict) or len(value) != 1:
        return None
    kind, payload = next(iter(value.items()))
    if kind == "S":
        return payload if isinstance(payload, str) else None
    if kind == "L" and isinstance(payload, list):
        return [decode(item) for item in payload]
    if kind == "M" and isinstance(payload, dict):
        return {key: decode(item) for key, item in payload.items()}
    if kind == "NULL":
        return None
    return None


def field(item: dict[str, Any], name: str) -> Any:
    return decode(item.get(name))


def valid_uuid(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        normalized = str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return None
    return normalized if normalized == value else None


def valid_prefix(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 220:
        return None
    return value if PREFIX_PATTERN.fullmatch(value) else None


def classify_key(value: Any, prefix: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024:
        return "malformed"
    if value != value.strip() or value.startswith("/") or "\\" in value or "\x00" in value:
        return "malformed"
    normalized = posixpath.normpath(value)
    if normalized != value or normalized in {".", ".."} or normalized.startswith("../"):
        return "malformed"
    return "ok" if value.startswith(prefix) and value != prefix.rstrip("/") else "cross"


def record_media_keys(album: dict[str, Any]) -> list[Any]:
    keys: list[Any] = []
    for name in ("coverImageUrl", "coverThumbKey"):
        value = field(album, name)
        if value not in (None, ""):
            keys.append(value)
    images = field(album, "images")
    if images is None:
        return keys
    if not isinstance(images, list):
        return [*keys, None]
    for image in images:
        if isinstance(image, str):
            keys.append(image)
        elif isinstance(image, dict):
            raw = image.get("rawKey") or image.get("key")
            keys.append(raw)
            for name in ("thumbKey", "hlsUrl"):
                if image.get(name) not in (None, ""):
                    keys.append(image[name])
        else:
            keys.append(None)
    return keys


def scan_all(table: str, profile: str | None, region: str | None) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    start_key: dict[str, Any] | None = None
    seen_tokens: set[str] = set()
    while True:
        arguments = [
            "dynamodb", "scan", "--no-paginate", "--table-name", table,
            "--projection-expression", "albumId,s3Prefix,legacyS3Prefix,images,coverImageUrl,coverThumbKey",
        ]
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


def build_backfill_plan(albums: list[dict[str, Any]]) -> tuple[list[tuple[str, str]], dict[str, int]]:
    candidates: list[tuple[str, str]] = []
    counts = {
        "alreadyApprovedCount": 0,
        "malformedAlbumIdCount": 0,
        "malformedPrefixCount": 0,
        "conflictingApprovalCount": 0,
        "duplicatePrefixCount": 0,
        "malformedMediaKeyCount": 0,
        "crossPrefixMediaKeyCount": 0,
    }
    prefixes: dict[str, int] = {}
    prelim: list[tuple[str, str, Any, dict[str, Any]]] = []
    for album in albums:
        album_id = valid_uuid(field(album, "albumId"))
        prefix = valid_prefix(field(album, "s3Prefix"))
        existing = field(album, "legacyS3Prefix")
        if not album_id:
            counts["malformedAlbumIdCount"] += 1
        if not prefix:
            counts["malformedPrefixCount"] += 1
        if prefix:
            prefixes[prefix] = prefixes.get(prefix, 0) + 1
        prelim.append((album_id or "", prefix or "", existing, album))

    duplicate_prefixes = {prefix for prefix, count in prefixes.items() if count > 1}
    counts["duplicatePrefixCount"] = sum(prefixes[prefix] for prefix in duplicate_prefixes)
    for album_id, prefix, existing, album in prelim:
        if not album_id or not prefix or prefix in duplicate_prefixes:
            continue
        if existing not in (None, ""):
            if valid_prefix(existing) != prefix:
                counts["conflictingApprovalCount"] += 1
                continue
            already_approved = True
        else:
            already_approved = False

        unsafe = False
        for key in record_media_keys(album):
            classification = classify_key(key, prefix)
            if classification == "malformed":
                counts["malformedMediaKeyCount"] += 1
                unsafe = True
            elif classification == "cross":
                counts["crossPrefixMediaKeyCount"] += 1
                unsafe = True
        if unsafe:
            continue
        if already_approved:
            counts["alreadyApprovedCount"] += 1
        else:
            candidates.append((album_id, prefix))
    return candidates, counts


def plan_digest(candidates: list[tuple[str, str]]) -> str:
    payload = json.dumps(sorted(candidates), separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--expected-record-count", type=int)
    parser.add_argument("--expected-plan-digest")
    parser.add_argument("--confirm-stack-name")
    parser.add_argument("--confirm")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    account = aws_json(["sts", "get-caller-identity"], args.profile, args.region)["Account"]
    table = stack_resource(args.stack_name, "AlbumsTable", args.profile, args.region)
    albums = scan_all(table, args.profile, args.region)
    candidates, counts = build_backfill_plan(albums)
    digest = plan_digest(candidates)
    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "account": account,
        "stack": args.stack_name,
        "table": table,
        "albumRecordCount": len(albums),
        "safeBackfillCount": len(candidates),
        "planDigest": digest,
        **counts,
    }, indent=2))
    if not args.apply:
        print("Dry run only. No album record was changed.")
        return 0
    if args.expected_account_id != account:
        raise SystemExit("Refusing apply: --expected-account-id does not match.")
    if args.expected_record_count != len(albums):
        raise SystemExit("Refusing apply: --expected-record-count does not match the current table.")
    if args.expected_plan_digest != digest:
        raise SystemExit("Refusing apply: --expected-plan-digest does not match the current plan.")
    if args.confirm_stack_name != args.stack_name:
        raise SystemExit("Refusing apply: --confirm-stack-name must exactly match.")
    if args.confirm != "backfill-legacy-media-prefix":
        raise SystemExit("Refusing apply: --confirm must be exactly backfill-legacy-media-prefix.")
    unsafe = sum(value for key, value in counts.items() if key != "alreadyApprovedCount")
    if unsafe:
        raise SystemExit("Refusing apply while unsafe legacy-prefix records exist.")

    updated = conflicts = 0
    for album_id, prefix in candidates:
        try:
            aws_json([
                "dynamodb", "update-item", "--table-name", table,
                "--key", json.dumps({"albumId": {"S": album_id}}, separators=(",", ":")),
                "--update-expression", "SET legacyS3Prefix = :prefix",
                "--condition-expression",
                "attribute_exists(albumId) AND s3Prefix = :prefix AND (attribute_not_exists(legacyS3Prefix) OR legacyS3Prefix = :empty)",
                "--expression-attribute-values",
                json.dumps({":prefix": {"S": prefix}, ":empty": {"S": ""}}, separators=(",", ":")),
            ], args.profile, args.region)
            updated += 1
        except subprocess.CalledProcessError as error:
            if "ConditionalCheckFailedException" in (error.stderr or ""):
                conflicts += 1
            else:
                raise
    print(json.dumps({"updatedCount": updated, "conditionConflictCount": conflicts}, indent=2))
    return 1 if conflicts else 0


if __name__ == "__main__":
    raise SystemExit(main())
