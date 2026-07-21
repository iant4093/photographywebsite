"""Regression checks for the retained account security and delivery baselines."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops"))

import cloudfront_frontend  # noqa: E402


SECURITY_TEMPLATES = "\n".join(
    (ROOT / "ops" / name).read_text(encoding="utf-8")
    for name in (
        "security_audit_foundation_template.yaml",
        "security_notifications_template.yaml",
        "security_managed_services_template.yaml",
        "security_backup_template.yaml",
        "security_backup_replica_template.yaml",
    )
)
FRONTEND_BASELINE = json.loads(
    (ROOT / "ops" / "frontend_cloudfront_baseline.json").read_text(encoding="utf-8")
)


class AccountSecurityBaselineTests(unittest.TestCase):
    def test_cloudtrail_evidence_is_multi_region_validated_and_retained(self):
        for expected in (
            "AWS::CloudTrail::Trail",
            "IsMultiRegionTrail: true",
            "IncludeGlobalServiceEvents: true",
            "EnableLogFileValidation: true",
            "ObjectLockEnabled: true",
            "Mode: GOVERNANCE",
            "DeletionPolicy: RetainExceptOnCreate",
            "aws:SecureTransport: false",
        ):
            self.assertIn(expected, SECURITY_TEMPLATES)

    def test_managed_detection_posture_and_backup_resources_are_declared(self):
        for resource_type in (
            "AWS::AccessAnalyzer::Analyzer",
            "AWS::GuardDuty::Detector",
            "AWS::SecurityHub::Hub",
            "AWS::Config::ConfigurationRecorder",
            "AWS::Config::DeliveryChannel",
            "AWS::Config::ConfigRule",
            "AWS::Backup::BackupVault",
            "AWS::Backup::BackupPlan",
            "AWS::Backup::BackupSelection",
        ):
            self.assertIn(resource_type, SECURITY_TEMPLATES)
        self.assertIn("LockConfiguration:", SECURITY_TEMPLATES)
        self.assertIn("MinRetentionDays: 35", SECURITY_TEMPLATES)

    def test_security_notifications_are_owner_opt_in_and_privacy_safe(self):
        self.assertNotIn("AWS::SNS::Subscription", SECURITY_TEMPLATES)
        self.assertNotIn("NotificationEmail", SECURITY_TEMPLATES)
        self.assertNotIn("@", SECURITY_TEMPLATES)
        self.assertIn("Attach only an owner-approved monitored subscriber", SECURITY_TEMPLATES)


class FrontendStaticCachingTests(unittest.TestCase):
    def test_heroes_use_bounded_shared_cache_not_immutable_html_policy(self):
        self.assertIn("images/heroes/*", FRONTEND_BASELINE["static_path_patterns"])
        self.assertIn("max-age=86400", FRONTEND_BASELINE["static_cache_control"])
        self.assertNotIn("immutable", FRONTEND_BASELINE["static_cache_control"])
        self.assertEqual(FRONTEND_BASELINE["immutable_path_patterns"], ["assets/*"])

    def test_static_behavior_uses_selected_cache_policy(self):
        default = {
            "TargetOriginId": "origin",
            "ForwardedValues": {"QueryString": False},
            "FunctionAssociations": {"Quantity": 0},
            "LambdaFunctionAssociations": {"Quantity": 0},
            "TrustedSigners": {"Enabled": False, "Quantity": 0},
            "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
        }
        behavior = cloudfront_frontend.cache_behavior(
            default,
            "images/heroes/*",
            "static-headers",
            FRONTEND_BASELINE,
            cache_policy="static",
        )
        self.assertEqual(behavior["PathPattern"], "images/heroes/*")
        self.assertEqual(
            behavior["CachePolicyId"], FRONTEND_BASELINE["cache_policies"]["static"]
        )
        self.assertEqual(behavior["ResponseHeadersPolicyId"], "static-headers")
        self.assertNotIn("ForwardedValues", behavior)


if __name__ == "__main__":
    unittest.main()
