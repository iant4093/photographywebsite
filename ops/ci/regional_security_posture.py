#!/usr/bin/env python3
"""Audit exact GuardDuty and Security Hub posture in every enabled Region.

The report deliberately contains counts only. Detector IDs, hub and standards
ARNs, account identity, tags, Region names, and provider responses never leave
the process.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Callable


OPS = Path(__file__).resolve().parents[1]
if str(OPS) not in sys.path:
    sys.path.insert(0, str(OPS))

import regional_security_rollout as rollout  # noqa: E402


EXPECTED_TAGS = {
    "Application": "IanTruongPhotography",
    "Stage": "prod",
}
EXPECTED_PUBLISHING_FREQUENCY = "FIFTEEN_MINUTES"
STACK_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,127}$")
EXPECTED_SATELLITE_RESOURCES = {
    "GuardDutyDetector": "AWS::GuardDuty::Detector",
    "SecurityHub": "AWS::SecurityHub::Hub",
}
HUB_ARN_PATTERN = re.compile(
    r"^arn:[^:]+:securityhub:([^:]+):([0-9]{12}):hub/default$"
)
AGGREGATOR_ARN_PATTERN = re.compile(
    r"^arn:[^:]+:securityhub:([^:]+):([0-9]{12}):finding-aggregator/[A-Za-z0-9-]+$"
)

AwsCaller = Callable[[list[str], str | None, str], dict[str, Any]]


class PostureError(RuntimeError):
    """Raised when complete exact regional posture cannot be proven."""


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
        raise PostureError("regional security inventory could not be queried") from error
    if completed.returncode != 0:
        raise PostureError("regional security inventory could not be queried")
    try:
        response = json.loads(completed.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        raise PostureError("regional security inventory was malformed") from error
    if not isinstance(response, dict):
        raise PostureError("regional security inventory was malformed")
    return response


def _call(
    caller: AwsCaller, arguments: list[str], profile: str | None, region: str
) -> dict[str, Any]:
    try:
        response = caller(arguments, profile, region)
    except Exception as error:
        if isinstance(error, PostureError):
            raise
        raise PostureError("regional security inventory could not be queried") from error
    if not isinstance(response, dict):
        raise PostureError("regional security inventory was malformed")
    return response


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
        or detail.get("FindingPublishingFrequency") != EXPECTED_PUBLISHING_FREQUENCY
        or detail.get("Tags") != EXPECTED_TAGS
        or states != rollout.EXPECTED_GUARDDUTY_FEATURES
    ):
        raise PostureError("GuardDuty posture differs from the contract")


def _standard_key(arn: Any, *, region: str) -> str:
    try:
        return rollout._security_hub_standard_key(arn, region=region)
    except rollout.InventoryError as error:
        raise PostureError("Security Hub standards inventory was malformed") from error


def _hub_posture(
    *,
    caller: AwsCaller,
    profile: str | None,
    region: str,
    home_region: str,
) -> str:
    detail = _call(caller, ["securityhub", "describe-hub"], profile, region)
    hub_arn = detail.get("HubArn")
    match = HUB_ARN_PATTERN.fullmatch(hub_arn) if isinstance(hub_arn, str) else None
    if (
        match is None
        or match.group(1) != region
        or detail.get("ControlFindingGenerator") != "SECURITY_CONTROL"
    ):
        raise PostureError("Security Hub posture differs from the contract")
    account_id = match.group(2)

    tag_response = _call(
        caller,
        ["securityhub", "list-tags-for-resource", "--resource-arn", hub_arn],
        profile,
        region,
    )
    if tag_response.get("Tags") != EXPECTED_TAGS:
        raise PostureError("Security Hub tags differ from the contract")

    standards_response = _call(
        caller, ["securityhub", "get-enabled-standards"], profile, region
    )
    subscriptions = standards_response.get("StandardsSubscriptions")
    if not isinstance(subscriptions, list):
        raise PostureError("Security Hub standards inventory was malformed")
    expected_home = region == home_region
    if not expected_home:
        if subscriptions:
            raise PostureError("Satellite Security Hub standards differ from the contract")
        return account_id

    states: dict[str, str] = {}
    for subscription in subscriptions:
        if not isinstance(subscription, dict):
            raise PostureError("Security Hub standards inventory was malformed")
        key = _standard_key(subscription.get("StandardsArn"), region=region)
        if subscription.get("StandardsStatus") != "READY" or key in states:
            raise PostureError("Home Security Hub standards differ from the contract")
        states[key] = "READY"
    if frozenset(states) != rollout.EXPECTED_HOME_SECURITY_HUB_STANDARDS:
        raise PostureError("Home Security Hub standards differ from the contract")
    return account_id


def _aggregator_posture(
    *,
    caller: AwsCaller,
    profile: str | None,
    home_region: str,
    account_id: str,
) -> None:
    inventory = _call(
        caller, ["securityhub", "list-finding-aggregators"], profile, home_region
    )
    aggregators = inventory.get("FindingAggregators")
    if (
        not isinstance(aggregators, list)
        or len(aggregators) != 1
        or not isinstance(aggregators[0], dict)
    ):
        raise PostureError("Security Hub finding aggregator differs from the contract")
    arn = aggregators[0].get("FindingAggregatorArn")
    match = AGGREGATOR_ARN_PATTERN.fullmatch(arn) if isinstance(arn, str) else None
    if match is None or match.groups() != (home_region, account_id):
        raise PostureError("Security Hub finding aggregator differs from the contract")
    detail = _call(
        caller,
        ["securityhub", "get-finding-aggregator", "--finding-aggregator-arn", arn],
        profile,
        home_region,
    )
    if (
        detail.get("FindingAggregationRegion") != home_region
        or detail.get("RegionLinkingMode") != "ALL_REGIONS"
        or detail.get("Regions") not in (None, [])
    ):
        raise PostureError("Security Hub finding aggregator differs from the contract")


def _satellite_stack_posture(
    *,
    caller: AwsCaller,
    profile: str | None,
    region: str,
    home_region: str,
    account_id: str,
    stack_name: str,
) -> None:
    stack_response = _call(
        caller,
        ["cloudformation", "describe-stacks", "--stack-name", stack_name],
        profile,
        region,
    )
    stacks = stack_response.get("Stacks")
    stack = stacks[0] if isinstance(stacks, list) and len(stacks) == 1 else None
    expected_stack = re.compile(
        rf"^arn:[^:]+:cloudformation:{re.escape(region)}:"
        rf"{re.escape(account_id)}:stack/{re.escape(stack_name)}/[A-Za-z0-9-]+$"
    )
    expected_parameters = {
        "AccessAnalyzerDeploymentMode": "skip",
        "ConfigDeploymentMode": "skip",
        "ExpectedAccountId": account_id,
        "ExpectedRegion": region,
        "GlobalResourceRecordingMode": "skip",
        "GuardDutyDeploymentMode": "create-confirmed-absent",
        "SecurityHubAggregationMode": "skip",
        "SecurityHubDeploymentMode": "create-confirmed-absent",
        "SecurityHubHomeHubState": "unverified",
        "SecurityHubHomeRegion": home_region,
        "Stage": "prod",
    }
    parameters = (
        {
            item.get("ParameterKey"): item.get("ParameterValue")
            for item in stack.get("Parameters", [])
            if isinstance(item, dict)
        }
        if isinstance(stack, dict)
        else {}
    )
    if (
        not isinstance(stacks, list)
        or len(stacks) != 1
        or not isinstance(stack, dict)
        or stack.get("StackStatus") not in {"CREATE_COMPLETE", "UPDATE_COMPLETE"}
        or stack.get("EnableTerminationProtection") is not True
        or not isinstance(stack.get("StackId"), str)
        or expected_stack.fullmatch(stack["StackId"]) is None
        or parameters != expected_parameters
    ):
        raise PostureError("regional security stack governance differs from the contract")
    resource_response = _call(
        caller,
        ["cloudformation", "list-stack-resources", "--stack-name", stack_name],
        profile,
        region,
    )
    summaries = resource_response.get("StackResourceSummaries")
    if not isinstance(summaries, list):
        raise PostureError("regional security stack ownership was malformed")
    resources: dict[str, str] = {}
    for summary in summaries:
        if not isinstance(summary, dict):
            raise PostureError("regional security stack ownership was malformed")
        logical_id = summary.get("LogicalResourceId")
        resource_type = summary.get("ResourceType")
        status = summary.get("ResourceStatus")
        if (
            not isinstance(logical_id, str)
            or not isinstance(resource_type, str)
            or logical_id in resources
            or status not in {"CREATE_COMPLETE", "IMPORT_COMPLETE", "UPDATE_COMPLETE"}
        ):
            raise PostureError("regional security stack ownership was malformed")
        resources[logical_id] = resource_type
    if resources != EXPECTED_SATELLITE_RESOURCES:
        raise PostureError("regional security stack ownership differs from the contract")


def audit(
    *,
    home_region: str,
    satellite_stack_name: str,
    profile: str | None = None,
    caller: AwsCaller = aws_call,
) -> dict[str, int | str]:
    if (
        not rollout.REGION_PATTERN.fullmatch(home_region)
        or not STACK_PATTERN.fullmatch(satellite_stack_name)
    ):
        raise PostureError("regional security stack name is invalid")
    try:
        regions = rollout.enabled_regions(
            caller=caller, profile=profile, home_region=home_region
        )
    except Exception as error:
        raise PostureError("enabled Region inventory could not be verified") from error
    account_ids: set[str] = set()
    for region in regions:
        _detector_posture(caller=caller, profile=profile, region=region)
        account_id = _hub_posture(
            caller=caller,
            profile=profile,
            region=region,
            home_region=home_region,
        )
        account_ids.add(account_id)
        if region != home_region:
            _satellite_stack_posture(
                caller=caller,
                profile=profile,
                region=region,
                home_region=home_region,
                account_id=account_id,
                stack_name=satellite_stack_name,
            )
    if len(account_ids) != 1:
        raise PostureError("regional security inventory was not account-consistent")
    _aggregator_posture(
        caller=caller,
        profile=profile,
        home_region=home_region,
        account_id=next(iter(account_ids)),
    )
    return {
        "detectorCount": len(regions),
        "enabledRegionCount": len(regions),
        "findingAggregatorCount": 1,
        "homeStandardCount": len(rollout.EXPECTED_HOME_SECURITY_HUB_STANDARDS),
        "satelliteStandardCount": 0,
        "satelliteStackCount": len(regions) - 1,
        "securityHubCount": len(regions),
        "status": "IN_SYNC",
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit aggregate regional GuardDuty and Security Hub posture."
    )
    parser.add_argument("--home-region", required=True)
    parser.add_argument("--satellite-stack-name", required=True)
    parser.add_argument("--profile")
    arguments = parser.parse_args()
    try:
        report = audit(
            home_region=arguments.home_region,
            satellite_stack_name=arguments.satellite_stack_name,
            profile=arguments.profile,
        )
    except PostureError:
        print("Regional security posture could not be verified.", file=sys.stderr)
        return 2
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
