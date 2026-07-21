#!/usr/bin/env python3
"""Plan guarded regional GuardDuty and Security Hub CloudFormation change sets.

The default mode is read-only. It inventories every Region enabled for the
active account, treats existing regional singletons as externally managed, and
prints only aggregate service state plus the exact Region plan. The optional
prepare mode creates non-executing CloudFormation change sets only; it never
executes a change set and never disables or adopts a detector, hub, or finding
aggregator.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Callable

from security_preflight import AwsCallError, aws_call


ACCOUNT_PATTERN = re.compile(r"^[0-9]{12}$")
REGION_PATTERN = re.compile(r"^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]$")
STACK_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,127}$")
CONFIRMATION = "prepare-regional-security-change-sets"
TEMPLATE = Path(__file__).with_name("security_managed_services_template.yaml")
DISABLED_HUB_ERRORS = (
    "invalidaccessexception",
    "not subscribed",
    "not enabled",
)
MISSING_STACK_ERRORS = ("does not exist",)
EXPECTED_GUARDDUTY_FEATURES = {
    "S3_DATA_EVENTS": "ENABLED",
    "EKS_AUDIT_LOGS": "DISABLED",
    "EBS_MALWARE_PROTECTION": "DISABLED",
    "RDS_LOGIN_EVENTS": "DISABLED",
    "LAMBDA_NETWORK_LOGS": "ENABLED",
    "RUNTIME_MONITORING": "DISABLED",
}
STABLE_STACK_STATUSES = {
    "CREATE_COMPLETE",
    "IMPORT_COMPLETE",
    "UPDATE_COMPLETE",
    "UPDATE_ROLLBACK_COMPLETE",
}

AwsCaller = Callable[[list[str], str | None, str], dict[str, Any]]


class InventoryError(RuntimeError):
    """Raised when read-only inventory cannot prove a safe exact plan."""


def _canonical_digest(value: Any) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _call(
    caller: AwsCaller,
    arguments: list[str],
    profile: str | None,
    region: str,
) -> dict[str, Any]:
    try:
        result = caller(arguments, profile, region)
    except AwsCallError as error:
        raise InventoryError(
            f"{arguments[0]} {arguments[1]} inventory failed in {region}"
        ) from error
    if not isinstance(result, dict):
        raise InventoryError(
            f"{arguments[0]} {arguments[1]} returned invalid inventory in {region}"
        )
    return result


def enabled_regions(
    *, caller: AwsCaller, profile: str | None, home_region: str
) -> list[str]:
    response = _call(
        caller,
        ["ec2", "describe-regions"],
        profile,
        home_region,
    )
    regions = response.get("Regions")
    if not isinstance(regions, list) or not regions:
        raise InventoryError("EC2 did not return a nonempty enabled-Region inventory")
    names: list[str] = []
    for item in regions:
        if not isinstance(item, dict):
            raise InventoryError("EC2 returned a malformed enabled-Region entry")
        name = item.get("RegionName")
        status = item.get("OptInStatus")
        if not isinstance(name, str) or not REGION_PATTERN.fullmatch(name):
            raise InventoryError("EC2 returned an invalid enabled Region name")
        if status not in {"opt-in-not-required", "opted-in"}:
            raise InventoryError("EC2 returned a Region that is not enabled")
        names.append(name)
    if len(names) != len(set(names)):
        raise InventoryError("EC2 returned duplicate enabled Regions")
    if home_region not in names:
        raise InventoryError("the declared Security Hub home Region is not enabled")
    return sorted(names)


def _guardduty_state(
    *, caller: AwsCaller, profile: str | None, region: str
) -> str:
    response = _call(caller, ["guardduty", "list-detectors"], profile, region)
    detectors = response.get("DetectorIds")
    if not isinstance(detectors, list) or any(
        not isinstance(item, str) or not item for item in detectors
    ):
        raise InventoryError(f"GuardDuty returned malformed inventory in {region}")
    if len(detectors) > 1:
        raise InventoryError(f"GuardDuty returned multiple detectors in {region}")
    if not detectors:
        return "absent"
    detail = _call(
        caller,
        ["guardduty", "get-detector", "--detector-id", detectors[0]],
        profile,
        region,
    )
    features = detail.get("Features")
    if detail.get("Status") != "ENABLED" or not isinstance(features, list):
        raise InventoryError(f"GuardDuty detector is disabled or malformed in {region}")
    feature_states: dict[str, str] = {}
    for feature in features:
        if not isinstance(feature, dict):
            raise InventoryError(f"GuardDuty returned malformed features in {region}")
        name = feature.get("Name")
        status = feature.get("Status")
        if (
            not isinstance(name, str)
            or not name
            or status not in {"ENABLED", "DISABLED"}
            or name in feature_states
        ):
            raise InventoryError(f"GuardDuty returned malformed features in {region}")
        feature_states[name] = status
    if feature_states != EXPECTED_GUARDDUTY_FEATURES:
        raise InventoryError(f"GuardDuty protection plan differs from reviewed IaC in {region}")
    return "existing"


def _security_hub_state(
    *, caller: AwsCaller, profile: str | None, region: str
) -> str:
    try:
        response = caller(["securityhub", "describe-hub"], profile, region)
    except AwsCallError as error:
        if any(marker in error.message.lower() for marker in DISABLED_HUB_ERRORS):
            return "absent"
        raise InventoryError(
            f"securityhub describe-hub inventory failed in {region}"
        ) from error
    if not isinstance(response, dict):
        raise InventoryError(f"Security Hub returned invalid inventory in {region}")
    arn = response.get("HubArn")
    if arn is None:
        return "absent"
    if not isinstance(arn, str) or not arn:
        raise InventoryError(f"Security Hub returned malformed inventory in {region}")
    return "existing"


def _finding_aggregator_state(
    *, caller: AwsCaller, profile: str | None, home_region: str
) -> str:
    response = _call(
        caller,
        ["securityhub", "list-finding-aggregators"],
        profile,
        home_region,
    )
    aggregators = response.get("FindingAggregators")
    if not isinstance(aggregators, list):
        raise InventoryError("Security Hub returned malformed finding-aggregator inventory")
    if not aggregators:
        return "absent"
    if len(aggregators) != 1 or not isinstance(aggregators[0], dict):
        raise InventoryError("Security Hub returned multiple or malformed finding aggregators")
    arn = aggregators[0].get("FindingAggregatorArn")
    if not isinstance(arn, str) or not arn:
        raise InventoryError("Security Hub returned an aggregator without an ARN")
    detail = _call(
        caller,
        [
            "securityhub",
            "get-finding-aggregator",
            "--finding-aggregator-arn",
            arn,
        ],
        profile,
        home_region,
    )
    if (
        detail.get("FindingAggregationRegion") != home_region
        or detail.get("RegionLinkingMode") != "ALL_REGIONS"
        or detail.get("Regions") not in (None, [])
    ):
        raise InventoryError(
            "an existing finding aggregator does not match the declared ALL_REGIONS home"
        )
    return "existing-all-regions"


def build_plan(
    *,
    stage: str,
    home_region: str,
    home_stack_name: str,
    regional_stack_name: str,
    profile: str | None,
    caller: AwsCaller = aws_call,
) -> dict[str, Any]:
    identity = _call(caller, ["sts", "get-caller-identity"], profile, home_region)
    account_id = identity.get("Account")
    if not isinstance(account_id, str) or not ACCOUNT_PATTERN.fullmatch(account_id):
        raise InventoryError("STS did not return a valid 12-digit account ID")
    regions = enabled_regions(caller=caller, profile=profile, home_region=home_region)

    region_plans: list[dict[str, str]] = []
    for region in regions:
        guardduty = _guardduty_state(caller=caller, profile=profile, region=region)
        security_hub = _security_hub_state(
            caller=caller, profile=profile, region=region
        )
        region_plans.append(
            {
                "region": region,
                "stackName": home_stack_name if region == home_region else regional_stack_name,
                "guardDuty": (
                    "skip-existing"
                    if guardduty == "existing"
                    else "create-confirmed-absent"
                ),
                "securityHub": (
                    "skip-existing"
                    if security_hub == "existing"
                    else "create-confirmed-absent"
                ),
            }
        )

    home_plan = next(item for item in region_plans if item["region"] == home_region)
    if home_plan["securityHub"] == "skip-existing":
        aggregator_state = _finding_aggregator_state(
            caller=caller, profile=profile, home_region=home_region
        )
        aggregator_action = (
            "skip-existing-all-regions"
            if aggregator_state == "existing-all-regions"
            else "create-confirmed-absent-home-hub-enabled"
        )
    else:
        aggregator_action = "defer-until-home-hub-enabled"

    mutation_plan = {
        "schemaVersion": 1,
        "accountId": account_id,
        "stage": stage,
        "homeRegion": home_region,
        "enabledRegions": regions,
        "regionPlans": region_plans,
        "findingAggregator": aggregator_action,
        "templateDigest": _file_digest(TEMPLATE),
    }
    return {
        **mutation_plan,
        "planDigest": _canonical_digest(mutation_plan),
    }


def public_report(plan: dict[str, Any], *, prepare: bool) -> dict[str, Any]:
    region_plans = plan["regionPlans"]
    guardduty_creates = sum(
        item["guardDuty"] == "create-confirmed-absent" for item in region_plans
    )
    hub_creates = sum(
        item["securityHub"] == "create-confirmed-absent" for item in region_plans
    )
    return {
        "mode": "prepare-change-sets" if prepare else "dry-run",
        "accountId": "verified",
        "stage": plan["stage"],
        "homeRegion": plan["homeRegion"],
        "enabledRegionCount": len(plan["enabledRegions"]),
        "enabledRegions": plan["enabledRegions"],
        "coverage": {
            "guardDutyExisting": len(region_plans) - guardduty_creates,
            "guardDutyCreate": guardduty_creates,
            "securityHubExisting": len(region_plans) - hub_creates,
            "securityHubCreate": hub_creates,
        },
        "regionPlans": region_plans,
        "findingAggregator": plan["findingAggregator"],
        "planDigest": plan["planDigest"],
        "templateDigest": plan["templateDigest"],
        "executesChangeSets": False,
    }


def validate_prepare_guards(
    *,
    prepare: bool,
    plan: dict[str, Any],
    expected_account_id: str | None,
    expected_home_region: str | None,
    expected_plan_digest: str | None,
    expected_enabled_region_count: int | None,
    confirmation: str | None,
) -> None:
    if not prepare:
        return
    if expected_account_id != plan["accountId"]:
        raise SystemExit(
            "--expected-account-id must exactly match the active AWS account"
        )
    if expected_home_region != plan["homeRegion"]:
        raise SystemExit(
            "--expected-home-region must exactly match the inventoried home Region"
        )
    if expected_plan_digest != plan["planDigest"]:
        raise SystemExit("--expected-plan-digest must exactly match the fresh plan")
    if expected_enabled_region_count != len(plan["enabledRegions"]):
        raise SystemExit(
            "--expected-enabled-region-count must exactly match the fresh inventory"
        )
    if confirmation != CONFIRMATION:
        raise SystemExit(f"--confirm must be exactly {CONFIRMATION}")


def _stack(
    *, caller: AwsCaller, profile: str | None, region: str, stack_name: str
) -> dict[str, Any] | None:
    try:
        response = caller(
            ["cloudformation", "describe-stacks", "--stack-name", stack_name],
            profile,
            region,
        )
    except AwsCallError as error:
        if any(marker in error.message.lower() for marker in MISSING_STACK_ERRORS):
            return None
        raise InventoryError(
            f"CloudFormation stack inventory failed in {region}"
        ) from error
    stacks = response.get("Stacks") if isinstance(response, dict) else None
    if not isinstance(stacks, list) or len(stacks) != 1 or not isinstance(stacks[0], dict):
        raise InventoryError(f"CloudFormation returned malformed stack state in {region}")
    return stacks[0]


def _preflight_stacks(
    *, plan: dict[str, Any], profile: str | None, caller: AwsCaller
) -> None:
    home = plan["homeRegion"]
    home_plan = next(item for item in plan["regionPlans"] if item["region"] == home)
    home_mutation = (
        home_plan["guardDuty"] == "create-confirmed-absent"
        or home_plan["securityHub"] == "create-confirmed-absent"
        or plan["findingAggregator"]
        == "create-confirmed-absent-home-hub-enabled"
    )
    if (
        plan["findingAggregator"] == "skip-existing-all-regions"
        and (
            home_plan["guardDuty"] == "create-confirmed-absent"
            or home_plan["securityHub"] == "create-confirmed-absent"
        )
    ):
        raise InventoryError(
            "an existing finding aggregator requires ownership review before a home-stack update"
        )
    if home_mutation:
        stack = _stack(
            caller=caller,
            profile=profile,
            region=home,
            stack_name=home_plan["stackName"],
        )
        if stack is None:
            raise InventoryError("the exact managed-security home stack does not exist")
        if stack.get("StackStatus") not in STABLE_STACK_STATUSES:
            raise InventoryError("the managed-security home stack is not stable")
        if stack.get("EnableTerminationProtection") is not True:
            raise InventoryError(
                "the managed-security home stack lacks termination protection"
            )
        stack_id = stack.get("StackId")
        expected_stack = re.compile(
            rf"^arn:[^:]+:cloudformation:{re.escape(home)}:"
            rf"{re.escape(plan['accountId'])}:stack/"
            rf"{re.escape(home_plan['stackName'])}/"
        )
        if not isinstance(stack_id, str) or not expected_stack.match(stack_id):
            raise InventoryError(
                "the managed-security home stack identity is outside the exact scope"
            )
        parameters = {
            item.get("ParameterKey"): item.get("ParameterValue")
            for item in stack.get("Parameters", [])
            if isinstance(item, dict)
        }
        if parameters.get("Stage") != plan["stage"]:
            raise InventoryError("the managed-security home stack Stage does not match")

    for item in plan["regionPlans"]:
        if item["region"] == home:
            continue
        if (
            item["guardDuty"] != "create-confirmed-absent"
            and item["securityHub"] != "create-confirmed-absent"
        ):
            continue
        if _stack(
            caller=caller,
            profile=profile,
            region=item["region"],
            stack_name=item["stackName"],
        ) is not None:
            raise InventoryError(
                f"regional stack {item['stackName']} already exists in {item['region']}"
            )


def _parameter(key: str, *, value: str | None = None, previous: bool = False) -> str:
    if previous == (value is not None):
        raise ValueError("parameter must use exactly one of value or previous")
    if previous:
        return f"ParameterKey={key},UsePreviousValue=true"
    return f"ParameterKey={key},ParameterValue={value}"


def _home_parameters(plan: dict[str, Any], item: dict[str, str]) -> list[str]:
    def mode(key: str, action: str) -> str:
        if action == "create-confirmed-absent":
            return _parameter(key, value="create-confirmed-absent")
        return _parameter(key, previous=True)

    aggregator_create = (
        plan["findingAggregator"]
        == "create-confirmed-absent-home-hub-enabled"
    )
    return [
        _parameter("ExpectedAccountId", value=plan["accountId"]),
        _parameter("ExpectedRegion", value=plan["homeRegion"]),
        _parameter("Stage", previous=True),
        _parameter("ConfigDeploymentMode", previous=True),
        mode("GuardDutyDeploymentMode", item["guardDuty"]),
        mode("SecurityHubDeploymentMode", item["securityHub"]),
        _parameter("AccessAnalyzerDeploymentMode", previous=True),
        _parameter("GlobalResourceRecordingMode", previous=True),
        _parameter(
            "SecurityHubAggregationMode",
            value=(
                "create-confirmed-absent-home-hub-enabled"
                if aggregator_create
                else "skip"
            ),
        ),
        _parameter("SecurityHubHomeRegion", value=plan["homeRegion"]),
        _parameter(
            "SecurityHubHomeHubState",
            value="confirmed-enabled" if aggregator_create else "unverified",
        ),
    ]


def _regional_parameters(plan: dict[str, Any], item: dict[str, str]) -> list[str]:
    def create_or_skip(action: str) -> str:
        return "create-confirmed-absent" if action == "create-confirmed-absent" else "skip"

    return [
        _parameter("ExpectedAccountId", value=plan["accountId"]),
        _parameter("ExpectedRegion", value=item["region"]),
        _parameter("Stage", value=plan["stage"]),
        _parameter("ConfigDeploymentMode", value="skip"),
        _parameter(
            "GuardDutyDeploymentMode", value=create_or_skip(item["guardDuty"])
        ),
        _parameter(
            "SecurityHubDeploymentMode", value=create_or_skip(item["securityHub"])
        ),
        _parameter("AccessAnalyzerDeploymentMode", value="skip"),
        _parameter("GlobalResourceRecordingMode", value="skip"),
        _parameter("SecurityHubAggregationMode", value="skip"),
        _parameter("SecurityHubHomeRegion", value=plan["homeRegion"]),
        _parameter("SecurityHubHomeHubState", value="unverified"),
    ]


def prepare_change_sets(
    *,
    plan: dict[str, Any],
    profile: str | None,
    caller: AwsCaller = aws_call,
    mutator: AwsCaller = aws_call,
) -> list[dict[str, str]]:
    """Create reviewable change sets, but never execute them."""
    if plan.get("templateDigest") != _file_digest(TEMPLATE):
        raise InventoryError("the managed-security template changed after planning")
    _preflight_stacks(plan=plan, profile=profile, caller=caller)
    digest_prefix = plan["planDigest"][:12]
    prepared: list[dict[str, str]] = []
    home = plan["homeRegion"]
    for item in plan["regionPlans"]:
        is_home = item["region"] == home
        needs_regional = (
            item["guardDuty"] == "create-confirmed-absent"
            or item["securityHub"] == "create-confirmed-absent"
        )
        needs_aggregator = is_home and (
            plan["findingAggregator"]
            == "create-confirmed-absent-home-hub-enabled"
        )
        if not needs_regional and not needs_aggregator:
            continue
        change_set_name = f"regional-security-{digest_prefix}"
        parameters = (
            _home_parameters(plan, item)
            if is_home
            else _regional_parameters(plan, item)
        )
        arguments = [
            "cloudformation",
            "create-change-set",
            "--stack-name",
            item["stackName"],
            "--change-set-name",
            change_set_name,
            "--change-set-type",
            "UPDATE" if is_home else "CREATE",
            "--description",
            f"Guarded regional security plan {digest_prefix}",
            "--client-token",
            f"{plan['planDigest']}-{item['region']}",
            "--template-body",
            f"file://{TEMPLATE}",
            "--capabilities",
            "CAPABILITY_NAMED_IAM",
            "--parameters",
            *parameters,
        ]
        if not is_home:
            arguments.extend(
                [
                    "--tags",
                    "Key=Application,Value=IanTruongPhotography",
                    f"Key=Stage,Value={plan['stage']}",
                    "Key=ManagedBy,Value=CloudFormation",
                ]
            )
        mutator(arguments, profile, item["region"])
        prepared.append(
            {
                "region": item["region"],
                "stackName": item["stackName"],
                "changeSetName": change_set_name,
                "changeSetType": "UPDATE" if is_home else "CREATE",
            }
        )
    return prepared


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", default="prod")
    parser.add_argument("--home-region", default="us-west-2")
    parser.add_argument(
        "--home-stack-name", default="ian-photography-security-managed"
    )
    parser.add_argument(
        "--regional-stack-name", default="ian-photography-security-regional"
    )
    parser.add_argument("--profile")
    parser.add_argument("--prepare-change-sets", action="store_true")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--expected-home-region")
    parser.add_argument("--expected-plan-digest")
    parser.add_argument("--expected-enabled-region-count", type=int)
    parser.add_argument("--confirm")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?", args.stage):
        raise SystemExit("--stage is invalid")
    if not REGION_PATTERN.fullmatch(args.home_region):
        raise SystemExit("--home-region is invalid")
    if not STACK_PATTERN.fullmatch(args.home_stack_name):
        raise SystemExit("--home-stack-name is invalid")
    if not STACK_PATTERN.fullmatch(args.regional_stack_name):
        raise SystemExit("--regional-stack-name is invalid")

    plan = build_plan(
        stage=args.stage,
        home_region=args.home_region,
        home_stack_name=args.home_stack_name,
        regional_stack_name=args.regional_stack_name,
        profile=args.profile,
    )
    print(
        json.dumps(
            public_report(plan, prepare=args.prepare_change_sets),
            indent=2,
            sort_keys=True,
        )
    )
    validate_prepare_guards(
        prepare=args.prepare_change_sets,
        plan=plan,
        expected_account_id=args.expected_account_id,
        expected_home_region=args.expected_home_region,
        expected_plan_digest=args.expected_plan_digest,
        expected_enabled_region_count=args.expected_enabled_region_count,
        confirmation=args.confirm,
    )
    if not args.prepare_change_sets:
        return 0
    prepared = prepare_change_sets(plan=plan, profile=args.profile)
    print(
        json.dumps(
            {
                "result": "change-sets-prepared-not-executed",
                "preparedCount": len(prepared),
                "changeSets": prepared,
                "planDigest": plan["planDigest"],
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
