#!/usr/bin/env python3
"""Bounded release-archive cleanup; dry-run unless --apply is supplied.

Run under the production workflow concurrency lock. Only exact backend release
versions older than the retained window are eligible; live template references
and recent successful releases are protected regardless of age.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
from collections import defaultdict


REGION = "us-west-2"
BOOTSTRAP = "ian-photography-ci-bootstrap"
APPLICATION = "ian-website"
REPOSITORY = "iant4093/photographywebsite"
SHA = re.compile(r"[0-9a-f]{40}")
KEY = re.compile(r"releases/([0-9a-f]{40})/([0-9]+-[0-9]+)/backend/(packaged\.yaml|[0-9a-f]{32,64}(?:\.template)?)")
MAX_INVENTORY = 100000
MAX_DELETE = 1000
MAX_BYTES = 5 * 1024**3


class CleanupError(ValueError):
    pass


def command_json(command):
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=90)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise CleanupError("provider request failed; no provider payload logged") from error


def aws(*arguments):
    return command_json(["aws", "--region", REGION, *arguments, "--output", "json", "--no-cli-pager"])


def github_releases():
    headers = {"Accept": "application/vnd.github+json"}
    if os.environ.get("GH_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPOSITORY}/actions/workflows/release-production.yml/runs?branch=main&status=success&per_page=100",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except (OSError, ValueError) as error:
        raise CleanupError("successful release lookup failed") from error


def timestamp(value):
    try:
        result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError()
        return result
    except (AttributeError, TypeError, ValueError) as error:
        raise CleanupError("invalid inventory timestamp") from error


def successful_releases(response):
    runs = response.get("workflow_runs")
    if not isinstance(runs, list):
        raise CleanupError("missing successful release inventory")
    result = set()
    for run in runs:
        if (run.get("head_branch") != "main" or run.get("conclusion") != "success"
                or run.get("event") != "push" or run.get("name") != "Release production"
                or run.get("path") != ".github/workflows/release-production.yml"
                or run.get("repository", {}).get("full_name") != REPOSITORY
                or not SHA.fullmatch(str(run.get("head_sha", "")))):
            raise CleanupError("untrusted release metadata")
        result.add(run["head_sha"])
        if len(result) == 5:
            break
    if len(result) < 2:
        raise CleanupError("at least two known-good releases are required")
    return result


def stack_snapshot(bucket):
    stack = aws("cloudformation", "describe-stacks", "--stack-name", APPLICATION)["Stacks"][0]
    if (stack.get("StackStatus") not in {"CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"}
            or not stack.get("EnableTerminationProtection")):
        raise CleanupError("application stack must be stable and protected")
    changes = aws("cloudformation", "list-change-sets", "--stack-name", APPLICATION)
    if any(c.get("ExecutionStatus") in {"AVAILABLE", "EXECUTE_IN_PROGRESS"} for c in changes.get("Summaries", [])):
        raise CleanupError("pending application change set blocks cleanup")
    parameters = {p["ParameterKey"]: p["ParameterValue"] for p in stack["Parameters"]}
    release = parameters.get("ReleaseSha", "")
    if not SHA.fullmatch(release):
        raise CleanupError("current release identity is unavailable")
    template = aws("cloudformation", "get-template", "--stack-name", APPLICATION, "--template-stage", "Processed")["TemplateBody"]
    if isinstance(template, str):
        template = json.loads(template)
    if not isinstance(template, dict) or not template.get("Resources"):
        raise CleanupError("processed template is unavailable")
    protected = {release}

    def visit(value):
        if isinstance(value, dict):
            if value.get("Type") == "AWS::CloudFormation::Stack":
                raise CleanupError("nested stack references need explicit support")
            if "S3Bucket" in value and "S3Key" in value:
                if not isinstance(value["S3Bucket"], str):
                    raise CleanupError("unresolved artifact bucket reference")
                if value["S3Bucket"] == bucket:
                    match = KEY.fullmatch(str(value["S3Key"]))
                    if not match:
                        raise CleanupError("unrecognized live artifact reference")
                    protected.add(match[1])
            for item in value.values():
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(template)
    identity = [stack["StackId"], str(stack.get("LastUpdatedTime", stack.get("CreationTime"))), release, template]
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    return digest, protected


def inventory(bucket, account):
    versions, markers, seen = [], [], set()
    arguments = []
    for _ in range(101):
        page = aws("s3api", "list-object-versions", "--bucket", bucket, "--expected-bucket-owner", account,
                   "--prefix", "releases/", "--max-keys", "1000", "--no-paginate", *arguments)
        versions.extend(page.get("Versions", []))
        markers.extend(page.get("DeleteMarkers", []))
        if len(versions) + len(markers) > MAX_INVENTORY:
            raise CleanupError("inventory limit exceeded")
        if page.get("IsTruncated") is False:
            return versions, markers
        pair = (page.get("NextKeyMarker"), page.get("NextVersionIdMarker"))
        if not all(isinstance(p, str) and p for p in pair) or pair in seen:
            raise CleanupError("incomplete or repeating inventory page")
        seen.add(pair)
        arguments = ["--key-marker", pair[0], "--version-id-marker", pair[1]]
    raise CleanupError("inventory page limit exceeded")


def plan_cleanup(versions, markers, protected, now, days):
    if not 180 <= days <= 3650 or now.tzinfo is None:
        raise CleanupError("retention must be at least 180 days")
    cutoff = now - dt.timedelta(days=days)
    groups = defaultdict(list)
    blocked = set()
    for item in [*versions, *markers]:
        key = item.get("Key")
        version = item.get("VersionId")
        if not isinstance(key, str) or not isinstance(version, str) or not version or version == "null":
            raise CleanupError("invalid version inventory")
        match = KEY.fullmatch(key)
        # Unknown file layouts are never removed. Protect their whole attempt.
        if not match:
            blocked.add("/".join(key.split("/")[:3]))
            continue
        prefix = "/".join(key.split("/")[:3])
        changed = timestamp(item.get("LastModified"))
        if changed >= cutoff or match[1] in protected:
            blocked.add(prefix)
        size = item.get("Size", 0)
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise CleanupError("invalid object size")
        groups[prefix].append({"Key": key, "VersionId": version, "Size": size})
    planned, byte_count, remaining = [], 0, 0
    for prefix, items in sorted(groups.items()):
        if prefix in blocked:
            continue
        for item in sorted(items, key=lambda i: (i["Key"], i["VersionId"])):
            if len(planned) >= MAX_DELETE or byte_count + item["Size"] > MAX_BYTES:
                remaining += 1
                continue
            planned.append(item)
            byte_count += item["Size"]
    return planned, {"eligibleVersions": len(planned), "eligibleBytes": byte_count,
                     "deferredVersions": remaining, "inventoriedVersions": len(versions) + len(markers)}


def apply_plan(bucket, account, planned, original_snapshot):
    deleted = 0
    for start in range(0, len(planned), 100):
        if stack_snapshot(bucket)[0] != original_snapshot:
            raise CleanupError("application changed after planning; stopping cleanup")
        batch = [{"Key": i["Key"], "VersionId": i["VersionId"]} for i in planned[start:start + 100]]
        response = aws("s3api", "delete-objects", "--bucket", bucket, "--expected-bucket-owner", account,
                       "--delete", json.dumps({"Objects": batch, "Quiet": False}))
        expected = {(v["Key"], v["VersionId"]) for v in batch}
        actual = {(v.get("Key"), v.get("VersionId")) for v in response.get("Deleted", [])}
        if response.get("Errors") or actual != expected:
            raise CleanupError("version deletion did not fully succeed; stopping cleanup")
        deleted += len(batch)
    return deleted


def run(*, account, apply=False):
    if not re.fullmatch(r"[0-9]{12}", account) or aws("sts", "get-caller-identity").get("Account") != account:
        raise CleanupError("wrong AWS account")
    stack = aws("cloudformation", "describe-stacks", "--stack-name", BOOTSTRAP)["Stacks"][0]
    if stack.get("StackStatus") != "UPDATE_COMPLETE" or not stack.get("EnableTerminationProtection"):
        raise CleanupError("bootstrap stack is not stable and protected")
    outputs = {p["OutputKey"]: p["OutputValue"] for p in stack["Outputs"]}
    bucket = outputs["ReleaseArtifactBucketName"]
    if not re.fullmatch(r"ian-photography-ci-bootstrap-releaseartifactbucket-[a-z0-9]+", bucket):
        raise CleanupError("unexpected release bucket")
    parameters = {p["ParameterKey"]: p["ParameterValue"] for p in stack["Parameters"]}
    days = int(parameters["ReleaseArtifactNoncurrentRetentionDays"])
    if aws("s3api", "get-bucket-versioning", "--bucket", bucket, "--expected-bucket-owner", account).get("Status") != "Enabled":
        raise CleanupError("release versioning is disabled")
    good = successful_releases(github_releases())
    snapshot, current = stack_snapshot(bucket)
    versions, markers = inventory(bucket, account)
    planned, report = plan_cleanup(versions, markers, current | good, dt.datetime.now(dt.timezone.utc), days)
    report.update({"retentionDays": days, "protectedReleases": len(current | good), "mode": "apply" if apply else "dry-run"})
    report["deletedVersions"] = apply_plan(bucket, account, planned, snapshot) if apply else 0
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-account-id", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(run(account=args.expected_account_id, apply=args.apply), sort_keys=True))
        return 0
    except (CleanupError, KeyError, TypeError, ValueError) as error:
        reason = str(error) if isinstance(error, CleanupError) else type(error).__name__
        print(f"release cleanup stopped: {reason}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
