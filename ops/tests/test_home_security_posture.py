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

from ci import home_security_posture as posture  # noqa: E402


ACCOUNT = "123456789012"
REGION = "us-west-2"


def detector():
    return {
        "Status": "ENABLED",
        "FindingPublishingFrequency": "FIFTEEN_MINUTES",
        "Tags": {
            **posture.EXPECTED_TAGS,
            "aws:cloudformation:stack-name": "managed-by-provider",
        },
        "Features": [
            {"Name": name, "Status": state}
            for name, state in posture.EXPECTED_GUARDDUTY_FEATURES.items()
        ],
    }


def hub():
    return {
        "HubArn": f"arn:aws:securityhub:{REGION}:{ACCOUNT}:hub/default",
        "ControlFindingGenerator": "SECURITY_CONTROL",
    }


def standards():
    return {
        "StandardsSubscriptions": [
            {
                "StandardsArn": (
                    f"arn:aws:securityhub:{REGION}::standards/"
                    "aws-foundational-security-best-practices/v/1.0.0"
                ),
                "StandardsControlsUpdatable": "READY_FOR_UPDATES",
                "StandardsStatus": "READY",
            },
            {
                "StandardsArn": (
                    "arn:aws:securityhub:::ruleset/"
                    "cis-aws-foundations-benchmark/v/1.2.0"
                ),
                "StandardsControlsUpdatable": "READY_FOR_UPDATES",
                "StandardsStatus": "READY",
            },
        ]
    }


def valid_responses():
    return {
        ("guardduty", "list-detectors"): {"DetectorIds": ["detector-id"]},
        ("guardduty", "get-detector"): detector(),
        ("securityhub", "describe-hub"): hub(),
        ("securityhub", "list-tags-for-resource"): {
            "Tags": {
                **posture.EXPECTED_TAGS,
                "aws:cloudformation:logical-id": "SecurityHub",
            }
        },
        ("securityhub", "get-enabled-standards"): standards(),
    }


class Caller:
    def __init__(self, responses=None):
        self.responses = responses or valid_responses()
        self.calls = []

    def __call__(self, arguments, profile, region):
        self.calls.append((tuple(arguments), profile, region))
        key = (arguments[0], arguments[1])
        if key not in self.responses:
            raise AssertionError(f"unexpected call: {key}")
        return copy.deepcopy(self.responses[key])


