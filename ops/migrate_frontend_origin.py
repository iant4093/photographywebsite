#!/usr/bin/env python3
"""Guarded S3-website to private S3 REST/OAC migration; dry-run by default."""

from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from typing import Any
import urllib.request

from aws_stack import aws_json, discover_distribution_by_alias


OAC_NAME_SUFFIX = "frontend-private-origin-v1"
OAC_POLICY_SID = "AllowFrontendCloudFrontOacRead"
TLS_POLICY_SID = "DenyInsecureTransport"


def aws_json_file(
    arguments: list[str], payload: dict[str, Any], profile: str | None, region: str
) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json") as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.flush()
        replaced = [value.replace("{file}", handle.name) for value in arguments]
        return aws_json(replaced, profile, region)


def optional_aws_json(
    arguments: list[str], profile: str | None, region: str, missing_codes: tuple[str, ...]
) -> dict[str, Any] | None:
    try:
        return aws_json(arguments, profile, region)
    except subprocess.CalledProcessError as error:
        if any(code in (error.stderr or "") for code in missing_codes):
            return None
        raise


def origin_bucket(domain: str) -> str | None:
    markers = (".s3-website", ".s3.", ".s3-")
    for marker in markers:
        if marker in domain:
            candidate = domain.split(marker, 1)[0]
            return candidate or None
    if domain.endswith(".s3.amazonaws.com"):
        return domain.removesuffix(".s3.amazonaws.com") or None
    return None


def public_get_statement(statement: dict[str, Any], bucket_arn: str) -> bool:
    principal = statement.get("Principal")
    public_principal = principal == "*" or (
        isinstance(principal, dict) and principal.get("AWS") == "*"
    )
    if statement.get("Effect") != "Allow" or not public_principal:
        return False
    actions = statement.get("Action", [])
    if isinstance(actions, str):
        actions = [actions]
    resources = statement.get("Resource", [])
    if isinstance(resources, str):
        resources = [resources]
    return "s3:GetObject" in actions and any(
        resource == f"{bucket_arn}/*" or resource.startswith(f"{bucket_arn}/")
        for resource in resources
        if isinstance(resource, str)
    )


def desired_bucket_policy(
    current: dict[str, Any], *, bucket: str, distribution_id: str, partition: str
) -> dict[str, Any]:
    bucket_arn = f"arn:{partition}:s3:::{bucket}"
    statements = [
        item
        for item in current.get("Statement", [])
        if item.get("Sid") not in {OAC_POLICY_SID, TLS_POLICY_SID}
    ]
    statements.extend(
        [
            {
                "Sid": TLS_POLICY_SID,
                "Effect": "Deny",
                "Principal": "*",
                "Action": "s3:*",
                "Resource": [bucket_arn, f"{bucket_arn}/*"],
                "Condition": {"Bool": {"aws:SecureTransport": "false"}},
            },
            {
                "Sid": OAC_POLICY_SID,
                "Effect": "Allow",
                "Principal": {"Service": "cloudfront.amazonaws.com"},
                "Action": "s3:GetObject",
                "Resource": f"{bucket_arn}/*",
                "Condition": {
                    "StringEquals": {
                        "AWS:SourceArn": (
                            f"arn:{partition}:cloudfront::${{ACCOUNT}}:distribution/{distribution_id}"
                        )
                    }
                },
            },
        ]
    )
    return {"Version": "2012-10-17", "Statement": statements}


def replace_account_token(policy: dict[str, Any], account: str) -> dict[str, Any]:
    return json.loads(json.dumps(policy).replace("${ACCOUNT}", account))


def list_oacs(profile: str | None, region: str) -> list[dict[str, Any]]:
    response = aws_json(["cloudfront", "list-origin-access-controls"], profile, region)
    return response.get("OriginAccessControlList", {}).get("Items", []) or []


