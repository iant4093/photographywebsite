import contextlib
import copy
import io
import json
import pathlib
import subprocess
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
if str(OPS) not in sys.path:
    sys.path.insert(0, str(OPS))

from ci import regional_security_posture as posture  # noqa: E402
import regional_security_rollout as rollout  # noqa: E402


ACCOUNT = "123456789012"
HOME = "us-west-2"
SATELLITE = "us-east-2"
STACK_NAME = "ian-photography-security-regional"


def detector():
    return {
        "Status": "ENABLED",
        "FindingPublishingFrequency": "FIFTEEN_MINUTES",
        "Tags": copy.deepcopy(posture.EXPECTED_TAGS),
        "Features": [
            {"Name": name, "Status": state}
            for name, state in rollout.EXPECTED_GUARDDUTY_FEATURES.items()
        ],
    }


def hub(region):
    return {
        "HubArn": f"arn:aws:securityhub:{region}:{ACCOUNT}:hub/default",
        "ControlFindingGenerator": "SECURITY_CONTROL",
    }


def standards(region):
    if region != HOME:
        return {"StandardsSubscriptions": []}
    return {
        "StandardsSubscriptions": [
            {
                "StandardsArn": (
                    f"arn:aws:securityhub:{region}::standards/"
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
    }


def satellite_stack():
    values = {
        "AccessAnalyzerDeploymentMode": "skip",
        "ConfigDeploymentMode": "skip",
        "ExpectedAccountId": ACCOUNT,
        "ExpectedRegion": SATELLITE,
        "GlobalResourceRecordingMode": "skip",
        "GuardDutyDeploymentMode": "create-confirmed-absent",
        "SecurityHubAggregationMode": "skip",
        "SecurityHubDeploymentMode": "create-confirmed-absent",
        "SecurityHubHomeHubState": "unverified",
        "SecurityHubHomeRegion": HOME,
        "Stage": "prod",
    }
    return {
        "Stacks": [
            {
                "StackId": (
                    f"arn:aws:cloudformation:{SATELLITE}:{ACCOUNT}:"
                    f"stack/{STACK_NAME}/00000000-0000-0000-0000-000000000000"
                ),
                "StackStatus": "CREATE_COMPLETE",
                "EnableTerminationProtection": True,
                "Parameters": [
                    {"ParameterKey": key, "ParameterValue": value}
                    for key, value in values.items()
                ],
            }
        ]
    }


def satellite_resources():
    return {
        "StackResourceSummaries": [
            {
                "LogicalResourceId": logical_id,
                "ResourceType": resource_type,
                "ResourceStatus": "CREATE_COMPLETE",
            }
            for logical_id, resource_type in posture.EXPECTED_SATELLITE_RESOURCES.items()
        ]
    }


def valid_responses():
    responses = {}
    responses[(HOME, "ec2", "describe-regions")] = {
        "Regions": [
            {"RegionName": HOME, "OptInStatus": "opt-in-not-required"},
            {"RegionName": SATELLITE, "OptInStatus": "opt-in-not-required"},
        ]
    }
    for region in (HOME, SATELLITE):
        responses[(region, "guardduty", "list-detectors")] = {
            "DetectorIds": ["detector-id"]
        }
        responses[(region, "guardduty", "get-detector")] = detector()
        responses[(region, "securityhub", "describe-hub")] = hub(region)
        responses[(region, "securityhub", "list-tags-for-resource")] = {
            "Tags": copy.deepcopy(posture.EXPECTED_TAGS)
        }
        responses[(region, "securityhub", "get-enabled-standards")] = standards(
            region
        )
    responses[(SATELLITE, "cloudformation", "describe-stacks")] = satellite_stack()
    responses[(SATELLITE, "cloudformation", "list-stack-resources")] = (
        satellite_resources()
    )
    aggregator_arn = (
        f"arn:aws:securityhub:{HOME}:{ACCOUNT}:"
        "finding-aggregator/00000000-0000-0000-0000-000000000000"
    )
    responses[(HOME, "securityhub", "list-finding-aggregators")] = {
        "FindingAggregators": [{"FindingAggregatorArn": aggregator_arn}]
    }
    responses[(HOME, "securityhub", "get-finding-aggregator")] = {
        "FindingAggregationRegion": HOME,
        "RegionLinkingMode": "ALL_REGIONS",
        "Regions": [],
    }
    return responses


class Caller:
    def __init__(self, responses=None):
        self.responses = responses or valid_responses()
        self.calls = []

    def __call__(self, arguments, profile, region):
        self.calls.append((tuple(arguments), profile, region))
        key = (region, arguments[0], arguments[1])
        if key not in self.responses:
            raise AssertionError(f"unexpected call: {key}")
        return copy.deepcopy(self.responses[key])


class RegionalSecurityPostureTests(unittest.TestCase):
    def audit(self, responses=None):
        caller = Caller(responses)
        report = posture.audit(
            home_region=HOME,
            satellite_stack_name=STACK_NAME,
            caller=caller,
        )
        return report, caller

    def test_complete_exact_posture_returns_aggregate_counts_only(self):
        report, caller = self.audit()
        self.assertEqual(
            report,
            {
                "detectorCount": 2,
                "enabledRegionCount": 2,
                "findingAggregatorCount": 1,
                "homeStandardCount": 2,
                "satelliteStandardCount": 0,
                "satelliteStackCount": 1,
                "securityHubCount": 2,
                "status": "IN_SYNC",
            },
        )
        encoded = json.dumps(report)
        for forbidden in (ACCOUNT, "detector-id", STACK_NAME, "arn:aws"):
            self.assertNotIn(forbidden, encoded)
        services = {(call[0][0], call[0][1]) for call in caller.calls}
        self.assertIn(("guardduty", "get-detector"), services)
        self.assertIn(("securityhub", "get-enabled-standards"), services)
        self.assertIn(("cloudformation", "describe-stacks"), services)

    def test_detector_contract_rejects_singletons_features_frequency_status_and_tags(self):
        mutations = []
        missing = valid_responses()
        missing[(SATELLITE, "guardduty", "list-detectors")]["DetectorIds"] = []
        mutations.append(missing)
        duplicate = valid_responses()
        duplicate[(HOME, "guardduty", "list-detectors")]["DetectorIds"].append(
            "other"
        )
        mutations.append(duplicate)
        disabled = valid_responses()
        disabled[(HOME, "guardduty", "get-detector")]["Status"] = "DISABLED"
        mutations.append(disabled)
        frequency = valid_responses()
        frequency[(HOME, "guardduty", "get-detector")][
            "FindingPublishingFrequency"
        ] = "ONE_HOUR"
        mutations.append(frequency)
        tags = valid_responses()
        tags[(SATELLITE, "guardduty", "get-detector")]["Tags"]["Unexpected"] = (
            "value"
        )
        mutations.append(tags)
        feature = valid_responses()
        feature[(HOME, "guardduty", "get-detector")]["Features"][0][
            "Status"
        ] = "DISABLED"
        mutations.append(feature)
        duplicate_feature = valid_responses()
        duplicate_feature[(HOME, "guardduty", "get-detector")]["Features"].append(
            copy.deepcopy(
                duplicate_feature[(HOME, "guardduty", "get-detector")][
                    "Features"
                ][0]
            )
        )
        mutations.append(duplicate_feature)
        for responses in mutations:
            with self.subTest(case=len(responses)), self.assertRaises(
                posture.PostureError
            ):
                self.audit(responses)

    def test_hub_and_standard_contract_rejects_drift(self):
        mutations = []
        generator = valid_responses()
        generator[(HOME, "securityhub", "describe-hub")][
            "ControlFindingGenerator"
        ] = "STANDARD_CONTROL"
        mutations.append(generator)
        tags = valid_responses()
        tags[(SATELLITE, "securityhub", "list-tags-for-resource")]["Tags"] = {}
        mutations.append(tags)
        pending = valid_responses()
        pending[(HOME, "securityhub", "get-enabled-standards")][
            "StandardsSubscriptions"
        ][0]["StandardsStatus"] = "PENDING"
        mutations.append(pending)
        satellite_standard = valid_responses()
        satellite_standard[(SATELLITE, "securityhub", "get-enabled-standards")][
            "StandardsSubscriptions"
        ] = copy.deepcopy(
            satellite_standard[(HOME, "securityhub", "get-enabled-standards")][
                "StandardsSubscriptions"
            ][:1]
        )
        mutations.append(satellite_standard)
        extra = valid_responses()
        extra[(HOME, "securityhub", "get-enabled-standards")][
            "StandardsSubscriptions"
        ].append(
            {
                "StandardsArn": (
                    f"arn:aws:securityhub:{HOME}::standards/pci-dss/v/3.2.1"
                ),
                "StandardsStatus": "READY",
            }
        )
        mutations.append(extra)
        for responses in mutations:
            with self.subTest(case=len(responses)), self.assertRaises(
                posture.PostureError
            ):
                self.audit(responses)

    def test_satellite_stack_governance_and_exact_ownership_fail_closed(self):
        mutations = []
        unprotected = valid_responses()
        unprotected[(SATELLITE, "cloudformation", "describe-stacks")]["Stacks"][
            0
        ]["EnableTerminationProtection"] = False
        mutations.append(unprotected)
        wrong_account = valid_responses()
        wrong_account[(SATELLITE, "cloudformation", "describe-stacks")]["Stacks"][
            0
        ]["StackId"] = wrong_account[(SATELLITE, "cloudformation", "describe-stacks")][
            "Stacks"
        ][0]["StackId"].replace(ACCOUNT, "999999999999")
        mutations.append(wrong_account)
        wrong_parameter = valid_responses()
        wrong_parameter[(SATELLITE, "cloudformation", "describe-stacks")]["Stacks"][
            0
        ]["Parameters"][0]["ParameterValue"] = "create-confirmed-absent"
        mutations.append(wrong_parameter)
        extra_resource = valid_responses()
        extra_resource[(SATELLITE, "cloudformation", "list-stack-resources")][
            "StackResourceSummaries"
        ].append(
            {
                "LogicalResourceId": "UnexpectedResource",
                "ResourceType": "AWS::SNS::Topic",
                "ResourceStatus": "CREATE_COMPLETE",
            }
        )
        mutations.append(extra_resource)
        bad_status = valid_responses()
        bad_status[(SATELLITE, "cloudformation", "list-stack-resources")][
            "StackResourceSummaries"
        ][0]["ResourceStatus"] = "UPDATE_ROLLBACK_COMPLETE"
        mutations.append(bad_status)
        for responses in mutations:
            with self.subTest(case=len(responses)), self.assertRaises(
                posture.PostureError
            ):
                self.audit(responses)

    def test_aggregator_account_and_linking_contract_fail_closed(self):
        missing = valid_responses()
        missing[(HOME, "securityhub", "list-finding-aggregators")][
            "FindingAggregators"
        ] = []
        wrong_mode = valid_responses()
        wrong_mode[(HOME, "securityhub", "get-finding-aggregator")][
            "RegionLinkingMode"
        ] = "SPECIFIED_REGIONS"
        wrong_mode[(HOME, "securityhub", "get-finding-aggregator")]["Regions"] = [
            SATELLITE
        ]
        for responses in (missing, wrong_mode):
            with self.assertRaises(posture.PostureError):
                self.audit(responses)

    def test_inputs_provider_failures_and_cli_errors_are_privacy_safe(self):
        for home, stack in (("invalid region", STACK_NAME), (HOME, "bad/name")):
            with self.subTest(home=home, stack=stack), self.assertRaises(
                posture.PostureError
            ):
                posture.audit(home_region=home, satellite_stack_name=stack, caller=Caller())

        completed = subprocess.CompletedProcess(
            args=["aws"], returncode=1, stdout="", stderr="SECRET provider detail"
        )
        with mock.patch.object(subprocess, "run", return_value=completed):
            with self.assertRaises(posture.PostureError) as context:
                posture.aws_call(["guardduty", "list-detectors"], None, HOME)
        self.assertNotIn("SECRET", str(context.exception))

        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(
            posture, "audit", side_effect=posture.PostureError("SECRET provider detail")
        ), mock.patch.object(
            sys,
            "argv",
            [
                "regional_security_posture.py",
                "--home-region",
                HOME,
                "--satellite-stack-name",
                STACK_NAME,
            ],
        ), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(posture.main(), 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(
            stderr.getvalue(), "Regional security posture could not be verified.\n"
        )
        self.assertNotIn("SECRET", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