class HomeSecurityPostureTests(unittest.TestCase):
    def audit(self, responses=None):
        caller = Caller(responses)
        report = posture.audit(region=REGION, caller=caller)
        return report, caller

    def test_exact_posture_returns_aggregate_counts_only_and_allows_system_tags(self):
        report, caller = self.audit()
        self.assertEqual(
            report,
            {
                "detectorCount": 1,
                "providerTransitionCount": 0,
                "securityHubCount": 1,
                "standardCount": 2,
                "status": "IN_SYNC",
            },
        )
        encoded = json.dumps(report)
        for forbidden in (ACCOUNT, REGION, "detector-id", "arn:aws", "managed-by"):
            self.assertNotIn(forbidden, encoded)
        services = {(call[0][0], call[0][1]) for call in caller.calls}
        self.assertEqual(
            services,
            {
                ("guardduty", "list-detectors"),
                ("guardduty", "get-detector"),
                ("securityhub", "describe-hub"),
                ("securityhub", "list-tags-for-resource"),
                ("securityhub", "get-enabled-standards"),
            },
        )

    def test_detector_contract_fails_closed(self):
        mutations = []
        for detector_ids in ([], ["one", "two"], [None]):
            responses = valid_responses()
            responses[("guardduty", "list-detectors")]["DetectorIds"] = detector_ids
            mutations.append(responses)
        for key, value in (
            ("Status", "DISABLED"),
            ("FindingPublishingFrequency", "ONE_HOUR"),
            ("Tags", {"Application": posture.EXPECTED_TAGS["Application"]}),
        ):
            responses = valid_responses()
            responses[("guardduty", "get-detector")][key] = value
            mutations.append(responses)
        feature = valid_responses()
        feature[("guardduty", "get-detector")]["Features"][0]["Status"] = "DISABLED"
        mutations.append(feature)
        duplicate = valid_responses()
        duplicate[("guardduty", "get-detector")]["Features"].append(
            copy.deepcopy(duplicate[("guardduty", "get-detector")]["Features"][0])
        )
        mutations.append(duplicate)
        extra = valid_responses()
        extra[("guardduty", "get-detector")]["Features"].append(
            {"Name": "UNREVIEWED_FEATURE", "Status": "DISABLED"}
        )
        mutations.append(extra)
        for index, responses in enumerate(mutations):
            with self.subTest(index=index), self.assertRaises(posture.PostureError):
                self.audit(responses)

    def test_hub_and_standard_contract_fails_closed(self):
        mutations = []
        for key, value in (
            ("HubArn", None),
            ("ControlFindingGenerator", "STANDARD_CONTROL"),
        ):
            responses = valid_responses()
            responses[("securityhub", "describe-hub")][key] = value
            mutations.append(responses)
        wrong_region = valid_responses()
        wrong_region[("securityhub", "describe-hub")]["HubArn"] = (
            f"arn:aws:securityhub:us-east-1:{ACCOUNT}:hub/default"
        )
        mutations.append(wrong_region)
        tags = valid_responses()
        tags[("securityhub", "list-tags-for-resource")]["Tags"].pop("Stage")
        mutations.append(tags)
        incomplete = valid_responses()
        incomplete[("securityhub", "get-enabled-standards")]["StandardsSubscriptions"][0][
            "StandardsStatus"
        ] = "INCOMPLETE"
        mutations.append(incomplete)
        nonupdatable = valid_responses()
        nonupdatable[("securityhub", "get-enabled-standards")]["StandardsSubscriptions"][0][
            "StandardsControlsUpdatable"
        ] = "NOT_READY_FOR_UPDATES"
        mutations.append(nonupdatable)
        reason = valid_responses()
        reason[("securityhub", "get-enabled-standards")]["StandardsSubscriptions"][0][
            "StandardsStatusReason"
        ] = {"StatusReasonCode": "INTERNAL_ERROR"}
        mutations.append(reason)
        missing = valid_responses()
        missing[("securityhub", "get-enabled-standards")]["StandardsSubscriptions"].pop()
        mutations.append(missing)
        extra = valid_responses()
        extra[("securityhub", "get-enabled-standards")]["StandardsSubscriptions"].append(
            {
                "StandardsArn": (
                    f"arn:aws:securityhub:{REGION}::standards/pci-dss/v/3.2.1"
                ),
                "StandardsControlsUpdatable": "READY_FOR_UPDATES",
                "StandardsStatus": "READY",
            }
        )
        mutations.append(extra)
        duplicate = valid_responses()
        duplicate[("securityhub", "get-enabled-standards")]["StandardsSubscriptions"].append(
            copy.deepcopy(
                duplicate[("securityhub", "get-enabled-standards")][
                    "StandardsSubscriptions"
                ][0]
            )
        )
        mutations.append(duplicate)
        for index, responses in enumerate(mutations):
            with self.subTest(index=index), self.assertRaises(posture.PostureError):
                self.audit(responses)

    def test_invalid_inputs_provider_failures_and_cli_errors_are_privacy_safe(self):
        with self.assertRaises(posture.PostureError):
            posture.audit(region="invalid region", caller=Caller())

        completed = subprocess.CompletedProcess(
            args=["aws"], returncode=1, stdout="", stderr="SECRET provider detail"
        )
        with mock.patch.object(subprocess, "run", return_value=completed):
            with self.assertRaises(posture.PostureError) as context:
                posture.aws_call(["guardduty", "list-detectors"], None, REGION)
        self.assertNotIn("SECRET", str(context.exception))

        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(
            posture, "audit", side_effect=posture.PostureError("SECRET provider detail")
        ), mock.patch.object(
            sys,
            "argv",
            ["home_security_posture.py", "--region", REGION],
        ), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(posture.main(), 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "Home security posture could not be verified.\n")
        self.assertNotIn("SECRET", stderr.getvalue())

    def test_provider_adapter_rejects_transport_and_malformed_responses(self):
        successful = subprocess.CompletedProcess(
            args=["aws"], returncode=0, stdout='{"DetectorIds":[]}', stderr=""
        )
        with mock.patch.object(subprocess, "run", return_value=successful) as run:
            self.assertEqual(
                posture.aws_call(
                    ["guardduty", "list-detectors"], "review-profile", REGION
                ),
                {"DetectorIds": []},
            )
        command = run.call_args.args[0]
        self.assertEqual(command[-2:], ["--profile", "review-profile"])

        for result in (
            subprocess.CompletedProcess(
                args=["aws"], returncode=0, stdout="not-json", stderr=""
            ),
            subprocess.CompletedProcess(
                args=["aws"], returncode=0, stdout="[]", stderr=""
            ),
        ):
            with mock.patch.object(subprocess, "run", return_value=result):
                with self.assertRaises(posture.PostureError):
                    posture.aws_call(["guardduty", "list-detectors"], None, REGION)

        with mock.patch.object(
            subprocess, "run", side_effect=subprocess.TimeoutExpired("aws", 30)
        ):
            with self.assertRaises(posture.PostureError):
                posture.aws_call(["guardduty", "list-detectors"], None, REGION)

        for caller in (
            lambda *_arguments: [],
            lambda *_arguments: (_ for _ in ()).throw(RuntimeError("private")),
        ):
            with self.assertRaises(posture.PostureError):
                posture.audit(region=REGION, caller=caller)

    def test_malformed_feature_and_standard_entries_fail_closed(self):
        mutations = []
        no_features = valid_responses()
        no_features[("guardduty", "get-detector")]["Features"] = None
        mutations.append(no_features)
        malformed_feature = valid_responses()
        malformed_feature[("guardduty", "get-detector")]["Features"][0] = None
        mutations.append(malformed_feature)
        malformed_standard_list = valid_responses()
        malformed_standard_list[("securityhub", "get-enabled-standards")][
            "StandardsSubscriptions"
        ] = None
        mutations.append(malformed_standard_list)
        malformed_standard = valid_responses()
        malformed_standard[("securityhub", "get-enabled-standards")][
            "StandardsSubscriptions"
        ][0] = None
        mutations.append(malformed_standard)
        out_of_scope_standard = valid_responses()
        out_of_scope_standard[("securityhub", "get-enabled-standards")][
            "StandardsSubscriptions"
        ][0]["StandardsArn"] = "arn:aws:securityhub:invalid"
        mutations.append(out_of_scope_standard)
        for index, responses in enumerate(mutations):
            with self.subTest(index=index), self.assertRaises(posture.PostureError):
                self.audit(responses)

    def test_cli_success_prints_only_aggregate_report(self):
        expected = {
            "detectorCount": 1,
            "providerTransitionCount": 0,
            "securityHubCount": 1,
            "standardCount": 2,
            "status": "IN_SYNC",
        }
        stdout = io.StringIO()
        with mock.patch.object(posture, "audit", return_value=expected), mock.patch.object(
            sys, "argv", ["home_security_posture.py", "--region", REGION]
        ), contextlib.redirect_stdout(stdout):
            self.assertEqual(posture.main(), 0)
        self.assertEqual(json.loads(stdout.getvalue()), expected)

    def test_provider_control_expansion_is_reported_only_when_still_updatable(self):
        responses = valid_responses()
        subscriptions = responses[("securityhub", "get-enabled-standards")][
            "StandardsSubscriptions"
        ]
        for subscription in subscriptions:
            subscription["StandardsStatus"] = "PENDING"
        report, _caller = self.audit(responses)
        self.assertEqual(report["providerTransitionCount"], 2)
        self.assertEqual(report["status"], "IN_SYNC")


if __name__ == "__main__":
    unittest.main()
