"""Tests for the guarded, console-only AWS Budget baseline."""

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
    def test_template_is_guarded_retained_and_has_no_notification_route(self) -> None:
        for expected in (
            "Type: AWS::Budgets::Budget",
            "Default: skip",
            "create-confirmed-absent",
            "ExpectedAccountMustMatch",
            "MustDeployInHomeRegion",
            "CreationRequiresApprovedLimit",
            "MonthlyLimitUsd",
            "DeletionPolicy: RetainExceptOnCreate",
            "UpdateReplacePolicy: Retain",
        ):
            self.assertIn(expected, TEMPLATE)
        for forbidden in (
            "SecurityNotificationTopicArn",
            "NotificationsWithSubscribers",
            "NotificationType:",
            "SubscriptionType:",
            "AWS::SNS::",
            "NotificationEmail",
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

    def caller(self, *, budget_exists: bool = False):
        def fake(arguments, profile, region):
            operation = tuple(arguments[:2])
            if operation == ("sts", "get-caller-identity"):
                return {"Account": self.account}
            if operation == ("budgets", "describe-budgets"):
                return {
                    "Budgets": (
                        [{"BudgetName": "ian-photography-monthly-prod"}]
                        if budget_exists
                        else []
                    )
                }
            raise AssertionError(arguments)

        return fake

    def inventory(self, **overrides):
        return security_budget_preflight.inventory(
            stage="prod",
            region="us-west-2",
            expected_account_id=self.account,
            monthly_limit_usd="25.50",
            confirmation="ian-photography-monthly-prod",
            profile=None,
            caller=self.caller(),
            **overrides,
        )

    def test_ready_inventory_recommends_console_only_budget(self) -> None:
        report, blocked = self.inventory()
        self.assertFalse(blocked)
        self.assertEqual(
            report["recommendedParameters"]["BudgetDeploymentMode"],
            "create-confirmed-absent",
        )
        self.assertEqual(report["notificationRoute"], "none-console-only")
        self.assertRegex(report["inventoryDigest"], r"^[0-9a-f]{64}$")
        serialized = json.dumps(report)
        self.assertNotIn("topic", serialized.lower())
        self.assertNotIn("subscription", serialized.lower())
        self.assertNotIn("endpoint", serialized.lower())

    def test_existing_budget_or_missing_confirmation_fails_closed(self) -> None:
        report, blocked = security_budget_preflight.inventory(
            stage="prod",
            region="us-west-2",
            expected_account_id=self.account,
            monthly_limit_usd="25.50",
            confirmation=None,
            profile=None,
            caller=self.caller(budget_exists=True),
        )
        self.assertTrue(blocked)
        self.assertEqual(report["recommendedParameters"]["BudgetDeploymentMode"], "skip")
        self.assertIn("target-budget-already-exists-review-ownership", report["blockers"])
        self.assertIn("exact-budget-name-confirmation-required", report["blockers"])

    def test_account_region_limit_and_confirmation_guards(self) -> None:
        base = {
            "stage": "prod",
            "region": "us-west-2",
            "expected_account_id": self.account,
            "monthly_limit_usd": "25",
            "confirmation": "ian-photography-monthly-prod",
            "profile": None,
            "caller": self.caller(),
        }
        for change in (
            {"region": "us-east-1"},
            {"expected_account_id": "000000000000"},
            {"monthly_limit_usd": "0"},
            {"monthly_limit_usd": "10.001"},
        ):
            with self.subTest(change=change), self.assertRaises(SystemExit):
                security_budget_preflight.inventory(**(base | change))

    def test_aws_failure_output_is_sanitized_and_fails_closed(self) -> None:
        provider_error = "AccessDenied for arn:aws:budgets::123:budget/private"
        with patch.object(
            security_budget_preflight.subprocess,
            "run",
            return_value=SimpleNamespace(returncode=1, stderr=provider_error, stdout=""),
        ), patch.object(
            sys,
            "argv",
            [
                "security_budget_preflight.py",
                "--expected-account-id",
                self.account,
                "--monthly-limit-usd",
                "25",
                "--confirm-budget-name",
                "ian-photography-monthly-prod",
            ],
        ), redirect_stdout(io.StringIO()) as output:
            status = security_budget_preflight.main()
        self.assertEqual(status, 2)
        self.assertNotIn(provider_error, output.getvalue())


if __name__ == "__main__":
    unittest.main()
