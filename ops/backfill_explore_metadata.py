#!/usr/bin/env python3
"""Plan or dispatch privacy-safe Explore metadata backfill jobs.

Dry-run is the default. Existing V3 previews are reused by the worker, so this
command never rewrites originals or derivative objects. Output is aggregate
only and intentionally excludes album IDs and object keys.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from typing import Any

from aws_stack import aws_json, stack_resource
from backfill_preview_v3 import (
    PREVIEW_VERSION,
    decoded_item,
    dispatch_jobs,
    media_id_for_key,
    normalized_key,
    normalized_uuid,
    scan_all,
)


EXPLORE_VERSION = 1
CONFIRMATION = "BACKFILL_EXPLORE_METADATA"
COLOR_FAMILIES = frozenset({
    "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "monochrome",
})
HEX_COLOR = re.compile(r"^#[0-9a-f]{6}$")


def _complete_explore(record: dict[str, Any] | None) -> bool:
    if not isinstance(record, dict) or record.get("exploreVersion") != EXPLORE_VERSION:
        return False
    palette = record.get("palette")
    families = record.get("colorFamilies")
    lens = record.get("lens")
    lens_key = record.get("lensKey")
    return bool(
        isinstance(palette, list)
        and 1 <= len(palette) <= 5
        and all(isinstance(value, str) and HEX_COLOR.fullmatch(value) for value in palette)
        and isinstance(families, list)
        and families
        and all(value in COLOR_FAMILIES for value in families)
        and isinstance(lens, str)
        and lens
        and lens_key == lens.casefold()
    )


def build_explore_plan(
    raw_albums: list[dict[str, Any]],
    raw_metadata: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    metadata = {}
    duplicate_metadata = 0
    for raw in raw_metadata:
        item = decoded_item(raw)
        key = (item.get("albumId"), item.get("mediaId"))
        if not all(isinstance(value, str) and value for value in key) or key in metadata:
            duplicate_metadata += 1
            continue
        metadata[key] = item

    counts = {
        "albumRecordCount": len(raw_albums),
        "previewMetadataRecordCount": len(raw_metadata),
        "eligiblePhotoCount": 0,
        "plannedJobCount": 0,
        "alreadyCompleteCount": 0,
        "previewNotReadyCount": 0,
        "inactiveAlbumSkippedCount": 0,
        "nonPhotoAlbumSkippedCount": 0,
        "malformedAlbumCount": 0,
        "malformedMediaCount": 0,
        "duplicateManifestMediaCount": 0,
        "duplicateMetadataCount": duplicate_metadata,
    }
    jobs = []
    seen = set()
    for raw_album in raw_albums:
        album = decoded_item(raw_album)
        album_id = normalized_uuid(album.get("albumId"))
        images = album.get("images")
        if not album_id or not isinstance(images, list):
            counts["malformedAlbumCount"] += 1
            continue
        if album.get("status") not in (None, "active"):
            counts["inactiveAlbumSkippedCount"] += 1
            continue
        if album.get("type") not in (None, "photo"):
            counts["nonPhotoAlbumSkippedCount"] += 1
            continue
        for image in images:
            counts["eligiblePhotoCount"] += 1
            if not isinstance(image, dict):
                counts["malformedMediaCount"] += 1
                continue
            raw_key = normalized_key(image.get("rawKey") or image.get("key"))
            if not raw_key:
                counts["malformedMediaCount"] += 1
                continue
            job_key = (album_id, raw_key)
            if job_key in seen:
                counts["duplicateManifestMediaCount"] += 1
                continue
            seen.add(job_key)
            record = metadata.get((album_id, media_id_for_key(raw_key)))
            if _complete_explore(record):
                counts["alreadyCompleteCount"] += 1
                continue
            if not isinstance(record, dict) or record.get("status") != "ready" or record.get("previewVersion") != PREVIEW_VERSION:
                counts["previewNotReadyCount"] += 1
                continue
            jobs.append({"albumId": album_id, "rawKey": raw_key, "previewVersion": PREVIEW_VERSION})
    jobs.sort(key=lambda job: (job["albumId"], job["rawKey"]))
    counts["plannedJobCount"] = len(jobs)
    return jobs, counts


def plan_digest(jobs: list[dict[str, Any]]) -> str:
    payload = json.dumps(jobs, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-stack-name")
    parser.add_argument("--confirm")
    parser.add_argument("--expected-plan-digest")
    args = parser.parse_args()

    account = aws_json(["sts", "get-caller-identity"], args.profile, args.region)["Account"]
    albums_table = stack_resource(args.stack_name, "AlbumsTable", args.profile, args.region)
    preview_table = stack_resource(args.stack_name, "PreviewMetadataTable", args.profile, args.region)
    preview_queue_url = stack_resource(args.stack_name, "PreviewQueue", args.profile, args.region)
    albums = scan_all(
        albums_table,
        "albumId,#type,#status,images",
        args.profile,
        args.region,
        {"#type": "type", "#status": "status"},
    )
    metadata = scan_all(
        preview_table,
        (
            "albumId,mediaId,previewVersion,#status,exploreVersion,palette,"
            "colorFamilies,lens,lensKey"
        ),
        args.profile,
        args.region,
        {"#status": "status"},
    )
    jobs, counts = build_explore_plan(albums, metadata)
    digest = plan_digest(jobs)
    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "account": account,
        "stack": args.stack_name,
        "exploreVersion": EXPLORE_VERSION,
        "planDigest": digest,
        **counts,
    }, indent=2, sort_keys=True))
    if not args.apply:
        print("Dry run only. No queue message, object, or table item was changed.")
        return 0
    if args.confirm_stack_name != args.stack_name or args.confirm != CONFIRMATION:
        raise SystemExit("Refusing apply: exact stack and confirmation phrase are required")
    if args.expected_plan_digest != digest:
        raise SystemExit("Refusing apply: plan digest changed")
    dispatched = dispatch_jobs(jobs, preview_queue_url, args.profile, args.region)
    print(json.dumps({"dispatch": "accepted", "jobCount": dispatched, "planDigest": digest}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
