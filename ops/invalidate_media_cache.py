#!/usr/bin/env python3
"""Guarded full media CloudFront invalidation; dry-run by default."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from typing import Any

from aws_stack import aws_json, stack_resource

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--confirm-distribution-id")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    account = aws_json(["sts", "get-caller-identity"], args.profile, args.region)["Account"]
    distribution_id = stack_resource(
        args.stack_name, "ImagesCloudFront", args.profile, args.region
    )
    distribution = aws_json(
        ["cloudfront", "get-distribution", "--id", distribution_id], args.profile, args.region
    )["Distribution"]
    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "account": account,
        "stack": args.stack_name,
        "distributionId": distribution_id,
        "distributionDomain": distribution["DomainName"],
        "paths": ["/*"],
        "note": "One wildcard invalidation path; CloudFront invalidation pricing may apply.",
    }, indent=2))
    if not args.apply:
        return 0
    if args.expected_account_id != account:
        raise SystemExit("Refusing apply: --expected-account-id does not match.")
    if args.confirm_distribution_id != distribution_id:
        raise SystemExit("Refusing apply: --confirm-distribution-id must exactly match.")
    reference = "private-media-boundary-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    result = aws_json(
        [
            "cloudfront",
            "create-invalidation",
            "--distribution-id",
            distribution_id,
            "--invalidation-batch",
            json.dumps({"Paths": {"Quantity": 1, "Items": ["/*"]}, "CallerReference": reference}),
        ],
        args.profile,
        args.region,
    )
    print(json.dumps({"invalidationId": result["Invalidation"]["Id"], "status": result["Invalidation"]["Status"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
