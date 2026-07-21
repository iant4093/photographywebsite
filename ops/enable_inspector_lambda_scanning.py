#!/usr/bin/env python3
"""Inventory or explicitly enable Inspector Lambda and Lambda code scanning.

Dry-run is the default. Apply is permitted only when both protection types are
currently DISABLED and every stale-state/account/region guard matches. The
script never enables EC2 or ECR scanning and has no disable operation.
"""

from __future__ import annotations

import argparse
import json
import re
from typing import Any

from aws_stack import aws_json


ACCOUNT_PATTERN = re.compile(r"^[0-9]{12}$")
REGION_PATTERN = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$")
CONFIRMATION = "enable-inspector-lambda-code-scanning"


def get_account_status(
    account_id: str, profile: str | None, region: str
) -> dict[str, Any]:
    response = aws_json(
        ["inspector2", "batch-get-account-status", "--account-ids", account_id],
        profile,
        region,
    )
    failed = response.get("failedAccounts", []) or []
    accounts = response.get("accounts", []) or []
    if failed:
        raise RuntimeError("Inspector returned a failed account status lookup")
    matching = [item for item in accounts if item.get("accountId") == account_id]
    if len(matching) != 1:
        raise RuntimeError("Inspector did not return exactly one matching account status")
    return matching[0]


def resource_status(account: dict[str, Any], key: str) -> str:
    value = account.get("resourceState", {}).get(key, {}).get("status")
    if not isinstance(value, str) or not value:
        return "UNKNOWN"
    return value.upper()


def validate_apply_guards(
    *,
    apply: bool,
    account_id: str,
    region: str,
    expected_account_id: str | None,
    expected_region: str | None,
    current_lambda_state: str,
    current_lambda_code_state: str,
    expected_lambda_state: str | None,
    expected_lambda_code_state: str | None,
    confirmation: str | None,
) -> None:
    if not apply:
        return
    if expected_account_id != account_id:
        raise SystemExit("--expected-account-id must exactly match the active AWS account")
    if expected_region != region:
        raise SystemExit("--expected-region must exactly match --region")
    if expected_lambda_state != current_lambda_state or expected_lambda_state != "DISABLED":
        raise SystemExit(
            "--expected-lambda-state must match the current state and both must be DISABLED"
        )
    if (
        expected_lambda_code_state != current_lambda_code_state
        or expected_lambda_code_state != "DISABLED"
    ):
        raise SystemExit(
            "--expected-lambda-code-state must match the current state and both must be DISABLED"
        )
    if confirmation != CONFIRMATION:
        raise SystemExit(f"--confirm must be exactly {CONFIRMATION}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--expected-region")
    parser.add_argument("--expected-lambda-state", choices=["DISABLED"])
    parser.add_argument("--expected-lambda-code-state", choices=["DISABLED"])
    parser.add_argument("--confirm")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not REGION_PATTERN.fullmatch(args.region):
        raise SystemExit("--region is not a valid AWS region name")
    identity = aws_json(["sts", "get-caller-identity"], args.profile, args.region)
    account_id = identity.get("Account")
    if not isinstance(account_id, str) or not ACCOUNT_PATTERN.fullmatch(account_id):
        raise RuntimeError("STS did not return a valid 12-digit account ID")

    before = get_account_status(account_id, args.profile, args.region)
    lambda_state = resource_status(before, "lambda")
    lambda_code_state = resource_status(before, "lambdaCode")
    report = {
        "mode": "apply" if args.apply else "dry-run",
        "accountId": "verified",
        "region": args.region,
        "current": {
            "lambdaScanning": lambda_state,
            "lambdaCodeScanning": lambda_code_state,
        },
        "unchangedResourceTypes": ["EC2", "ECR"],
        "readyForGuardedApply": lambda_state == lambda_code_state == "DISABLED",
        "paidServiceApprovalRequired": True,
    }
    print(json.dumps(report, indent=2, sort_keys=True))

    validate_apply_guards(
        apply=args.apply,
        account_id=account_id,
        region=args.region,
        expected_account_id=args.expected_account_id,
        expected_region=args.expected_region,
        current_lambda_state=lambda_state,
        current_lambda_code_state=lambda_code_state,
        expected_lambda_state=args.expected_lambda_state,
        expected_lambda_code_state=args.expected_lambda_code_state,
        confirmation=args.confirm,
    )
    if not args.apply:
        return 0

    aws_json(
        [
            "inspector2",
            "enable",
            "--account-ids",
            account_id,
            "--resource-types",
            "LAMBDA",
            "LAMBDA_CODE",
        ],
        args.profile,
        args.region,
    )
    after = get_account_status(account_id, args.profile, args.region)
    after_lambda = resource_status(after, "lambda")
    after_lambda_code = resource_status(after, "lambdaCode")
    accepted = {"ENABLED", "ENABLING"}
    if after_lambda not in accepted or after_lambda_code not in accepted:
        raise RuntimeError("Inspector did not accept both requested Lambda scanning modes")
    print(
        json.dumps(
            {
                "result": "enable-request-accepted",
                "lambdaScanning": after_lambda,
                "lambdaCodeScanning": after_lambda_code,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
