"""Focused tests for guarded all-Region security-service rollout planning."""

from __future__ import annotations

from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
sys.path.insert(0, str(OPS))

import regional_security_rollout as rollout  # noqa: E402
from security_preflight import AwsCallError  # noqa: E402


ACCOUNT = "123456789012"
HOME = "us-west-2"
OTHER = "us-east-1"
AGGREGATOR_ARN = (
    f"arn:aws:securityhub:{HOME}:{ACCOUNT}:finding-aggregator/"
    "00000000-0000-4000-8000-000000000000"
)
GUARDDUTY_FEATURES = [
    {"Name": "S3_DATA_EVENTS", "Status": "ENABLED"},
    {"Name": "EKS_AUDIT_LOGS", "Status": "DISABLED"},
    {"Name": "EBS_MALWARE_PROTECTION", "Status": "DISABLED"},
    {"Name": "RDS_LOGIN_EVENTS", "Status": "DISABLED"},
    {"Name": "LAMBDA_NETWORK_LOGS", "Status": "ENABLED"},
    {"Name": "RUNTIME_MONITORING", "Status": "DISABLED"},
    {"Name": "CLOUD_TRAIL", "Status": "ENABLED"},
    {"Name": "DNS_LOGS", "Status": "ENABLED"},
    {"Name": "FLOW_LOGS", "Status": "ENABLED"},
    {"Name": "AI_ANALYST", "Status": "DISABLED"},
    {"Name": "AI_PROTECTION", "Status": "DISABLED"},
    {"Name": "EKS_RUNTIME_MONITORING", "Status": "DISABLED"},
]
HOME_SECURITY_HUB_STANDARDS = [
    {
        "StandardsArn": (
            f"arn:aws:securityhub:{HOME}::standards/"
            "aws-foundational-security-best-practices/v/1.0.0"
        ),
        "StandardsStatus": "READY",
    },
    {
        "StandardsArn": (
            "arn:aws:securityhub:::ruleset/"
            "cis-aws-foundations-benchmark/v/1.2.0"
        ),
        "StandardsStatus": "READY",
    },
]


def responses(*, aggregator: str = "absent") -> dict[tuple[str, str, str], dict]:
    values: dict[tuple[str, str, str], dict] = {
        (HOME, "sts", "get-caller-identity"): {"Account": ACCOUNT},
        (HOME, "ec2", "describe-regions"): {
            "Regions": [
                {"RegionName": HOME, "OptInStatus": "opt-in-not-required"},
                {"RegionName": OTHER, "OptInStatus": "opt-in-not-required"},
            ]
        },
        (HOME, "guardduty", "list-detectors"): {"DetectorIds": ["existing"]},
        (HOME, "guardduty", "get-detector"): {
            "Status": "ENABLED",
            "Features": GUARDDUTY_FEATURES,
        },
        (OTHER, "guardduty", "list-detectors"): {"DetectorIds": []},
        (HOME, "securityhub", "describe-hub"): {
            "HubArn": "arn:home-hub",
            "ControlFindingGenerator": "SECURITY_CONTROL",
        },
        (HOME, "securityhub", "get-enabled-standards"): {
            "StandardsSubscriptions": HOME_SECURITY_HUB_STANDARDS,
        },
        (OTHER, "securityhub", "describe-hub"): {},
        (HOME, "securityhub", "list-finding-aggregators"): {
            "FindingAggregators": (
                []
                if aggregator == "absent"
                else [{"FindingAggregatorArn": AGGREGATOR_ARN}]
            )
        },
    }
    if aggregator != "absent":
        values[(HOME, "securityhub", "get-finding-aggregator")] = {
            "FindingAggregatorArn": AGGREGATOR_ARN,
            "FindingAggregationRegion": HOME,
            "RegionLinkingMode": (
                "ALL_REGIONS" if aggregator == "valid" else "SPECIFIED_REGIONS"
            ),
            "Regions": [] if aggregator == "valid" else [OTHER],
        }
    return values


