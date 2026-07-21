"""Tests for the guarded, subscriber-neutral AWS Budget baseline."""

from __future__ import annotations

from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
sys.path.insert(0, str(OPS))

import security_budget_preflight  # noqa: E402


TEMPLATE_PATH = OPS / "security_budget_template.yaml"
TEMPLATE = TEMPLATE_PATH.read_text(encoding="utf-8")


class SecurityBudgetTemplateTests(unittest.TestCase):
    def test_template_is_guarded_retained_and_uses_only_existing_sns(self) -> None:
        for expected in (
            "Type: AWS::Budgets::Budget",
            "Default: skip",
            "create-confirmed-absent",
            "ExpectedAccountMustMatch",
            "MustDeployInHomeRegion",
            "arn:${AWS::Partition}:sns:${AWS::Region}:${AWS::AccountId}:ian-photography-security-${Stage}",
            "MonthlyLimitUsd",
            "NotificationType: ACTUAL",
            "NotificationType: FORECASTED",
            "SubscriptionType: SNS",
            "DeletionPolicy: RetainExceptOnCreate",
            "UpdateReplacePolicy: Retain",
        ):
            self.assertIn(expected, TEMPLATE)
        for forbidden in (
            "AWS::SNS::Topic",
            "AWS::SNS::Subscription",
            "SubscriptionType: EMAIL",
            "NotificationEmail",
            "@example",
        ):
            self.assertNotIn(forbidden, TEMPLATE)

    def test_template_passes_cfn_lint(self) -> None:
        if not shutil.which("cfn-lint"):
            self.skipTest("cfn-lint is not installed")
        subprocess.run(
            ["cfn-lint", str(TEMPLATE_PATH)],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )


