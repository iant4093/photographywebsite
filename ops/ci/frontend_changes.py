#!/usr/bin/env python3
"""Publish changed frontend files and invalidate only changed mutable entrypoints.

The published manifest advances only AFTER CloudFront invalidation completes.
An interrupted deployment therefore repeats the outstanding invalidations.
Run inside the existing production release/rollback concurrency lock.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ops.ci.release_guard import frontend_upload_plan, sha256_file  # noqa: E402

PUBLISHED_KEY = "_deployment/frontend-manifest.json"
IMMEDIATE_PATHS = frozenset({"index.html", "print.html", "theme-init.js", "dark-theme.css",
                             "favicon.svg", "manifest.webmanifest", "service-worker.js"})


def plan_changes(root, previous, live=None):
    uploads = frontend_upload_plan(root)
    files = {item["path"]: {"sha256": sha256_file(root / item["path"]),
                            "cache_control": item["cache_control"]} for item in uploads}
    old = previous.get("files", {}) if previous.get("version") == 1 else {}
    if not isinstance(old, dict):
        raise ValueError("invalid published frontend manifest")
    unpublished = {item["path"] for item in uploads if old.get(item["path"]) != files[item["path"]]}
    # Check actual objects too: a failed release may have overwritten files
    # while leaving the last successful publication marker unchanged.
    changed = [item for item in uploads if (item["path"] in unpublished if live is None
               else not matches_object(root / item["path"], item, live.get(item["path"], {})))]
    paths = set()
    for path in unpublished | {item["path"] for item in changed}:
        if path in IMMEDIATE_PATHS:
            paths.add("/" + path)
        if path == "index.html":
            paths.add("/")
        if path.startswith("images/heroes/"):
            paths.add("/images/heroes/*")
    manifest = {"version": 1, "files": files}
    identity = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    return {"uploads": changed, "manifest": manifest,
            "invalidation": {"CallerReference": "frontend-" + identity,
                             "Paths": {"Quantity": len(paths), "Items": sorted(paths)}}}


def matches_object(path, item, metadata):
    # A multipart or KMS ETag is not proof of byte equality: upload those again.
    return (metadata.get("ServerSideEncryption") in {None, "AES256"}
            and metadata.get("ETag", "").strip('"') == hashlib.md5(path.read_bytes(), usedforsecurity=False).hexdigest()
            and metadata.get("CacheControl") == item["cache_control"]
            and (item["path"] not in {"index.html", "print.html"}
                 or metadata.get("ContentType") == "text/html; charset=utf-8"))


def aws(arguments, *, missing_ok=False, json_output=False):
    result = subprocess.run(["aws", *arguments], capture_output=True, text=True, timeout=180)
    if result.returncode:
        # Without ListBucket, S3 can report a missing marker as AccessDenied.
        # Fall back to a full upload; never infer that deployment succeeded.
        if missing_ok and re.search(r"\((NoSuchKey|404|AccessDenied|403)\)", result.stderr):
            return {} if json_output else False
        raise RuntimeError("frontend storage request failed")
    return json.loads(result.stdout) if json_output else True


def prepare(root, bucket, region, output):
    with tempfile.TemporaryDirectory() as directory:
        marker = Path(directory) / "published.json"
        found = aws(["s3api", "get-object", "--bucket", bucket, "--key", PUBLISHED_KEY,
                     "--region", region, str(marker)], missing_ok=True)
        if found and marker.stat().st_size > 2_000_000:
            raise ValueError("published frontend manifest exceeds bound")
        previous = json.loads(marker.read_text()) if found else {}
    live = {item["path"]: aws(["s3api", "head-object", "--bucket", bucket, "--key", item["path"],
                                "--region", region, "--output", "json"], missing_ok=True, json_output=True)
            for item in frontend_upload_plan(root)}
    plan = plan_changes(root, previous, live)
    # A rollback/history cycle must not reuse an old completed invalidation.
    plan["invalidation"]["CallerReference"] += "-" + uuid.uuid4().hex
    for item in plan["uploads"]:
        args = ["s3", "cp", str(root / item["path"]), f"s3://{bucket}/{item['path']}",
                "--region", region, "--cache-control", item["cache_control"], "--only-show-errors"]
        if item["path"] in {"index.html", "print.html"}:
            args += ["--content-type", "text/html; charset=utf-8"]
        aws(args)
    output.write_text(json.dumps(plan))
    output.with_suffix(".invalidation.json").write_text(json.dumps(plan["invalidation"]))
    print(json.dumps({"uploadedFiles": len(plan["uploads"]),
                      "invalidationPaths": plan["invalidation"]["Paths"]["Quantity"]}))


def publish(plan_path, bucket, region):
    plan = json.loads(plan_path.read_text())
    with tempfile.TemporaryDirectory() as directory:
        marker = Path(directory) / "published.json"
        marker.write_text(json.dumps(plan["manifest"], sort_keys=True))
        aws(["s3", "cp", str(marker), f"s3://{bucket}/{PUBLISHED_KEY}", "--region", region,
             "--cache-control", "private,no-store", "--content-type", "application/json", "--only-show-errors"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "publish"])
    parser.add_argument("--root", type=Path, default=Path("release/frontend/dist"))
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "prepare":
        prepare(args.root, args.bucket, args.region, args.plan)
    else:
        publish(args.plan, args.bucket, args.region)


if __name__ == "__main__":
    main()
