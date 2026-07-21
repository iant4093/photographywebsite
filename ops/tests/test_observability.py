from __future__ import annotations

import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
if str(OPS) not in sys.path:
    sys.path.insert(0, str(OPS))

import observability_preflight  # noqa: E402


TEMPLATE_PATH = OPS / "observability_template.yaml"
TEMPLATE = TEMPLATE_PATH.read_text(encoding="utf-8")
VALIDATOR = (OPS / "validate_infrastructure.sh").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github" / "workflows" / "_quality.yml").read_text(encoding="utf-8")
RUNBOOK = (OPS / "OBSERVABILITY.md").read_text(encoding="utf-8")
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

ACCOUNT = "123456789012"
FRONTEND = "ABCDEFGHIJKL1"
MEDIA = "ABCDEFGHIJKL2"
STACK = "ian-photography-observability"


def resource_block(logical_id: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(logical_id)}:\n(?P<body>.*?)(?=^  [A-Za-z][A-Za-z0-9]+:\n|^Outputs:)",
        TEMPLATE,
    )
    if not match:
        raise AssertionError(f"Missing resource {logical_id}")
    return match.group("body")


class ObservabilityTemplateTests(unittest.TestCase):
    def test_template_passes_cfn_lint(self):
        if not shutil.which("cfn-lint"):
            self.skipTest("cfn-lint is not installed")
        subprocess.run(
            ["cfn-lint", str(TEMPLATE_PATH)],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )

    def test_paid_cloudfront_singletons_are_exact_retained_and_preflighted(self):
        for logical_id, parameter in (
            ("FrontendMonitoringSubscription", "FrontendDistributionId"),
            ("MediaMonitoringSubscription", "MediaDistributionId"),
        ):
            block = resource_block(logical_id)
            self.assertIn("Type: AWS::CloudFront::MonitoringSubscription", block)
            self.assertIn("DeletionPolicy: Retain", block)
            self.assertIn("UpdateReplacePolicy: Retain", block)
            self.assertIn(f"DistributionId: !Ref {parameter}", block)
            self.assertIn("RealtimeMetricsSubscriptionStatus: Enabled", block)
        self.assertIn("DistributionIdsMustBeDistinct", TEMPLATE)
        self.assertIn("observability_preflight.py", RUNBOOK)
        self.assertIn("paid singleton", RUNBOOK)

    def test_unused_browser_and_synthetic_components_are_removed(self):
        for removed in (
            "AWS::RUM::",
            "AWS::Synthetics::",
            "AWS::Cognito::IdentityPool",
            "AWS::IAM::Role",
            "AWS::S3::Bucket",
            "RumAppMonitor",
            "PublicCanary",
            "CanaryArtifact",
        ):
            self.assertNotIn(removed, TEMPLATE)
        self.assertNotIn("aws-rum-web", PACKAGE["dependencies"])
        self.assertNotIn("@aws-rum/web-core", PACKAGE.get("overrides", {}))
        self.assertFalse((ROOT / "src" / "utils" / "rum.js").exists())
        self.assertFalse((ROOT / "src" / "utils" / "rum.test.js").exists())
        self.assertNotIn("VITE_RUM_", WORKFLOW)
        self.assertNotIn("initializeRum", (ROOT / "src" / "main.jsx").read_text())

    def test_dashboard_and_two_alarms_are_the_complete_edge_contract(self):
        self.assertIn("AllowedPattern: '^(|arn:(aws|aws-us-gov):sns:", TEMPLATE)
        self.assertEqual(TEMPLATE.count("AlarmActions: !If"), 2)
        resources = TEMPLATE.split("\nResources:\n", 1)[1].split("\nOutputs:\n", 1)[0]
        self.assertEqual(
            set(re.findall(r"(?m)^  ([A-Za-z][A-Za-z0-9]+):$", resources)),
            {
                "FrontendMonitoringSubscription",
                "MediaMonitoringSubscription",
                "FrontendFiveXxAlarm",
                "MediaFiveXxAlarm",
                "ObservabilityDashboard",
            },
        )
        dashboard = resource_block("ObservabilityDashboard")
        self.assertIn("AWS/CloudFront", dashboard)
        self.assertNotIn("AWS/RUM", dashboard)
        self.assertNotIn("CloudWatchSynthetics", dashboard)
        self.assertIn("  DashboardName:", TEMPLATE)
        self.assertIn("ReleaseSha", TEMPLATE)

    def test_validation_lists_and_release_identity_remain_complete(self):
        self.assertIn("VITE_RELEASE_SHA: ${{ github.sha }}", WORKFLOW)
        for source in (VALIDATOR, WORKFLOW):
            self.assertIn("ops/observability_template.yaml", source)
            self.assertIn("ops/waf_front_door_template.yaml", source)