def caller_for(values: dict[tuple[str, str, str], dict]):
    def caller(arguments: list[str], profile: str | None, region: str) -> dict:
        return values[(region, arguments[0], arguments[1])]

    return caller


def build(values: dict[tuple[str, str, str], dict]) -> dict:
    return rollout.build_plan(
        stage="prod",
        home_region=HOME,
        home_stack_name="ian-photography-security-managed",
        regional_stack_name="ian-photography-security-regional",
        profile=None,
        caller=caller_for(values),
    )


def home_stack(**overrides) -> dict:
    stack = {
        "StackId": (
            f"arn:aws:cloudformation:{HOME}:{ACCOUNT}:stack/"
            "ian-photography-security-managed/"
            "00000000-0000-4000-8000-000000000000"
        ),
        "StackStatus": "UPDATE_COMPLETE",
        "EnableTerminationProtection": True,
        "Parameters": [{"ParameterKey": "Stage", "ParameterValue": "prod"}],
    }
    stack.update(overrides)
    return {"Stacks": [stack]}


class RegionalSecurityPlanTests(unittest.TestCase):
    def test_generic_and_enabled_region_inventory_reject_malformed_or_incomplete_state(
        self,
    ) -> None:
        with self.assertRaises(rollout.InventoryError):
            rollout._call(lambda arguments, profile, region: [], ["x", "y"], None, HOME)

        invalid_responses = (
            {},
            {"Regions": []},
            {"Regions": [None]},
            {"Regions": [{"RegionName": "invalid", "OptInStatus": "opted-in"}]},
            {"Regions": [{"RegionName": HOME, "OptInStatus": "not-opted-in"}]},
            {
                "Regions": [
                    {"RegionName": HOME, "OptInStatus": "opted-in"},
                    {"RegionName": HOME, "OptInStatus": "opted-in"},
                ]
            },
            {
                "Regions": [
                    {"RegionName": OTHER, "OptInStatus": "opt-in-not-required"}
                ]
            },
        )
        for response in invalid_responses:
            with self.subTest(response=response), self.assertRaises(
                rollout.InventoryError
            ):
                rollout.enabled_regions(
                    caller=lambda arguments, profile, region, value=response: value,
                    profile=None,
                    home_region=HOME,
                )
        self.assertEqual(
            rollout.enabled_regions(
                caller=lambda arguments, profile, region: {
                    "Regions": [
                        {"RegionName": HOME, "OptInStatus": "opted-in"}
                    ]
                },
                profile=None,
                home_region=HOME,
            ),
            [HOME],
        )

    def test_guardduty_and_security_hub_inventory_classification_fails_closed(
        self,
    ) -> None:
        for detector_response in (
            {},
            {"DetectorIds": "not-a-list"},
            {"DetectorIds": [""]},
            {"DetectorIds": ["one", "two"]},
        ):
            with self.subTest(detector_response=detector_response), self.assertRaises(
                rollout.InventoryError
            ):
                rollout._guardduty_state(
                    caller=lambda arguments, profile, region, value=detector_response: value,
                    profile=None,
                    region=HOME,
                )

        def disabled_hub(arguments: list[str], profile: str | None, region: str) -> dict:
            raise AwsCallError("securityhub", "describe-hub", "InvalidAccessException")

        self.assertEqual(
            rollout._security_hub_state(
                caller=disabled_hub,
                profile=None,
                region=HOME,
                expect_default_standards=True,
            ),
            "absent",
        )
        healthy_calls = []

        def healthy_detector(arguments, profile, region):
            healthy_calls.append(arguments)
            if arguments[1] == "list-detectors":
                return {"DetectorIds": ["private-id"]}
            return {
                "Status": "ENABLED",
                "Features": GUARDDUTY_FEATURES,
            }

        self.assertEqual(
            rollout._guardduty_state(
                caller=healthy_detector, profile=None, region=HOME
            ),
            "existing",
        )
        self.assertEqual(healthy_calls[1][-2:], ["--detector-id", "private-id"])
        self.assertEqual(
            {item["Name"]: item["Status"] for item in GUARDDUTY_FEATURES},
            rollout.EXPECTED_GUARDDUTY_FEATURES,
        )

        unhealthy_details = (
            {"Status": "DISABLED", "Features": []},
            {"Status": "ENABLED"},
            {
                "Status": "ENABLED",
                "Features": [
                    {"Name": name, "Status": "DISABLED" if name == "LAMBDA_NETWORK_LOGS" else status}
                    for name, status in rollout.EXPECTED_GUARDDUTY_FEATURES.items()
                ],
            },
            {
                "Status": "ENABLED",
                "Features": [
                    {"Name": name, "Status": "ENABLED" if name == "RUNTIME_MONITORING" else status}
                    for name, status in rollout.EXPECTED_GUARDDUTY_FEATURES.items()
                ],
            },
            {
                "Status": "ENABLED",
                "Features": [
                    feature
                    for feature in GUARDDUTY_FEATURES
                    if feature["Name"] != "AI_ANALYST"
                ],
            },
            {
                "Status": "ENABLED",
                "Features": [
                    {
                        "Name": feature["Name"],
                        "Status": (
                            "DISABLED"
                            if feature["Name"] == "DNS_LOGS"
                            else feature["Status"]
                        ),
                    }
                    for feature in GUARDDUTY_FEATURES
                ],
            },
            {
                "Status": "ENABLED",
                "Features": [
                    {"Name": "S3_DATA_EVENTS", "Status": "ENABLED"},
                    {"Name": "S3_DATA_EVENTS", "Status": "ENABLED"},
                ],
            },
            {
                "Status": "ENABLED",
                "Features": GUARDDUTY_FEATURES
                + [{"Name": "FUTURE_PAID_PROTECTION", "Status": "ENABLED"}],
            },
        )
        for detail in unhealthy_details:
            def unhealthy_detector(arguments, profile, region, value=detail):
                if arguments[1] == "list-detectors":
                    return {"DetectorIds": ["private-id"]}
                return value

            with self.subTest(detail=detail), self.assertRaises(
                rollout.InventoryError
            ):
                rollout._guardduty_state(
                    caller=unhealthy_detector, profile=None, region=HOME
                )
        for response in ([], {"HubArn": ""}):
            with self.subTest(hub_response=response), self.assertRaises(
                rollout.InventoryError
            ):
                rollout._security_hub_state(
                    caller=lambda arguments, profile, region, value=response: value,
                    profile=None,
                    region=HOME,
                    expect_default_standards=True,
                )

        def denied_hub(arguments: list[str], profile: str | None, region: str) -> dict:
            raise AwsCallError("securityhub", "describe-hub", "AccessDeniedException")

        with self.assertRaises(rollout.InventoryError):
            rollout._security_hub_state(
                caller=denied_hub,
                profile=None,
                region=HOME,
                expect_default_standards=True,
            )

    def test_security_hub_standards_are_exact_for_home_and_satellites(self) -> None:
        def caller_with(standards, *, generator="SECURITY_CONTROL"):
            def caller(arguments, profile, region):
                if arguments[1] == "describe-hub":
                    return {
                        "HubArn": "arn:private-hub",
                        "ControlFindingGenerator": generator,
                    }
                self.assertEqual(arguments[:2], ["securityhub", "get-enabled-standards"])
                return {"StandardsSubscriptions": standards}

            return caller

        self.assertEqual(
            rollout._security_hub_state(
                caller=caller_with(HOME_SECURITY_HUB_STANDARDS),
                profile=None,
                region=HOME,
                expect_default_standards=True,
            ),
            "existing",
        )
        self.assertEqual(
            rollout._security_hub_state(
                caller=caller_with([]),
                profile=None,
                region=OTHER,
                expect_default_standards=False,
            ),
            "existing",
        )

        home_drift = (
            HOME_SECURITY_HUB_STANDARDS[:1],
            HOME_SECURITY_HUB_STANDARDS
            + [
                {
                    "StandardsArn": (
                        f"arn:aws:securityhub:{HOME}::standards/"
                        "pci-dss/v/3.2.1"
                    ),
                    "StandardsStatus": "READY",
                }
            ],
            [
                {
                    **item,
                    "StandardsStatus": (
                        "INCOMPLETE"
                        if index == 0
                        else item["StandardsStatus"]
                    ),
                }
                for index, item in enumerate(HOME_SECURITY_HUB_STANDARDS)
            ],
            [HOME_SECURITY_HUB_STANDARDS[0], HOME_SECURITY_HUB_STANDARDS[0]],
            [None],
            [
                {
                    **HOME_SECURITY_HUB_STANDARDS[0],
                    "StandardsArn": HOME_SECURITY_HUB_STANDARDS[0][
                        "StandardsArn"
                    ].replace(HOME, OTHER),
                },
                HOME_SECURITY_HUB_STANDARDS[1],
            ],
            [
                HOME_SECURITY_HUB_STANDARDS[0],
                {
                    **HOME_SECURITY_HUB_STANDARDS[1],
                    "StandardsArn": HOME_SECURITY_HUB_STANDARDS[1][
                        "StandardsArn"
                    ].replace("securityhub:::", f"securityhub:{OTHER}::"),
                },
            ],
        )
        for standards in home_drift:
            with self.subTest(standards=standards), self.assertRaises(
                rollout.InventoryError
            ):
                rollout._security_hub_state(
                    caller=caller_with(standards),
                    profile=None,
                    region=HOME,
                    expect_default_standards=True,
                )

        with self.assertRaises(rollout.InventoryError):
            rollout._security_hub_state(
                caller=caller_with(HOME_SECURITY_HUB_STANDARDS),
                profile=None,
                region=OTHER,
                expect_default_standards=False,
            )
        with self.assertRaises(rollout.InventoryError):
            rollout._security_hub_state(
                caller=caller_with([], generator="PRODUCT_FIELDS"),
                profile=None,
                region=OTHER,
                expect_default_standards=False,
            )

    def test_finding_aggregator_inventory_rejects_ambiguous_or_drifted_state(
        self,
    ) -> None:
        for listing in (
            {},
            {"FindingAggregators": [None]},
            {"FindingAggregators": [{}, {}]},
            {"FindingAggregators": [{}]},
        ):
            with self.subTest(listing=listing), self.assertRaises(
                rollout.InventoryError
            ):
                rollout._finding_aggregator_state(
                    caller=lambda arguments, profile, region, value=listing: value,
                    profile=None,
                    home_region=HOME,
                )

        drift_cases = (
            {
                "FindingAggregationRegion": OTHER,
                "RegionLinkingMode": "ALL_REGIONS",
                "Regions": [],
            },
            {
                "FindingAggregationRegion": HOME,
                "RegionLinkingMode": "SPECIFIED_REGIONS",
                "Regions": [],
            },
            {
                "FindingAggregationRegion": HOME,
                "RegionLinkingMode": "ALL_REGIONS",
                "Regions": [OTHER],
            },
        )
        for detail in drift_cases:
            def caller(
                arguments: list[str],
                profile: str | None,
                region: str,
                value=detail,
            ) -> dict:
                if arguments[1] == "list-finding-aggregators":
                    return {
                        "FindingAggregators": [
                            {"FindingAggregatorArn": AGGREGATOR_ARN}
                        ]
                    }
                return value

            with self.subTest(detail=detail), self.assertRaises(
                rollout.InventoryError
            ):
                rollout._finding_aggregator_state(
                    caller=caller, profile=None, home_region=HOME
                )

    def test_invalid_sts_identity_stops_before_regional_inventory(self) -> None:
        for identity in ({}, {"Account": 123}, {"Account": "invalid"}):
            with self.subTest(identity=identity), self.assertRaises(
                rollout.InventoryError
            ):
                rollout.build_plan(
                    stage="prod",
                    home_region=HOME,
                    home_stack_name="ian-photography-security-managed",
                    regional_stack_name="ian-photography-security-regional",
                    profile=None,
                    caller=lambda arguments, profile, region, value=identity: value,
                )

    def test_plan_covers_every_enabled_region_and_defers_to_existing_singletons(self) -> None:
        plan = build(responses())
        self.assertEqual(plan["enabledRegions"], [OTHER, HOME])
        self.assertEqual(len(plan["planDigest"]), 64)
        self.assertEqual(len(plan["templateDigest"]), 64)
        by_region = {item["region"]: item for item in plan["regionPlans"]}
        self.assertEqual(by_region[HOME]["guardDuty"], "skip-existing")
        self.assertEqual(by_region[HOME]["securityHub"], "skip-existing")
        self.assertEqual(
            by_region[OTHER]["guardDuty"], "create-confirmed-absent"
        )
        self.assertEqual(
            by_region[OTHER]["securityHub"], "create-confirmed-absent"
        )
        self.assertEqual(
            plan["findingAggregator"],
            "create-confirmed-absent-home-hub-enabled",
        )
        report = rollout.public_report(plan, prepare=False)
        self.assertEqual(report["accountId"], "verified")
        self.assertNotIn(ACCOUNT, str(report))
        self.assertFalse(report["executesChangeSets"])

    def test_existing_exact_all_regions_aggregator_is_not_adopted_or_changed(self) -> None:
        plan = build(responses(aggregator="valid"))
        self.assertEqual(
            plan["findingAggregator"], "skip-existing-all-regions"
        )

    def test_drifted_aggregator_and_incomplete_region_inventory_fail_closed(self) -> None:
        with self.assertRaises(rollout.InventoryError):
            build(responses(aggregator="drifted"))

        values = responses()

        def denied(arguments: list[str], profile: str | None, region: str) -> dict:
            if region == OTHER and arguments[:2] == ["guardduty", "list-detectors"]:
                raise AwsCallError("guardduty", "list-detectors", "AccessDenied")
            return values[(region, arguments[0], arguments[1])]

        with self.assertRaises(rollout.InventoryError):
            rollout.build_plan(
                stage="prod",
                home_region=HOME,
                home_stack_name="ian-photography-security-managed",
                regional_stack_name="ian-photography-security-regional",
                profile=None,
                caller=denied,
            )

    def test_home_hub_must_exist_before_aggregator_is_planned(self) -> None:
        values = responses()
        values[(HOME, "securityhub", "describe-hub")] = {}
        plan = build(values)
        self.assertEqual(
            plan["findingAggregator"], "defer-until-home-hub-enabled"
        )

    def test_existing_aggregator_blocks_unreviewed_home_stack_mutation(self) -> None:
        values = responses(aggregator="valid")
        values[(HOME, "guardduty", "list-detectors")] = {"DetectorIds": []}
        plan = build(values)
        calls: list[list[str]] = []
        with self.assertRaises(rollout.InventoryError):
            rollout.prepare_change_sets(
                plan=plan,
                profile=None,
                caller=caller_for(values),
                mutator=lambda arguments, profile, region: calls.append(arguments) or {},
            )
        self.assertEqual(calls, [])

    def test_prepare_guards_bind_account_home_region_count_and_digest(self) -> None:
        plan = build(responses())
        rollout.validate_prepare_guards(
            prepare=True,
            plan=plan,
            expected_account_id=ACCOUNT,
            expected_home_region=HOME,
            expected_plan_digest=plan["planDigest"],
            expected_enabled_region_count=2,
            confirmation=rollout.CONFIRMATION,
        )
        for overrides in (
            {"expected_account_id": "999999999999"},
            {"expected_home_region": OTHER},
            {"expected_plan_digest": "0" * 64},
            {"expected_enabled_region_count": 3},
            {"confirmation": "wrong"},
        ):
            arguments = {
                "prepare": True,
                "plan": plan,
                "expected_account_id": ACCOUNT,
                "expected_home_region": HOME,
                "expected_plan_digest": plan["planDigest"],
                "expected_enabled_region_count": 2,
                "confirmation": rollout.CONFIRMATION,
            }
            arguments.update(overrides)
            with self.assertRaises(SystemExit):
                rollout.validate_prepare_guards(**arguments)
        rollout.validate_prepare_guards(
            prepare=False,
            plan=plan,
            expected_account_id=None,
            expected_home_region=None,
            expected_plan_digest=None,
            expected_enabled_region_count=None,
            confirmation=None,
        )

    def test_stack_inventory_and_home_ownership_guards_fail_closed(self) -> None:
        plan = build(responses())

        def error_caller(message: str):
            def caller(
                arguments: list[str], profile: str | None, region: str
            ) -> dict:
                raise AwsCallError("cloudformation", "describe-stacks", message)

            return caller

        with self.assertRaises(rollout.InventoryError):
            rollout._stack(
                caller=error_caller("AccessDenied"),
                profile=None,
                region=HOME,
                stack_name="ian-photography-security-managed",
            )
        for malformed in ({}, {"Stacks": []}, {"Stacks": [None]}):
            with self.subTest(malformed=malformed), self.assertRaises(
                rollout.InventoryError
            ):
                rollout._stack(
                    caller=lambda arguments, profile, region, value=malformed: value,
                    profile=None,
                    region=HOME,
                    stack_name="ian-photography-security-managed",
                )

        failures = (
            error_caller("Stack does not exist"),
            lambda arguments, profile, region: home_stack(StackStatus="UPDATE_IN_PROGRESS"),
            lambda arguments, profile, region: home_stack(
                EnableTerminationProtection=False
            ),
            lambda arguments, profile, region: home_stack(StackId="arn:wrong"),
            lambda arguments, profile, region: home_stack(
                Parameters=[{"ParameterKey": "Stage", "ParameterValue": "dev"}]
            ),
        )
        for caller in failures:
            with self.subTest(caller=caller), self.assertRaises(
                rollout.InventoryError
            ):
                rollout._preflight_stacks(
                    plan=plan, profile=None, caller=caller
                )

    def test_noop_plan_and_parameter_rendering_cover_safe_skip_paths(self) -> None:
        values = responses(aggregator="valid")
        values[(OTHER, "guardduty", "list-detectors")] = {
            "DetectorIds": ["existing"]
        }
        values[(OTHER, "guardduty", "get-detector")] = {
            "Status": "ENABLED",
            "Features": GUARDDUTY_FEATURES,
        }
        values[(OTHER, "securityhub", "describe-hub")] = {
            "HubArn": "arn:other-hub",
            "ControlFindingGenerator": "SECURITY_CONTROL",
        }
        values[(OTHER, "securityhub", "get-enabled-standards")] = {
            "StandardsSubscriptions": []
        }
        plan = build(values)
        prepared = rollout.prepare_change_sets(
            plan=plan,
            profile=None,
            caller=lambda arguments, profile, region: self.fail(
                "a no-op plan must not inspect stacks"
            ),
            mutator=lambda arguments, profile, region: self.fail(
                "a no-op plan must not create change sets"
            ),
        )
        self.assertEqual(prepared, [])

        item = next(value for value in plan["regionPlans"] if value["region"] == HOME)
        home_parameters = rollout._home_parameters(plan, item)
        self.assertIn(
            "ParameterKey=SecurityHubAggregationMode,ParameterValue=skip",
            home_parameters,
        )
        regional_parameters = rollout._regional_parameters(
            plan,
            {
                "region": OTHER,
                "guardDuty": "skip-existing",
                "securityHub": "create-confirmed-absent",
            },
        )
        self.assertIn(
            "ParameterKey=GuardDutyDeploymentMode,ParameterValue=skip",
            regional_parameters,
        )
        self.assertIn(
            "ParameterKey=SecurityHubDeploymentMode,ParameterValue=create-confirmed-absent",
            regional_parameters,
        )
        for arguments in (
            {"key": "Example"},
            {"key": "Example", "value": "x", "previous": True},
        ):
            with self.assertRaises(ValueError):
                rollout._parameter(**arguments)

    def test_stale_template_digest_blocks_before_stack_or_change_set_calls(self) -> None:
        plan = build(responses())
        plan["templateDigest"] = "0" * 64
        calls: list[list[str]] = []
        with self.assertRaises(rollout.InventoryError):
            rollout.prepare_change_sets(
                plan=plan,
                profile=None,
                caller=lambda arguments, profile, region: calls.append(arguments) or {},
                mutator=lambda arguments, profile, region: calls.append(arguments) or {},
            )
        self.assertEqual(calls, [])

    def test_prepare_creates_review_only_home_update_and_regional_create(self) -> None:
        plan = build(responses())
        values = responses()
        values[(HOME, "cloudformation", "describe-stacks")] = {
            "Stacks": [
                {
                    "StackId": (
                        f"arn:aws:cloudformation:{HOME}:{ACCOUNT}:stack/"
                        "ian-photography-security-managed/"
                        "00000000-0000-4000-8000-000000000000"
                    ),
                    "StackStatus": "UPDATE_COMPLETE",
                    "EnableTerminationProtection": True,
                    "Parameters": [
                        {"ParameterKey": "Stage", "ParameterValue": "prod"}
                    ],
                }
            ]
        }

        calls: list[tuple[str, list[str]]] = []

        def caller(arguments: list[str], profile: str | None, region: str) -> dict:
            if arguments[:2] == ["cloudformation", "describe-stacks"]:
                if region == OTHER:
                    raise AwsCallError(
                        "cloudformation",
                        "describe-stacks",
                        "Stack with id ian-photography-security-regional does not exist",
                    )
                return values[(region, arguments[0], arguments[1])]
            return values[(region, arguments[0], arguments[1])]

        def mutator(arguments: list[str], profile: str | None, region: str) -> dict:
            calls.append((region, arguments))
            return {"Id": "not-printed"}

        prepared = rollout.prepare_change_sets(
            plan=plan,
            profile=None,
            caller=caller,
            mutator=mutator,
        )
        self.assertEqual(len(prepared), 2)
        self.assertEqual({item["changeSetType"] for item in prepared}, {"CREATE", "UPDATE"})
        flattened = " ".join(value for _, call in calls for value in call)
        self.assertIn("ParameterKey=ExpectedAccountId,ParameterValue=" + ACCOUNT, flattened)
        self.assertIn("ParameterKey=ExpectedRegion,ParameterValue=" + HOME, flattened)
        self.assertIn("ParameterKey=ExpectedRegion,ParameterValue=" + OTHER, flattened)
        self.assertIn(
            "ParameterKey=SecurityHubAggregationMode,ParameterValue="
            "create-confirmed-absent-home-hub-enabled",
            flattened,
        )
        self.assertNotIn("execute-change-set", flattened)

    def test_existing_regional_stack_blocks_preparation_before_any_mutation(self) -> None:
        plan = build(responses())
        values = responses()
        stack = {
            "Stacks": [
                {
                    "StackId": (
                        f"arn:aws:cloudformation:{HOME}:{ACCOUNT}:stack/"
                        "ian-photography-security-managed/"
                        "00000000-0000-4000-8000-000000000000"
                    ),
                    "StackStatus": "UPDATE_COMPLETE",
                    "EnableTerminationProtection": True,
                    "Parameters": [
                        {"ParameterKey": "Stage", "ParameterValue": "prod"}
                    ],
                }
            ]
        }
        calls: list[list[str]] = []

        def caller(arguments: list[str], profile: str | None, region: str) -> dict:
            if arguments[:2] == ["cloudformation", "describe-stacks"]:
                return stack
            return values[(region, arguments[0], arguments[1])]

        with self.assertRaises(rollout.InventoryError):
            rollout.prepare_change_sets(
                plan=plan,
                profile=None,
                caller=caller,
                mutator=lambda arguments, profile, region: calls.append(arguments) or {},
            )
        self.assertEqual(calls, [])

    def test_cli_parsing_and_main_dry_run_and_prepare_contracts(self) -> None:
        with patch.object(sys, "argv", ["regional-security"]):
            defaults = rollout.parse_args()
        self.assertEqual(defaults.home_region, HOME)
        self.assertFalse(defaults.prepare_change_sets)

        plan = build(responses())
        base = {
            "stage": "prod",
            "home_region": HOME,
            "home_stack_name": "ian-photography-security-managed",
            "regional_stack_name": "ian-photography-security-regional",
            "profile": None,
            "prepare_change_sets": False,
            "expected_account_id": None,
            "expected_home_region": None,
            "expected_plan_digest": None,
            "expected_enabled_region_count": None,
            "confirm": None,
        }
        with patch.object(
            rollout, "parse_args", return_value=SimpleNamespace(**base)
        ), patch.object(rollout, "build_plan", return_value=plan), redirect_stdout(
            StringIO()
        ) as output:
            self.assertEqual(rollout.main(), 0)
        self.assertEqual(json.loads(output.getvalue())["mode"], "dry-run")

        prepared_args = {
            **base,
            "prepare_change_sets": True,
            "expected_account_id": ACCOUNT,
            "expected_home_region": HOME,
            "expected_plan_digest": plan["planDigest"],
            "expected_enabled_region_count": 2,
            "confirm": rollout.CONFIRMATION,
        }
        with patch.object(
            rollout, "parse_args", return_value=SimpleNamespace(**prepared_args)
        ), patch.object(rollout, "build_plan", return_value=plan), patch.object(
            rollout,
            "prepare_change_sets",
            return_value=[
                {
                    "region": HOME,
                    "stackName": "ian-photography-security-managed",
                    "changeSetName": "review",
                    "changeSetType": "UPDATE",
                }
            ],
        ), redirect_stdout(StringIO()) as output:
            self.assertEqual(rollout.main(), 0)
        self.assertIn("prepare-change-sets", output.getvalue())
        self.assertIn("change-sets-prepared-not-executed", output.getvalue())

    def test_main_rejects_each_invalid_operator_scope_argument(self) -> None:
        base = {
            "stage": "prod",
            "home_region": HOME,
            "home_stack_name": "ian-photography-security-managed",
            "regional_stack_name": "ian-photography-security-regional",
            "profile": None,
            "prepare_change_sets": False,
            "expected_account_id": None,
            "expected_home_region": None,
            "expected_plan_digest": None,
            "expected_enabled_region_count": None,
            "confirm": None,
        }
        for key, value in (
            ("stage", "INVALID"),
            ("home_region", "invalid"),
            ("home_stack_name", "invalid_name"),
            ("regional_stack_name", "invalid_name"),
        ):
            arguments = {**base, key: value}
            with self.subTest(key=key), patch.object(
                rollout, "parse_args", return_value=SimpleNamespace(**arguments)
            ), self.assertRaises(SystemExit):
                rollout.main()


if __name__ == "__main__":
    unittest.main()
