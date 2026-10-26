#!/usr/bin/env python3
"""Migrate exact release versions in place; dry-run unless --apply is supplied.

The inventory is the private JSON captured before migration. This tool never
copies/deletes an object, changes a version ID, bypasses Object Lock, or deletes
a KMS key. A fresh metadata read is required before and after every update.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path

import boto3
from botocore.config import Config


REGION = "us-west-2"
IMMUTABLE = ("VersionId", "ETag", "ContentLength", "LastModified", "Metadata", "ContentType")
RELEASE_PREFIXES = ("releases/", "bootstrap-templates/", "manual-cloudformation/", "manual-cost-optimization/")


def inventory_digest(inventory):
    return hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def migrate_version(s3, *, bucket, row, account, source_key, target_key, apply):
    args = {"Bucket": bucket, "Key": row["Key"], "VersionId": row["VersionId"],
            "ExpectedBucketOwner": account}
    before = s3.head_object(**args)
    if (before["VersionId"] != row["VersionId"] or before["ETag"] != row["ETag"]
            or before["ContentLength"] != row["Size"]):
        raise ValueError("release version differs from the reviewed inventory")
    if before.get("SSEKMSKeyId") == target_key:
        return "already-managed"
    if before.get("ServerSideEncryption") != "aws:kms" or before.get("SSEKMSKeyId") != source_key:
        raise ValueError("release encryption differs from the reviewed source key")
    if before.get("ObjectLockMode") or before.get("ObjectLockLegalHoldStatus") == "ON":
        raise ValueError("locked versions must retain their existing decryption key")
    if not apply:
        return "eligible"
    s3.update_object_encryption(**args, ObjectEncryption={
        "SSEKMS": {"KMSKeyArn": target_key, "BucketKeyEnabled": True},
    })
    after = s3.head_object(**args)
    if any(before.get(k) != after.get(k) for k in IMMUTABLE):
        raise RuntimeError("release version metadata changed during encryption migration")
    if after.get("SSEKMSKeyId") != target_key or not after.get("BucketKeyEnabled"):
        raise RuntimeError("release version encryption verification failed")
    return "migrated"


def run(args):
    config = Config(max_pool_connections=48, retries={"mode": "standard", "max_attempts": 5},
                    connect_timeout=5, read_timeout=30)
    identity = boto3.client("sts", region_name=REGION, config=config).get_caller_identity()
    if identity["Account"] != args.expected_account_id:
        raise ValueError("unexpected AWS account")
    inventory = json.loads(Path(args.inventory).read_text())
    bucket, rows = inventory["bucket"], inventory["objects"]
    if not bucket.startswith("ian-photography-ci-bootstrap-releaseartifactbucket-"):
        raise ValueError("unexpected release bucket")
    if not 1 <= len(rows) <= 25000 or len(rows) != args.expected_version_count:
        raise ValueError("release version count differs from the reviewed inventory")
    if len({(r["Key"], r["VersionId"]) for r in rows}) != len(rows):
        raise ValueError("duplicate release versions")
    if any(not r["Key"].startswith(RELEASE_PREFIXES) or not r["VersionId"] or r["VersionId"] == "null" for r in rows):
        raise ValueError("unrecognized or unversioned release object")
    digest = inventory_digest(inventory)
    if args.apply and args.confirm_digest != digest:
        raise ValueError("inventory confirmation digest differs")
    kms = boto3.client("kms", region_name=REGION, config=config)
    target = kms.describe_key(KeyId="alias/aws/s3")["KeyMetadata"]
    source = kms.describe_key(KeyId=args.source_key_arn)["KeyMetadata"]
    if (target["KeyManager"] != "AWS" or source["KeyManager"] != "CUSTOMER"
            or source["AWSAccountId"] != identity["Account"]
            or target["AWSAccountId"] != identity["Account"]
            or source["KeyState"] != "Enabled"):
        raise ValueError("unexpected source or destination key ownership")
    s3 = boto3.client("s3", region_name=REGION, config=config)
    if s3.get_bucket_versioning(Bucket=bucket, ExpectedBucketOwner=identity["Account"]).get("Status") != "Enabled":
        raise ValueError("release bucket versioning is not enabled")
    counts = {}
    def migrate(row):
        return migrate_version(s3, bucket=bucket, row=row, account=identity["Account"],
                               source_key=source["Arn"], target_key=target["Arn"], apply=args.apply)
    # Exact version IDs make concurrent reads and rewraps independent.
    with ThreadPoolExecutor(max_workers=32) as pool:
        for index, result in enumerate(pool.map(migrate, rows), 1):
            counts[result] = counts.get(result, 0) + 1
            if index % 1000 == 0:
                print(json.dumps({"checkedVersions": index, "totalVersions": len(rows), **counts}), flush=True)
    report = {"mode": "apply" if args.apply else "dry-run", "inventoryDigest": digest,
              "versions": len(rows), "bytes": sum(r["Size"] for r in rows), **counts}
    print(json.dumps(report, sort_keys=True), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-account-id", required=True)
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--source-key-arn", required=True)
    parser.add_argument("--expected-version-count", required=True, type=int)
    parser.add_argument("--confirm-digest")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        run(args)
    except Exception as error:
        # Object names, versions, provider payloads, and data never enter logs.
        print(json.dumps({"error": type(error).__name__, "migrationComplete": False}))
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
