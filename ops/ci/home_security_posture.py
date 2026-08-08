#!/usr/bin/env python3
"""Audit the exact home-Region GuardDuty and Security Hub posture.

The report deliberately contains aggregate counts only. Detector identifiers,
resource ARNs, account identity, tags, Region names, and provider responses
never leave the process.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from typing import Any, Callable


REGION_PATTERN = re.compile(r"^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]$")
HUB_ARN_PATTERN = re.compile(
    r"^arn:[^:]+:securityhub:([^:]+):[0-9]{12}:hub/default$"
)
EXPECTED_TAGS = {
    "Application": "IanTruongPhotography",
    "Stage": "prod",
}
EXPECTED_PUBLISHING_FREQUENCY = "FIFTEEN_MINUTES"
EXPECTED_GUARDDUTY_FEATURES = {
    "S3_DATA_EVENTS": "ENABLED",
    "EKS_AUDIT_LOGS": "DISABLED",
    "EBS_MALWARE_PROTECTION": "DISABLED",
    "RDS_LOGIN_EVENTS": "DISABLED",
    "LAMBDA_NETWORK_LOGS": "ENABLED",
    "RUNTIME_MONITORING": "DISABLED",
    "CLOUD_TRAIL": "ENABLED",
    "DNS_LOGS": "ENABLED",
    "FLOW_LOGS": "ENABLED",
    "AI_ANALYST": "DISABLED",
    "AI_PROTECTION": "DISABLED",
    "EKS_RUNTIME_MONITORING": "DISABLED",
}
EXPECTED_SECURITY_HUB_STANDARDS = frozenset()

AwsCaller = Callable[[list[str], str | None, str], dict[str, Any]]


class PostureError(RuntimeError):
    """Raised when the exact home-Region posture cannot be proven."""


def aws_call(arguments: list[str], profile: str | None, region: str) -> dict[str, Any]:
    command = ["aws", *arguments, "--region", region, "--output", "json"]
    if profile:
        command.extend(["--profile", profile])
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PostureError("home security inventory could not be queried") from error
    if completed.returncode != 0:
        raise PostureError("home security inventory could not be queried")
    try:
        response = json.loads(completed.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        raise PostureError("home security inventory was malformed") from error
    if not isinstance(response, dict):
        raise PostureError("home security inventory was malformed")
    return response


def _call(
    caller: AwsCaller, arguments: list[str], profile: str | None, region: str
) -> dict[str, Any]:
    try:
        response = caller(arguments, profile, region)
    except Exception as error:
        if isinstance(error, PostureError):
            raise
        raise PostureError("home security inventory could not be queried") from error
    if not isinstance(response, dict):
        raise PostureError("home security inventory was malformed")
    return response


def _has_required_tags(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    return all(value.get(key) == expected for key, expected in EXPECTED_TAGS.items())


def _detector_posture(
    *, caller: AwsCaller, profile: str | None, region: str
) -> None:
    inventory = _call(caller, ["guardduty", "list-detectors"], profile, region)
    detector_ids = inventory.get("DetectorIds")
    if (
        not isinstance(detector_ids, list)
        or len(detector_ids) != 1
        or not isinstance(detector_ids[0], str)
        or not detector_ids[0]
    ):
        raise PostureError("GuardDuty singleton inventory differs from the contract")
    detail = _call(
        caller,
        ["guardduty", "get-detector", "--detector-id", detector_ids[0]],
        profile,
        region,
    )
    features = detail.get("Features")
    if not isinstance(features, list):
        raise PostureError("GuardDuty feature inventory was malformed")
    states: dict[str, str] = {}
    for feature in features:
        if not isinstance(feature, dict):
            raise PostureError("GuardDuty feature inventory was malformed")
        name = feature.get("Name")
        status = feature.get("Status")
        if (
            not isinstance(name, str)
            or not name
            or status not in {"ENABLED", "DISABLED"}
            or name in states
        ):
            raise PostureError("GuardDuty feature inventory was malformed")
        states[name] = status
    if (
        detail.get("Status") != "ENABLED"
        or detail.get("FindingPublishingFrequency")
        != EXPECTED_PUBLISHING_FREQUENCY
        or not _has_required_tags(detail.get("Tags"))
        or states != EXPECTED_GUARDDUTY_FEATURES
    ):
        raise PostureError("GuardDuty posture differs from the contract")


def _standard_key(arn: Any, *, region: str) -> str:
    if not isinstance(arn, str):
        raise PostureError("Security Hub standards inventory was malformed")
    regional = re.fullmatch(
        rf"arn:[^:]+:securityhub:{re.escape(region)}::standards/(.+)", arn
    )
    if regional is not None:
        return regional.group(1)
    global_ruleset = re.fullmatch(
        r"arn:[^:]+:securityhub:::ruleset/(.+)", arn
    )
    if global_ruleset is not None:
        return global_ruleset.group(1)
    raise PostureError("Security Hub standards inventory was malformed")


def _hub_posture(
    *, caller: AwsCaller, profile: str | None, region: str
) -> int:
    detail = _call(caller, ["securityhub", "describe-hub"], profile, region)
    hub_arn = detail.get("HubArn")
    match = HUB_ARN_PATTERN.fullmatch(hub_arn) if isinstance(hub_arn, str) else None
    if (
        match is None
        or match.group(1) != region
        or detail.get("ControlFindingGenerator") != "SECURITY_CONTROL"
    ):
        raise PostureError("Security Hub posture differs from the contract")
    tag_response = _call(
        caller,
        ["securityhub", "list-tags-for-resource", "--resource-arn", hub_arn],
        profile,
        region,
    )
    if not _has_required_tags(tag_response.get("Tags")):
        raise PostureError("Security Hub tags differ from the contract")
    standards_response = _call(
        caller, ["securityhub", "get-enabled-standards"], profile, region
    )
    subscriptions = standards_response.get("StandardsSubscriptions")
    if not isinstance(subscriptions, list):
        raise PostureError("Security Hub standards inventory was malformed")
    states: dict[str, str] = {}
    provider_transition_count = 0
    for subscription in subscriptions:
        if not isinstance(subscription, dict):
            raise PostureError("Security Hub standards inventory was malformed")
        key = _standard_key(subscription.get("StandardsArn"), region=region)
        status = subscription.get("StandardsStatus")
        # Security Hub also reports PENDING while it adds controls to an
        # already enabled standard. Treat that provider transition as healthy
        # only when the existing controls remain fully updatable and AWS has
        # supplied no status reason.
        if (
            status not in {"READY", "PENDING"}
            or subscription.get("StandardsControlsUpdatable")
            != "READY_FOR_UPDATES"
            or "StandardsStatusReason" in subscription
            or key in states
        ):
            raise PostureError("Security Hub standards differ from the contract")
        states[key] = status
        provider_transition_count += int(status == "PENDING")
    if frozenset(states) != EXPECTED_SECURITY_HUB_STANDARDS:
        raise PostureError("Security Hub standards differ from the contract")
    return provider_transition_count


def audit(
    *,
    region: str,
    profile: str | None = None,
    caller: AwsCaller = aws_call,
) -> dict[str, int | str]:
    if not REGION_PATTERN.fullmatch(region):
        raise PostureError("home security Region is invalid")
    _detector_posture(caller=caller, profile=profile, region=region)
    provider_transition_count = _hub_posture(
        caller=caller, profile=profile, region=region
    )
    return {
        "detectorCount": 1,
        "providerTransitionCount": provider_transition_count,
        "securityHubCount": 1,
        "standardCount": len(EXPECTED_SECURITY_HUB_STANDARDS),
        "status": "IN_SYNC",
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit aggregate home-Region GuardDuty and Security Hub posture."
    )
    parser.add_argument("--region", required=True)
    parser.add_argument("--profile")
    arguments = parser.parse_args()
    try:
        report = audit(region=arguments.region, profile=arguments.profile)
    except PostureError:
        print("Home security posture could not be verified.", file=sys.stderr)
        return 2
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
