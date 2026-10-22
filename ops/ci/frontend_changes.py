#!/usr/bin/env python3
"""Publish changed frontend files and purge the frontend edge when anything changed.

The edge holds the SPA shell for a day and the album/video social documents
(which embed the shell's hashed asset names) for up to an hour, so any change
invalidates the single wildcard path `/*` (one billable path). An unchanged
redeploy creates no invalidation.

The published manifest advances only AFTER CloudFront invalidation completes.
An interrupted deployment therefore repeats the outstanding invalidations.
Run inside the existing production release/rollback concurrency lock.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
from pathlib import Path
import sys
import uuid

from botocore.exceptions import ClientError

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ops.ci.release_guard import frontend_upload_plan, sha256_file  # noqa: E402
from ops.ci.aws_requests import client, parallel_map  # noqa: E402

PUBLISHED_KEY = "_deployment/frontend-manifest.json"
PURGE_PATHS = ("/*",)


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
    paths = list(PURGE_PATHS) if unpublished or changed else []
    manifest = {"version": 1, "files": files}
    identity = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    return {"uploads": changed, "manifest": manifest,
            "invalidation": {"CallerReference": "frontend-" + identity,
                             "Paths": {"Quantity": len(paths), "Items": paths}}}


def matches_object(path, item, metadata):
    # A multipart or KMS ETag is not proof of byte equality: upload those again.
    return (metadata.get("ServerSideEncryption") in {None, "AES256"}
            and metadata.get("ETag", "").strip('"') == hashlib.md5(path.read_bytes(), usedforsecurity=False).hexdigest()
            and metadata.get("CacheControl") == item["cache_control"]
            and (item["path"] not in {"index.html", "print.html"}
                 or metadata.get("ContentType") == "text/html; charset=utf-8"))


def missing(error):
    # Without ListBucket, S3 may report a missing object as AccessDenied.
    return error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "AccessDenied", "403"}


def previous_manifest(storage, bucket):
    try:
        response = storage.get_object(Bucket=bucket, Key=PUBLISHED_KEY)
    except ClientError as error:
        if missing(error):
            return {}
        raise
    with response["Body"] as body:
        content = body.read(2_000_001)
    if len(content) > 2_000_000:
        raise ValueError("published frontend manifest exceeds bound")
    return json.loads(content)


def prepare(root, bucket, region, output):
    storage = client("s3", region)
    previous = previous_manifest(storage, bucket)

    def head(item):
        try:
            metadata = storage.head_object(Bucket=bucket, Key=item["path"])
        except ClientError as error:
            if not missing(error):
                raise
            metadata = {}
        return item["path"], metadata

    live = dict(parallel_map(head, frontend_upload_plan(root)))
    plan = plan_changes(root, previous, live)
    # A rollback/history cycle must not reuse an old completed invalidation.
    plan["invalidation"]["CallerReference"] += "-" + uuid.uuid4().hex
    def upload(item):
        path = item["path"]
        content_type = ("text/html; charset=utf-8" if path in {"index.html", "print.html"}
                        else mimetypes.guess_type(path)[0] or "application/octet-stream")
        # Bounded single-object puts; the artifact budget keeps these small.
        with (root / path).open("rb") as body:
            storage.put_object(Bucket=bucket, Key=path, Body=body,
                               CacheControl=item["cache_control"], ContentType=content_type)

    parallel_map(upload, [item for item in plan["uploads"] if item["path"] not in {"index.html", "print.html"}])
    # Publish entrypoints only after every dependency succeeded, index last.
    for item in plan["uploads"]:
        if item["path"] in {"print.html", "index.html"}:
            upload(item)
    output.write_text(json.dumps(plan))
    output.with_suffix(".invalidation.json").write_text(json.dumps(plan["invalidation"]))
    print(json.dumps({"uploadedFiles": len(plan["uploads"]),
                      "invalidationPaths": plan["invalidation"]["Paths"]["Quantity"]}))


def publish(plan_path, bucket, region):
    plan = json.loads(plan_path.read_text())
    client("s3", region).put_object(
        Bucket=bucket, Key=PUBLISHED_KEY,
        Body=json.dumps(plan["manifest"], sort_keys=True).encode(),
        CacheControl="private,no-store", ContentType="application/json",
    )


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
    try:
        main()
    except Exception:
        # Provider failures can contain object names or signed request details.
        print("frontend storage publication failed closed", file=sys.stderr)
        raise SystemExit(2) from None
