#!/usr/bin/env python3
"""Inventory or explicitly disable Inspector Lambda and Lambda code scanning.

Dry-run is the default. Apply is permitted only when both paid Lambda protection
types are currently ENABLED and every stale-state/account/region guard matches.
The script never changes EC2, ECR, or repository scanning.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from typing import Any

from aws_stack import aws_json


ACCOUNT_PATTERN = re.compile(r"^[0-9]{12}$")
REGION_PATTERN = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$")
CONFIRMATION = "disable-inspector-lambda-scanning"
MIN_WAIT_TIMEOUT_SECONDS = 30
MAX_WAIT_TIMEOUT_SECONDS = 900
MIN_POLL_INTERVAL_SECONDS = 1
MAX_POLL_INTERVAL_SECONDS = 30


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
    if expected_lambda_state != current_lambda_state or expected_lambda_state != "ENABLED":
        raise SystemExit(
            "--expected-lambda-state must match the current state and both must be ENABLED"
        )
    if (
        expected_lambda_code_state != current_lambda_code_state
        or expected_lambda_code_state != "ENABLED"
    ):
        raise SystemExit(
            "--expected-lambda-code-state must match the current state and both must be ENABLED"
        )
    if confirmation != CONFIRMATION:
        raise SystemExit(f"--confirm must be exactly {CONFIRMATION}")


def wait_until_lambda_scanning_disabled(
    *,
    account_id: str,
    profile: str | None,
    region: str,
    timeout_seconds: int,
    poll_interval_seconds: int,
) -> tuple[str, str]:
    """Wait for only the requested Inspector Lambda modes to become disabled."""
    deadline = time.monotonic() + timeout_seconds
    accepted_states = {"ENABLED", "DISABLING", "DISABLED"}
    while True:
        account = get_account_status(account_id, profile, region)
        lambda_state = resource_status(account, "lambda")
        lambda_code_state = resource_status(account, "lambdaCode")
        if lambda_state == lambda_code_state == "DISABLED":
            return lambda_state, lambda_code_state
        if lambda_state not in accepted_states or lambda_code_state not in accepted_states:
            raise RuntimeError(
                "Inspector entered an unexpected state before both requested "
                "Lambda scanning modes were disabled"
            )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                "Inspector did not disable both requested Lambda scanning modes "
                "before the bounded wait expired"
            )
        time.sleep(min(poll_interval_seconds, remaining))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--expected-region")
    parser.add_argument("--expected-lambda-state", choices=["ENABLED"])
    parser.add_argument("--expected-lambda-code-state", choices=["ENABLED"])
    parser.add_argument("--confirm")
    parser.add_argument("--wait-timeout-seconds", type=int, default=300)
    parser.add_argument("--poll-interval-seconds", type=int, default=5)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not REGION_PATTERN.fullmatch(args.region):
        raise SystemExit("--region is not a valid AWS region name")
    if not MIN_WAIT_TIMEOUT_SECONDS <= args.wait_timeout_seconds <= MAX_WAIT_TIMEOUT_SECONDS:
        raise SystemExit(
            f"--wait-timeout-seconds must be between {MIN_WAIT_TIMEOUT_SECONDS} "
            f"and {MAX_WAIT_TIMEOUT_SECONDS}"
        )
    if not MIN_POLL_INTERVAL_SECONDS <= args.poll_interval_seconds <= MAX_POLL_INTERVAL_SECONDS:
        raise SystemExit(
            f"--poll-interval-seconds must be between {MIN_POLL_INTERVAL_SECONDS} "
            f"and {MAX_POLL_INTERVAL_SECONDS}"
        )
    if args.poll_interval_seconds >= args.wait_timeout_seconds:
        raise SystemExit("--poll-interval-seconds must be less than --wait-timeout-seconds")
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
        "readyForGuardedApply": lambda_state == lambda_code_state == "ENABLED",
        "monthlyCostReductionRequested": True,
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
            "disable",
            "--account-ids",
            account_id,
            "--resource-types",
            "LAMBDA",
            "LAMBDA_CODE",
        ],
        args.profile,
        args.region,
    )
    after_lambda, after_lambda_code = wait_until_lambda_scanning_disabled(
        account_id=account_id,
        profile=args.profile,
        region=args.region,
        timeout_seconds=args.wait_timeout_seconds,
        poll_interval_seconds=args.poll_interval_seconds,
    )
    print(
        json.dumps(
            {
                "result": "disabled",
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
