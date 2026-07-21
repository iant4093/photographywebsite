#!/usr/bin/env python3
"""Read-only ownership preflight for paid CloudFront monitoring subscriptions.

Create mode requires both distributions to have no monitoring subscription.
Update mode requires both enabled subscriptions to be owned by the exact
CloudFormation stack and logical resources in ``observability_template.yaml``.
The helper calls only STS, CloudFront GET, and CloudFormation describe APIs.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from typing import Any

from aws_stack import aws_json


ACCOUNT_PATTERN = re.compile(r"^[0-9]{12}$")
DISTRIBUTION_PATTERN = re.compile(r"^[A-Z0-9]{12,20}$")
STACK_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,127}$")
ABSENT_MARKERS = ("NoSuchMonitoringSubscription", "NoSuchResource")
LOGICAL_IDS = {
    "frontend": "FrontendMonitoringSubscription",
    "media": "MediaMonitoringSubscription",
}


def _aws_command(
    arguments: list[str], profile: str | None, region: str
) -> list[str]:
    command = ["aws"]
    if profile:
        command.extend(["--profile", profile])
    command.extend(["--region", region, *arguments, "--output", "json"])
    return command


def monitoring_subscription(
    distribution_id: str, profile: str | None, region: str
) -> dict[str, Any] | None:
    """Return a validated subscription, None for confirmed absence, or fail closed."""
    result = subprocess.run(
        _aws_command(
            [
                "cloudfront",
                "get-monitoring-subscription",
                "--distribution-id",
                distribution_id,
            ],
            profile,
            region,
        ),
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        error_text = f"{result.stderr or ''} {result.stdout or ''}"
        if any(marker in error_text for marker in ABSENT_MARKERS):
            return None
        raise RuntimeError("CloudFront monitoring-subscription inventory failed")
    try:
        response = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as error:
        raise RuntimeError("CloudFront returned invalid monitoring-subscription JSON") from error
    if not isinstance(response, dict):
        raise RuntimeError("CloudFront returned a malformed monitoring-subscription response")
    config = (
        response.get("MonitoringSubscription", {})
        .get("RealtimeMetricsSubscriptionConfig", {})
    )
    status = config.get("RealtimeMetricsSubscriptionStatus")
    if status not in {"Enabled", "Disabled"}:
        raise RuntimeError("CloudFront returned an unknown monitoring-subscription status")
    return response


def _validate_distribution(
    distribution_id: str, profile: str | None, region: str
) -> None:
    response = aws_json(
        ["cloudfront", "get-distribution", "--id", distribution_id], profile, region
    )
    actual_id = response.get("Distribution", {}).get("Id")
    if actual_id != distribution_id:
        raise RuntimeError("CloudFront did not return the exact requested distribution")


def _stack_owned_distribution(
    stack_name: str,
    logical_id: str,
    profile: str | None,
    region: str,
) -> str:
    response = aws_json(
        [
            "cloudformation",
            "describe-stack-resource",
            "--stack-name",
            stack_name,
            "--logical-resource-id",
            logical_id,
        ],
        profile,
        region,
    )
    detail = response.get("StackResourceDetail", {})
    physical_id = detail.get("PhysicalResourceId")
    resource_type = detail.get("ResourceType")
    if resource_type != "AWS::CloudFront::MonitoringSubscription":
        raise RuntimeError("CloudFormation returned an unexpected resource type")
    if not isinstance(physical_id, str) or not physical_id:
        raise RuntimeError("CloudFormation monitoring subscription has no physical ID")
    return physical_id


def validate_preflight(
    *,
    deployment_mode: str,
    frontend_distribution_id: str,
    media_distribution_id: str,
    expected_account_id: str,
    stack_name: str,
    region: str,
    profile: str | None,
) -> dict[str, Any]:
    if region != "us-west-2":
        raise SystemExit("Refusing preflight: region must be us-west-2.")
    if not ACCOUNT_PATTERN.fullmatch(expected_account_id):
        raise SystemExit("Refusing preflight: expected account ID must be exactly 12 digits.")
    if not STACK_PATTERN.fullmatch(stack_name):
        raise SystemExit("Refusing preflight: observability stack name is invalid.")
    distribution_ids = {
        "frontend": frontend_distribution_id,
        "media": media_distribution_id,
    }
    if any(not DISTRIBUTION_PATTERN.fullmatch(value) for value in distribution_ids.values()):
        raise SystemExit("Refusing preflight: distribution IDs must use the exact CloudFront ID format.")
    if frontend_distribution_id == media_distribution_id:
        raise SystemExit("Refusing preflight: frontend and media distribution IDs must differ.")
    if deployment_mode not in {"create", "update"}:
        raise SystemExit("Refusing preflight: deployment mode must be create or update.")

    identity = aws_json(["sts", "get-caller-identity"], profile, region)
    if identity.get("Account") != expected_account_id:
        raise SystemExit("Refusing preflight: active AWS account does not match --expected-account-id.")

    subscriptions: dict[str, dict[str, Any] | None] = {}
    for label, distribution_id in distribution_ids.items():
        _validate_distribution(distribution_id, profile, region)
        subscriptions[label] = monitoring_subscription(distribution_id, profile, region)

    existing = sorted(label for label, value in subscriptions.items() if value is not None)
    if deployment_mode == "create":
        if existing:
            raise SystemExit(
                "Refusing create: a paid monitoring subscription already exists; "
                "inventory its owner before importing or removing it."
            )
        ownership = "confirmed-absent"
    else:
        if existing != ["frontend", "media"]:
            raise SystemExit("Refusing update: both exact monitoring subscriptions must already exist.")
        for label, logical_id in LOGICAL_IDS.items():
            status = (
                subscriptions[label]["MonitoringSubscription"]
                ["RealtimeMetricsSubscriptionConfig"]
                ["RealtimeMetricsSubscriptionStatus"]
            )
            if status != "Enabled":
                raise SystemExit("Refusing update: an owned paid monitoring subscription is disabled.")
            owned_id = _stack_owned_distribution(stack_name, logical_id, profile, region)
            if owned_id != distribution_ids[label]:
                raise SystemExit(
                    "Refusing update: CloudFormation does not own the exact monitoring subscription."
                )
        ownership = "exact-stack-owned"

    return {
        "accountId": expected_account_id,
        "deploymentMode": deployment_mode,
        "distributionCount": 2,
        "existingSubscriptionCount": len(existing),
        "monitoringSubscriptionOwnership": ownership,
        "paidMetricsAcknowledgementRequired": True,
        "region": region,
        "stackName": stack_name,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deployment-mode", required=True, choices=("create", "update"))
    parser.add_argument("--frontend-distribution-id", required=True)
    parser.add_argument("--media-distribution-id", required=True)
    parser.add_argument("--expected-account-id", required=True)
    parser.add_argument("--stack-name", default="ian-photography-observability")
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    args = parser.parse_args()
    result = validate_preflight(
        deployment_mode=args.deployment_mode,
        frontend_distribution_id=args.frontend_distribution_id,
        media_distribution_id=args.media_distribution_id,
        expected_account_id=args.expected_account_id,
        stack_name=args.stack_name,
        region=args.region,
        profile=args.profile,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    print("Read-only preflight complete. No AWS resource was changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