def ensure_oac(
    name: str, *, apply: bool, profile: str | None, region: str
) -> tuple[str | None, str]:
    matches = [item for item in list_oacs(profile, region) if item.get("Name") == name]
    if len(matches) > 1:
        raise RuntimeError("Multiple origin access controls have the managed name")
    if matches:
        item = matches[0]
        if item.get("OriginAccessControlOriginType") != "s3" or item.get("SigningBehavior") != "always":
            raise RuntimeError("Managed-name OAC exists with incompatible settings")
        return item["Id"], "reuse"
    if not apply:
        return None, "create"
    config = {
        "Name": name,
        "Description": "Managed by ops/migrate_frontend_origin.py",
        "SigningProtocol": "sigv4",
        "SigningBehavior": "always",
        "OriginAccessControlOriginType": "s3",
    }
    result = aws_json_file(
        [
            "cloudfront",
            "create-origin-access-control",
            "--origin-access-control-config",
            "file://{file}",
        ],
        config,
        profile,
        region,
    )
    return result["OriginAccessControl"]["Id"], "created"


def write_snapshot(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def wait_deployed(distribution_id: str, profile: str | None, region: str, timeout: int) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = aws_json(
            ["cloudfront", "get-distribution", "--id", distribution_id], profile, region
        )["Distribution"]["Status"]
        if status == "Deployed":
            return
        time.sleep(15)
    raise TimeoutError("CloudFront did not reach Deployed before the timeout")


def smoke_check(domain: str) -> None:
    for path in ("/", "/__private_origin_migration_smoke__"):
        request = urllib.request.Request(
            f"https://{domain}{path}", headers={"User-Agent": "infrastructure-migration-check/1.0"}
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise RuntimeError(f"Frontend smoke check returned {response.status}")
            response.read(1024)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", default="iantruongphotography.com")
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--expected-etag")
    parser.add_argument("--expected-bucket")
    parser.add_argument("--expected-public-allow-count", type=int)
    parser.add_argument("--confirm-domain")
    parser.add_argument("--rollback-file", type=Path)
    parser.add_argument("--wait-timeout-seconds", type=int, default=1800)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    domain = args.domain.rstrip(".")
    account_response = aws_json(["sts", "get-caller-identity"], args.profile, args.region)
    account = account_response["Account"]
    partition = account_response["Arn"].split(":", 2)[1]
    distribution_id = discover_distribution_by_alias(domain, args.profile, args.region)["Id"]
    current = aws_json(
        ["cloudfront", "get-distribution-config", "--id", distribution_id],
        args.profile,
        args.region,
    )
    etag = current["ETag"]
    config = current["DistributionConfig"]
    origins = config.get("Origins", {}).get("Items", []) or []
    candidates = [
        (origin, origin_bucket(origin.get("DomainName", "")))
        for origin in origins
        if origin_bucket(origin.get("DomainName", ""))
    ]
    if len(candidates) != 1:
        raise SystemExit("Expected exactly one discoverable S3 frontend origin")
    origin, bucket = candidates[0]
    assert bucket
    location = aws_json(
        ["s3api", "get-bucket-location", "--bucket", bucket], args.profile, args.region
    ).get("LocationConstraint") or "us-east-1"
    if location != args.region:
        raise SystemExit("Bucket location does not match --region")

    current_policy_response = optional_aws_json(
        ["s3api", "get-bucket-policy", "--bucket", bucket],
        args.profile,
        args.region,
        ("NoSuchBucketPolicy", "NoSuchBucket"),
    )
    current_policy = json.loads(current_policy_response["Policy"]) if current_policy_response else {
        "Version": "2012-10-17",
        "Statement": [],
    }
    public_access = optional_aws_json(
        ["s3api", "get-public-access-block", "--bucket", bucket],
        args.profile,
        args.region,
        ("NoSuchPublicAccessBlockConfiguration",),
    ) or {"PublicAccessBlockConfiguration": {}}
    bucket_arn = f"arn:{partition}:s3:::{bucket}"
    public_allows = [
        statement
        for statement in current_policy.get("Statement", [])
        if public_get_statement(statement, bucket_arn)
    ]
    oac_name = f"{domain.replace('.', '-')}-{OAC_NAME_SUFFIX}"
    oac_id, oac_action = ensure_oac(
        oac_name, apply=False, profile=args.profile, region=args.region
    )

    print(
        json.dumps(
            {
                "mode": "apply" if args.apply else "dry-run",
                "account": account,
                "domain": domain,
                "distributionId": distribution_id,
                "currentETag": etag,
                "bucket": bucket,
                "currentOrigin": origin.get("DomainName"),
                "targetOrigin": f"{bucket}.s3.{args.region}.amazonaws.com",
                "originAccessControl": {"name": oac_name, "action": oac_action},
                "publicGetAllowStatementCount": len(public_allows),
                "publicAccessBlock": public_access["PublicAccessBlockConfiguration"],
                "customErrorFallbacks": [403, 404],
                "applyStages": [
                    "write rollback snapshot",
                    "create/reuse OAC and add scoped read policy",
                    "switch to S3 REST origin and wait for Deployed",
                    "smoke-check root and SPA fallback",
                    "remove public GetObject statements and enable all public-access blocks",
                ],
            },
            indent=2,
        )
    )
    if not args.apply:
        print("Dry run only. No CloudFront, S3 policy, or public-access setting was changed.")
        return 0
    if args.expected_account_id != account:
        raise SystemExit("Refusing apply: --expected-account-id does not match")
    if args.expected_etag != etag:
        raise SystemExit("Refusing apply: --expected-etag does not match current distribution")
    if args.expected_bucket != bucket:
        raise SystemExit("Refusing apply: --expected-bucket does not match discovered origin")
    if args.expected_public_allow_count != len(public_allows):
        raise SystemExit("Refusing apply: public allow count changed")
    if args.confirm_domain != domain:
        raise SystemExit("Refusing apply: --confirm-domain must exactly match")
    if not args.rollback_file:
        raise SystemExit("Refusing apply: --rollback-file outside the repository is required")
    if args.wait_timeout_seconds < 60 or args.wait_timeout_seconds > 3600:
        raise SystemExit("--wait-timeout-seconds must be between 60 and 3600")

    write_snapshot(
        args.rollback_file,
        {
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "account": account,
            "domain": domain,
            "distributionId": distribution_id,
            "distributionETag": etag,
            "distributionConfig": config,
            "bucket": bucket,
            "bucketPolicy": current_policy,
            "publicAccessBlock": public_access["PublicAccessBlockConfiguration"],
        },
    )
    oac_id, _ = ensure_oac(oac_name, apply=True, profile=args.profile, region=args.region)
    assert oac_id
    transition_policy = replace_account_token(
        desired_bucket_policy(
            current_policy, bucket=bucket, distribution_id=distribution_id, partition=partition
        ),
        account,
    )
    aws_json_file(
        ["s3api", "put-bucket-policy", "--bucket", bucket, "--policy", "file://{file}"],
        transition_policy,
        args.profile,
        args.region,
    )

    desired = copy.deepcopy(config)
    desired_origin = next(item for item in desired["Origins"]["Items"] if item["Id"] == origin["Id"])
    desired_origin["DomainName"] = f"{bucket}.s3.{args.region}.amazonaws.com"
    desired_origin.pop("CustomOriginConfig", None)
    desired_origin["S3OriginConfig"] = {"OriginAccessIdentity": ""}
    desired_origin["OriginAccessControlId"] = oac_id
    desired["CustomErrorResponses"] = {
        "Quantity": 2,
        "Items": [
            {
                "ErrorCode": code,
                "ResponsePagePath": "/index.html",
                "ResponseCode": "200",
                "ErrorCachingMinTTL": 0,
            }
            for code in (403, 404)
        ],
    }
    aws_json_file(
        [
            "cloudfront",
            "update-distribution",
            "--id",
            distribution_id,
            "--if-match",
            etag,
            "--distribution-config",
            "file://{file}",
        ],
        desired,
        args.profile,
        args.region,
    )
    wait_deployed(distribution_id, args.profile, args.region, args.wait_timeout_seconds)
    smoke_check(domain)

    private_policy = copy.deepcopy(transition_policy)
    private_policy["Statement"] = [
        statement
        for statement in private_policy["Statement"]
        if not public_get_statement(statement, bucket_arn)
    ]
    aws_json_file(
        ["s3api", "put-bucket-policy", "--bucket", bucket, "--policy", "file://{file}"],
        private_policy,
        args.profile,
        args.region,
    )
    aws_json_file(
        [
            "s3api",
            "put-public-access-block",
            "--bucket",
            bucket,
            "--public-access-block-configuration",
            "file://{file}",
        ],
        {
            "BlockPublicAcls": True,
            "IgnorePublicAcls": True,
            "BlockPublicPolicy": True,
            "RestrictPublicBuckets": True,
        },
        args.profile,
        args.region,
    )
    print("Private frontend origin migration completed; retain the rollback snapshot securely.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
