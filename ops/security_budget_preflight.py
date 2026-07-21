#!/usr/bin/env python3
"""Read-only, aggregate-only preflight for the guarded AWS Budget stack."""

from __future__ import annotations

import argparse
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re
import subprocess
from typing import Any, Callable


ACCOUNT_PATTERN = re.compile(r"^[0-9]{12}$")
STAGE_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$")
SNS_PATTERN = re.compile(
    r"^arn:(?:aws|aws-us-gov):sns:(?P<region>[a-z0-9-]+):"
    r"(?P<account>[0-9]{12}):(?P<name>[A-Za-z0-9_-]{1,256})$"
)
# HTTPS confirmation proves only a machine endpoint, not a human responder.
HUMAN_DESTINATION_PROTOCOLS = frozenset({"email", "email-json", "sms"})


class AwsReadError(RuntimeError):
    pass


def aws_json(arguments: list[str], profile: str | None, region: str) -> dict[str, Any]:
    command = ["aws"]
    if profile:
        command.extend(["--profile", profile])
    command.extend(["--region", region, *arguments, "--output", "json"])
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        # Provider errors can echo ARNs, account metadata, or request fields.
        # Preserve only the fixed operation class in shared output.
        raise AwsReadError(f"{arguments[0]} {arguments[1]} read failed")
    try:
        value = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as error:
        raise AwsReadError("AWS CLI returned invalid JSON") from error
    if not isinstance(value, dict):
        raise AwsReadError("AWS CLI returned a non-object response")
    return value


def approved_limit(value: str) -> str:
    try:
        amount = Decimal(value)
    except InvalidOperation as error:
        raise SystemExit("--monthly-limit-usd must be a decimal number") from error
    if not amount.is_finite() or amount <= 0 or amount > Decimal("100000"):
        raise SystemExit("--monthly-limit-usd must be greater than zero and at most 100000")
    if amount.as_tuple().exponent < -2:
        raise SystemExit("--monthly-limit-usd accepts at most two decimal places")
    return format(amount, "f")


def inventory(
    *,
    stage: str,
    region: str,
    expected_account_id: str,
    topic_arn: str,
    monthly_limit_usd: str,
    confirmation: str | None,
    profile: str | None,
    caller: Callable[[list[str], str | None, str], dict[str, Any]] = aws_json,
) -> tuple[dict[str, Any], bool]:
    if not STAGE_PATTERN.fullmatch(stage):
        raise SystemExit("Invalid stage")
    if region != "us-west-2":
        raise SystemExit("Budget orchestration is restricted to us-west-2")
    if not ACCOUNT_PATTERN.fullmatch(expected_account_id):
        raise SystemExit("Invalid expected account ID")
    limit = approved_limit(monthly_limit_usd)
    match = SNS_PATTERN.fullmatch(topic_arn)
    if not match:
        raise SystemExit("Invalid SNS topic ARN")

    identity = caller(["sts", "get-caller-identity"], profile, region)
    account = identity.get("Account")
    if account != expected_account_id:
        raise SystemExit("Refusing: caller account does not match --expected-account-id")
    if match.group("account") != account or match.group("region") != region:
        raise SystemExit("Refusing: notification topic is not in the exact account and Region")
    expected_topic_name = f"ian-photography-security-{stage}"
    if match.group("name") != expected_topic_name:
        raise SystemExit("Refusing: notification topic name does not match the stage")

    topics = caller(["sns", "list-topics"], profile, region).get("Topics", [])
    topic_exists = sum(item.get("TopicArn") == topic_arn for item in topics) == 1
    subscriptions: list[dict[str, Any]] = []
    if topic_exists:
        subscriptions = caller(
            ["sns", "list-subscriptions-by-topic", "--topic-arn", topic_arn],
            profile,
            region,
        ).get("Subscriptions", [])
    confirmed_subscriptions = [
        item
        for item in subscriptions
        if isinstance(item, dict)
        and item.get("SubscriptionArn") not in (None, "", "PendingConfirmation")
    ]
    # SQS, Lambda, and Firehose subscriptions can be valuable fan-out routes,
    # but their confirmation does not prove a person can receive an alert.
    # Count unique human-compatible destinations without ever serializing an
    # endpoint or a subscription identifier into the report.
    confirmed_human_destinations = {
        (item.get("Protocol"), item.get("Endpoint"))
        for item in confirmed_subscriptions
        if item.get("Protocol") in HUMAN_DESTINATION_PROTOCOLS
        and isinstance(item.get("Endpoint"), str)
        and item["Endpoint"]
    }

    budgets = caller(
        ["budgets", "describe-budgets", "--account-id", account], profile, region
    ).get("Budgets", [])
    budget_name = f"ian-photography-monthly-{stage}"
    target_budget_count = sum(item.get("BudgetName") == budget_name for item in budgets)
    confirmed_name = confirmation == budget_name
    ready = (
        topic_exists
        and len(confirmed_human_destinations) >= 1
        and target_budget_count == 0
        and confirmed_name
    )
    normalized = {
        "budgetCount": len(budgets),
        "confirmedSubscriptions": len(confirmed_subscriptions),
        "confirmedHumanDestinations": len(confirmed_human_destinations),
        "limit": limit,
        "targetBudgetCount": target_budget_count,
        "topicExists": topic_exists,
    }
    digest = hashlib.sha256(
        json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    report = {
        "mode": "read-only",
        "callerAccountMatches": True,
        "region": region,
        "budgetNameConfirmed": confirmed_name,
        "targetBudgetCount": target_budget_count,
        "topicExists": topic_exists,
        "confirmedSubscriptionCount": len(confirmed_subscriptions),
        "confirmedHumanDestinationCount": len(confirmed_human_destinations),
        "requiredConfirmedHumanDestinationCount": 1,
        "inventoryDigest": digest,
        "recommendedParameters": {
            "BudgetDeploymentMode": "create-confirmed-absent" if ready else "skip",
            "MonthlyLimitUsd": limit,
        },
        "blockers": [
            reason
            for blocked, reason in (
                (not topic_exists, "exact-notification-topic-not-found"),
                (
                    len(confirmed_human_destinations) < 1,
                    "one-confirmed-human-destination-required",
                ),
                (target_budget_count > 0, "target-budget-already-exists-review-ownership"),
                (not confirmed_name, "exact-budget-name-confirmation-required"),
            )
            if blocked
        ],
    }
    return report, not ready


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", default="prod")
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--expected-account-id", required=True)
    parser.add_argument("--security-notification-topic-arn", required=True)
    parser.add_argument("--monthly-limit-usd", required=True)
    parser.add_argument("--confirm-budget-name")
    args = parser.parse_args()
    try:
        report, blocked = inventory(
            stage=args.stage,
            region=args.region,
            expected_account_id=args.expected_account_id,
            topic_arn=args.security_notification_topic_arn,
            monthly_limit_usd=args.monthly_limit_usd,
            confirmation=args.confirm_budget_name,
            profile=args.profile,
        )
    except AwsReadError:
        report = {
            "mode": "read-only",
            "status": "blocked-inventory-incomplete",
            "blockers": ["aws-read-failed"],
            "recommendedParameters": {"BudgetDeploymentMode": "skip"},
        }
        blocked = True
    print(json.dumps(report, indent=2, sort_keys=True))
    return 2 if blocked else 0


if __name__ == "__main__":
    raise SystemExit(main())