class SecurityBudgetPreflightTests(unittest.TestCase):
    account = "123456789012"
    topic = "arn:aws:sns:us-west-2:123456789012:ian-photography-security-prod"

    def caller(self, *, budget_exists=False, confirmed=2, topic_exists=True):
        def fake(arguments, profile, region):
            operation = tuple(arguments[:2])
            if operation == ("sts", "get-caller-identity"):
                return {"Account": self.account}
            if operation == ("sns", "list-topics"):
                return {"Topics": [{"TopicArn": self.topic}] if topic_exists else []}
            if operation == ("sns", "list-subscriptions-by-topic"):
                return {
                    "Subscriptions": [
                        {
                            "SubscriptionArn": f"arn:subscription:{index}",
                            "Protocol": "email",
                            "Endpoint": f"must-never-enter-output-{index}@example.invalid",
                        }
                        for index in range(confirmed)
                    ]
                }
            if operation == ("budgets", "describe-budgets"):
                return {
                    "Budgets": [
                        {"BudgetName": "ian-photography-monthly-prod"}
                    ]
                    if budget_exists
                    else []
                }
            raise AssertionError(arguments)

        return fake

    def run_inventory(self, caller):
        return security_budget_preflight.inventory(
            stage="prod",
            region="us-west-2",
            expected_account_id=self.account,
            topic_arn=self.topic,
            monthly_limit_usd="25.50",
            confirmation="ian-photography-monthly-prod",
            profile=None,
            caller=caller,
        )

    def test_ready_inventory_is_aggregate_and_recommends_create(self) -> None:
        report, blocked = self.run_inventory(self.caller())
        self.assertFalse(blocked)
        self.assertEqual(
            report["recommendedParameters"]["BudgetDeploymentMode"],
            "create-confirmed-absent",
        )
        self.assertEqual(report["confirmedSubscriptionCount"], 2)
        self.assertEqual(report["confirmedHumanDestinationCount"], 2)
        serialized = json.dumps(report)
        self.assertNotIn("Endpoint", serialized)
        self.assertNotIn("example.invalid", serialized)
        self.assertRegex(report["inventoryDigest"], r"^[0-9a-f]{64}$")

    def test_existing_budget_or_missing_responder_fails_closed(self) -> None:
        for kwargs, blocker in (
            ({"budget_exists": True}, "target-budget-already-exists-review-ownership"),
            ({"confirmed": 1}, "two-confirmed-human-destinations-required"),
            ({"topic_exists": False}, "exact-notification-topic-not-found"),
        ):
            with self.subTest(kwargs=kwargs):
                report, blocked = self.run_inventory(self.caller(**kwargs))
                self.assertTrue(blocked)
                self.assertEqual(report["recommendedParameters"]["BudgetDeploymentMode"], "skip")
                self.assertIn(blocker, report["blockers"])

    def test_nonhuman_or_duplicate_subscriptions_do_not_satisfy_responder_gate(self) -> None:
        def fake(arguments, profile, region):
            operation = tuple(arguments[:2])
            if operation == ("sts", "get-caller-identity"):
                return {"Account": self.account}
            if operation == ("sns", "list-topics"):
                return {"Topics": [{"TopicArn": self.topic}]}
            if operation == ("sns", "list-subscriptions-by-topic"):
                return {
                    "Subscriptions": [
                        {
                            "SubscriptionArn": "arn:sub:email-1",
                            "Protocol": "email",
                            "Endpoint": "same@example.invalid",
                        },
                        {
                            "SubscriptionArn": "arn:sub:email-2",
                            "Protocol": "email",
                            "Endpoint": "same@example.invalid",
                        },
                        {
                            "SubscriptionArn": "arn:sub:queue",
                            "Protocol": "sqs",
                            "Endpoint": "arn:aws:sqs:us-west-2:123456789012:queue",
                        },
                    ]
                }
            if operation == ("budgets", "describe-budgets"):
                return {"Budgets": []}
            raise AssertionError(arguments)

        report, blocked = self.run_inventory(fake)
        self.assertTrue(blocked)
        self.assertEqual(report["confirmedSubscriptionCount"], 3)
        self.assertEqual(report["confirmedHumanDestinationCount"], 1)
        serialized = json.dumps(report)
        self.assertNotIn("same@example.invalid", serialized)
        self.assertNotIn("arn:aws:sqs", serialized)

    def test_https_webhooks_do_not_satisfy_human_responder_gate(self) -> None:
        def fake(arguments, profile, region):
            operation = tuple(arguments[:2])
            if operation == ("sts", "get-caller-identity"):
                return {"Account": self.account}
            if operation == ("sns", "list-topics"):
                return {"Topics": [{"TopicArn": self.topic}]}
            if operation == ("sns", "list-subscriptions-by-topic"):
                return {
                    "Subscriptions": [
                        {
                            "SubscriptionArn": f"arn:sub:webhook-{index}",
                            "Protocol": "https",
                            "Endpoint": f"https://alerts-{index}.example.invalid/hook",
                        }
                        for index in range(2)
                    ]
                }
            if operation == ("budgets", "describe-budgets"):
                return {"Budgets": []}
            raise AssertionError(arguments)

        report, blocked = self.run_inventory(fake)
        self.assertTrue(blocked)
        self.assertEqual(report["confirmedSubscriptionCount"], 2)
        self.assertEqual(report["confirmedHumanDestinationCount"], 0)
        self.assertIn("two-confirmed-human-destinations-required", report["blockers"])
        self.assertNotIn("example.invalid", json.dumps(report))

    def test_account_region_topic_limit_and_confirmation_guards(self) -> None:
        base = {
            "stage": "prod",
            "region": "us-west-2",
            "expected_account_id": self.account,
            "topic_arn": self.topic,
            "monthly_limit_usd": "25",
            "confirmation": "ian-photography-monthly-prod",
            "profile": None,
            "caller": self.caller(),
        }
        invalid = (
            {"region": "us-east-1"},
            {"expected_account_id": "000000000000"},
            {"topic_arn": "arn:aws:sns:us-east-1:123456789012:ian-photography-security-prod"},
            {"topic_arn": "arn:aws:sns:us-west-2:123456789012:wrong"},
            {"monthly_limit_usd": "0"},
            {"monthly_limit_usd": "10.001"},
        )
        for change in invalid:
            with self.subTest(change=change), self.assertRaises(SystemExit):
                security_budget_preflight.inventory(**(base | change))

        report, blocked = security_budget_preflight.inventory(
            **(base | {"confirmation": None})
        )
        self.assertTrue(blocked)
        self.assertIn("exact-budget-name-confirmation-required", report["blockers"])

    def test_aws_failure_output_is_sanitized_and_fails_closed(self) -> None:
        provider_error = "AccessDenied for arn:aws:sns:us-west-2:123:secret-topic"
        with patch.object(
            security_budget_preflight.subprocess,
            "run",
            return_value=SimpleNamespace(
                returncode=1, stderr=provider_error, stdout=""
            ),
        ):
            with self.assertRaisesRegex(
                security_budget_preflight.AwsReadError,
                r"^sns list-topics read failed$",
            ) as raised:
                security_budget_preflight.aws_json(
                    ["sns", "list-topics"], None, "us-west-2"
                )
        self.assertNotIn("secret-topic", str(raised.exception))

        output = io.StringIO()
        with patch.object(
            security_budget_preflight,
            "inventory",
            side_effect=security_budget_preflight.AwsReadError(provider_error),
        ), patch.object(
            sys,
            "argv",
            [
                security_budget_preflight.__file__,
                "--expected-account-id",
                self.account,
                "--security-notification-topic-arn",
                self.topic,
                "--monthly-limit-usd",
                "25",
            ],
        ), redirect_stdout(output):
            self.assertEqual(security_budget_preflight.main(), 2)
        report = json.loads(output.getvalue())
        self.assertEqual(report["blockers"], ["aws-read-failed"])
        self.assertNotIn("secret-topic", output.getvalue())


if __name__ == "__main__":
    unittest.main()