class MonitoringSubscriptionTests(unittest.TestCase):
    def completed(self, *, code=0, stdout="", stderr=""):
        return Mock(returncode=code, stdout=stdout, stderr=stderr)

    def test_subscription_inventory_enabled_absent_profile_and_malformed(self):
        enabled = {
            "MonitoringSubscription": {
                "RealtimeMetricsSubscriptionConfig": {
                    "RealtimeMetricsSubscriptionStatus": "Enabled"
                }
            }
        }
        with patch.object(
            observability_preflight.subprocess,
            "run",
            return_value=self.completed(stdout=json.dumps(enabled)),
        ) as run:
            self.assertEqual(
                observability_preflight.monitoring_subscription(FRONTEND, "profile", "us-west-2"),
                enabled,
            )
        self.assertIn("--profile", run.call_args.args[0])
        self.assertIn("get-monitoring-subscription", run.call_args.args[0])

        for marker in observability_preflight.ABSENT_MARKERS:
            with self.subTest(marker=marker), patch.object(
                observability_preflight.subprocess,
                "run",
                return_value=self.completed(code=255, stderr=marker),
            ):
                self.assertIsNone(
                    observability_preflight.monitoring_subscription(FRONTEND, None, "us-west-2")
                )

        malformed = (
            self.completed(code=2, stderr="AccessDenied"),
            self.completed(stdout="not-json"),
            self.completed(stdout="[]"),
            self.completed(stdout="{}"),
        )
        for result in malformed:
            with self.subTest(result=result), patch.object(
                observability_preflight.subprocess, "run", return_value=result
            ), self.assertRaises(RuntimeError):
                observability_preflight.monitoring_subscription(FRONTEND, None, "us-west-2")

    def aws_for(self, *, owned=True, wrong_type=False):
        def aws(arguments, profile, region):
            if arguments[:2] == ["sts", "get-caller-identity"]:
                return {"Account": ACCOUNT}
            if arguments[:2] == ["cloudfront", "get-distribution"]:
                return {"Distribution": {"Id": arguments[-1]}}
            if arguments[:2] == ["cloudformation", "describe-stack-resource"]:
                logical_id = arguments[-1]
                distribution_id = FRONTEND if logical_id.startswith("Frontend") else MEDIA
                return {
                    "StackResourceDetail": {
                        "PhysicalResourceId": distribution_id if owned else "ABCDEFGHIJKL9",
                        "ResourceType": "Wrong" if wrong_type else "AWS::CloudFront::MonitoringSubscription",
                    }
                }
            raise AssertionError(arguments)

        return aws

    def base(self, **overrides):
        return {
            "deployment_mode": "create",
            "frontend_distribution_id": FRONTEND,
            "media_distribution_id": MEDIA,
            "expected_account_id": ACCOUNT,
            "stack_name": STACK,
            "region": "us-west-2",
            "profile": None,
            **overrides,
        }

    def test_create_requires_confirmed_absence_and_only_read_calls(self):
        with patch.object(
            observability_preflight, "aws_json", side_effect=self.aws_for()
        ) as aws, patch.object(
            observability_preflight, "monitoring_subscription", return_value=None
        ) as subscription:
            report = observability_preflight.validate_preflight(**self.base())
        self.assertEqual(report["monitoringSubscriptionOwnership"], "confirmed-absent")
        self.assertEqual(report["existingSubscriptionCount"], 0)
        self.assertEqual(subscription.call_count, 2)
        allowed = {"get-caller-identity", "get-distribution"}
        self.assertTrue(all(call.args[0][1] in allowed for call in aws.call_args_list))

        with patch.object(
            observability_preflight, "aws_json", side_effect=self.aws_for()
        ), patch.object(
            observability_preflight, "monitoring_subscription", side_effect=[{}, None]
        ), self.assertRaisesRegex(SystemExit, "already exists"):
            observability_preflight.validate_preflight(**self.base())

    def test_update_requires_enabled_exact_stack_owned_subscriptions(self):
        enabled = {
            "MonitoringSubscription": {
                "RealtimeMetricsSubscriptionConfig": {
                    "RealtimeMetricsSubscriptionStatus": "Enabled"
                }
            }
        }
        with patch.object(
            observability_preflight, "aws_json", side_effect=self.aws_for()
        ), patch.object(
            observability_preflight, "monitoring_subscription", return_value=enabled
        ):
            report = observability_preflight.validate_preflight(
                **self.base(deployment_mode="update")
            )
        self.assertEqual(report["monitoringSubscriptionOwnership"], "exact-stack-owned")
        self.assertEqual(report["existingSubscriptionCount"], 2)

        disabled = json.loads(json.dumps(enabled))
        disabled["MonitoringSubscription"]["RealtimeMetricsSubscriptionConfig"][
            "RealtimeMetricsSubscriptionStatus"
        ] = "Disabled"
        failure_cases = (
            ([enabled, None], self.aws_for(), "both exact"),
            ([disabled, enabled], self.aws_for(), "disabled"),
            ([enabled, enabled], self.aws_for(owned=False), "does not own"),
            ([enabled, enabled], self.aws_for(wrong_type=True), "unexpected resource type"),
        )
        for subscriptions, aws, message in failure_cases:
            with self.subTest(message=message), patch.object(
                observability_preflight, "aws_json", side_effect=aws
            ), patch.object(
                observability_preflight, "monitoring_subscription", side_effect=subscriptions
            ), self.assertRaisesRegex((SystemExit, RuntimeError), message):
                observability_preflight.validate_preflight(
                    **self.base(deployment_mode="update")
                )

    def test_input_and_account_guards_fail_before_subscription_inventory(self):
        invalid = (
            {"region": "us-east-1"},
            {"expected_account_id": "bad"},
            {"stack_name": "bad stack"},
            {"frontend_distribution_id": "bad"},
            {"media_distribution_id": FRONTEND},
            {"deployment_mode": "delete"},
        )
        for changes in invalid:
            with self.subTest(changes=changes), patch.object(
                observability_preflight, "aws_json"
            ) as aws, self.assertRaises(SystemExit):
                observability_preflight.validate_preflight(**self.base(**changes))
            aws.assert_not_called()

        with patch.object(
            observability_preflight, "aws_json", return_value={"Account": "999999999999"}
        ), patch.object(observability_preflight, "monitoring_subscription") as subscription, self.assertRaisesRegex(
            SystemExit, "active AWS account"
        ):
            observability_preflight.validate_preflight(**self.base())
        subscription.assert_not_called()

    def test_distribution_stack_resource_and_main_fail_closed(self):
        with patch.object(
            observability_preflight, "aws_json", return_value={"Distribution": {"Id": "wrong"}}
        ), self.assertRaises(RuntimeError):
            observability_preflight._validate_distribution(FRONTEND, None, "us-west-2")
        for detail in (
            {"ResourceType": "AWS::CloudFront::MonitoringSubscription"},
            {"ResourceType": "Wrong", "PhysicalResourceId": FRONTEND},
        ):
            with self.subTest(detail=detail), patch.object(
                observability_preflight, "aws_json", return_value={"StackResourceDetail": detail}
            ), self.assertRaises(RuntimeError):
                observability_preflight._stack_owned_distribution(STACK, "Logical", None, "us-west-2")

        with patch.object(
            observability_preflight,
            "validate_preflight",
            return_value={"deploymentMode": "create", "existingSubscriptionCount": 0},
        ) as validate, patch.object(
            sys,
            "argv",
            [
                observability_preflight.__file__,
                "--deployment-mode", "create",
                "--frontend-distribution-id", FRONTEND,
                "--media-distribution-id", MEDIA,
                "--expected-account-id", ACCOUNT,
            ],
        ), patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(observability_preflight.main(), 0)
        validate.assert_called_once()
        self.assertIn("Read-only preflight complete", output.getvalue())


if __name__ == "__main__":
    unittest.main()
