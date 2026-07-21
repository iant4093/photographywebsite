"""Regression tests for the guarded security operations rollout."""

from __future__ import annotations

from pathlib import Path
import re
import shutil
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
sys.path.insert(0, str(OPS))
import security_preflight  # noqa: E402
import enable_inspector_lambda_scanning as inspector_helper  # noqa: E402


FOUNDATION = (OPS / "security_audit_foundation_template.yaml").read_text(encoding="utf-8")
NOTIFICATIONS = (OPS / "security_notifications_template.yaml").read_text(encoding="utf-8")
MANAGED = (OPS / "security_managed_services_template.yaml").read_text(encoding="utf-8")
BACKUP = (OPS / "security_backup_template.yaml").read_text(encoding="utf-8")
BACKUP_REPLICA = (OPS / "security_backup_replica_template.yaml").read_text(encoding="utf-8")
SECURITY_TEMPLATES = (
    OPS / "security_audit_foundation_template.yaml",
    OPS / "security_notifications_template.yaml",
    OPS / "security_managed_services_template.yaml",
    OPS / "security_backup_template.yaml",
    OPS / "security_backup_replica_template.yaml",
)


def resource_block(template: str, logical_id: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(logical_id)}:\n(?P<body>.*?)(?=^  [A-Za-z][A-Za-z0-9]+:\n|^Outputs:)",
        template,
    )
    if not match:
        raise AssertionError(f"Missing resource {logical_id}")
    return match.group("body")


class SecurityTemplateTests(unittest.TestCase):
    def test_all_staged_templates_pass_cfn_lint(self) -> None:
        if shutil.which("cfn-lint"):
            subprocess.run(
                ["cfn-lint", *map(str, SECURITY_TEMPLATES)],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            return
        for template in SECURITY_TEMPLATES:
            subprocess.run(
                ["sam", "validate", "--lint", "--template-file", str(template)],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )

    def test_unsafe_monolith_is_removed(self) -> None:
        self.assertFalse((OPS / "security_baseline_template.yaml").exists())

    def test_foundation_retains_the_complete_cloudtrail_dependency_chain(self) -> None:
        for logical_id in (
            "SecurityAuditBucket",
            "SecurityAuditBucketPolicy",
            "SecurityAuditLogGroup",
            "CloudTrailLogsRole",
            "SecurityTrail",
        ):
            block = resource_block(FOUNDATION, logical_id)
            self.assertIn("DeletionPolicy: RetainExceptOnCreate", block)
            self.assertIn("UpdateReplacePolicy: Retain", block)
        self.assertGreaterEqual(FOUNDATION.count("aws:SourceArn:"), 5)
        self.assertIn("cloudtrail:${AWS::Region}:${AWS::AccountId}:trail/", FOUNDATION)
        self.assertIn("config:${AWS::Region}:${AWS::AccountId}:*", FOUNDATION)

    def test_notifications_use_customer_key_exact_publishers_and_delivery_guards(self) -> None:
        self.assertNotIn("alias/aws/sns", NOTIFICATIONS)
        self.assertNotIn("AWS::SNS::Subscription", NOTIFICATIONS)
        self.assertNotIn("NotificationEmail", NOTIFICATIONS)
        self.assertIn("AWS::KMS::Key", NOTIFICATIONS)
        self.assertIn("events.amazonaws.com", NOTIFICATIONS)
        self.assertIn("cloudwatch.amazonaws.com", NOTIFICATIONS)
        self.assertEqual(NOTIFICATIONS.count("DeadLetterConfig:"), 2)
        self.assertEqual(NOTIFICATIONS.count("RetryPolicy:"), 2)
        self.assertIn("SqsManagedSseEnabled: true", NOTIFICATIONS)
        self.assertIn("MetricName: ApproximateNumberOfMessagesVisible", NOTIFICATIONS)
        self.assertIn("AlarmName: !Sub 'ian-photography-security-events-dlq-${Stage}'", NOTIFICATIONS)
        self.assertIn("MetricName: KmsSecurityConfigurationChange", NOTIFICATIONS)
        self.assertIn("MetricName: SecurityRoutingConfigurationChange", NOTIFICATIONS)
        eventbridge_policy = NOTIFICATIONS.split(
            "- Sid: AllowEventBridgeSecurityFindings", 1
        )[1].split("- Sid: AllowExactCloudWatchAlarms", 1)[0]
        self.assertNotIn("Condition:", eventbridge_policy)
        self.assertIn("ArnEquals:\n                aws:SourceArn:", NOTIFICATIONS)

    def test_singletons_require_explicit_confirmed_absent_modes(self) -> None:
        self.assertEqual(MANAGED.count("Default: skip"), 5)
        self.assertEqual(MANAGED.count("create-confirmed-absent"), 8)
        self.assertIn("Features:", MANAGED)
        self.assertIn("Name: S3_DATA_EVENTS", MANAGED)
        self.assertIn("Name: RUNTIME_MONITORING", MANAGED)
        self.assertIn("AllSupported: false", MANAGED)
        self.assertNotIn("IncludeGlobalResourceTypes:", MANAGED)
        delivery_channel = resource_block(MANAGED, "ConfigDeliveryChannel")
        self.assertNotIn("DependsOn: ConfigRecorder", delivery_channel)
        self.assertIn("ResourceTypes:", MANAGED)

    def test_scheduled_backup_role_cannot_restore_and_arn_is_local(self) -> None:
        self.assertNotIn("AWSBackupServiceRolePolicyForRestores", BACKUP)
        self.assertIn("AWSBackupServiceRolePolicyForBackup", BACKUP)
        self.assertIn("AWSBackupServiceRolePolicyForS3Backup", BACKUP)
        self.assertIn("Default: skip", BACKUP)
        self.assertIn("governance-confirmed-after-restore-test", BACKUP)
        self.assertIn("AWS::KMS::Key", BACKUP)
        self.assertIn("EnableKeyRotation: true", BACKUP)
        self.assertIn("EncryptionKeyArn: !GetAtt BackupVaultKey.Arn", BACKUP)
        self.assertIn(
            "arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${AlbumsTableName}",
            BACKUP,
        )
        self.assertIn(
            "arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${PreviewMetadataTableName}",
            BACKUP,
        )
        self.assertIn("arn:${AWS::Partition}:s3:::${ImagesBucketName}", BACKUP)
        self.assertIn("ReplicaBackupVaultArn", BACKUP)
        self.assertIn("CopyActions:", BACKUP)
        self.assertIn("AWS::Backup::BackupVault", BACKUP_REPLICA)
        self.assertIn("MustDeployInReplicaRegion", BACKUP_REPLICA)
        self.assertIn("us-east-2", BACKUP_REPLICA)
        self.assertIn("governance-confirmed-after-restore-test", BACKUP_REPLICA)
        self.assertNotIn("AlbumsTableArn", BACKUP)


def empty_responses() -> dict[tuple[str, str], dict]:
    return {
        ("sts", "get-caller-identity"): {"Account": "123456789012"},
        ("cloudtrail", "describe-trails"): {"trailList": []},
        ("logs", "describe-log-groups"): {"logGroups": []},
        ("guardduty", "list-detectors"): {"DetectorIds": []},
        ("configservice", "describe-configuration-recorders"): {
            "ConfigurationRecorders": []
        },
        ("configservice", "describe-delivery-channels"): {"DeliveryChannels": []},
        ("securityhub", "describe-hub"): {},
        ("accessanalyzer", "list-analyzers"): {"analyzers": []},
        ("backup", "list-backup-vaults"): {"BackupVaultList": []},
        ("backup", "list-backup-plans"): {"BackupPlansList": []},
        ("sns", "list-topics"): {"Topics": []},
        ("kms", "list-aliases"): {"Aliases": []},
        ("sqs", "list-queues"): {"QueueUrls": []},
        ("events", "list-rules"): {"Rules": []},
        ("cloudwatch", "describe-alarms"): {"MetricAlarms": []},
    }


class SecurityPreflightTests(unittest.TestCase):
    def test_absent_inventory_recommends_only_explicit_guard_values(self) -> None:
        responses = empty_responses()
        calls: list[tuple[str, ...]] = []

        def caller(arguments: list[str], profile: str | None, region: str) -> dict:
            calls.append(tuple(arguments))
            return responses[(arguments[0], arguments[1])]

        report, incomplete = security_preflight.inventory(
            stage="prod",
            region="us-west-2",
            profile=None,
            audit_log_group_name=None,
            details=False,
            caller=caller,
        )
        self.assertFalse(incomplete)
        self.assertEqual(
            report["recommendedParameters"]["GuardDutyDeploymentMode"],
            "create-confirmed-absent",
        )
        self.assertEqual(
            report["recommendedParameters"]["BackupDeploymentMode"],
            "create-confirmed-no-conflict",
        )
        allowed_operations = {
            "get-caller-identity",
            "describe-trails",
            "describe-log-groups",
            "list-detectors",
            "describe-configuration-recorders",
            "describe-delivery-channels",
            "describe-hub",
            "list-analyzers",
            "list-backup-vaults",
            "list-backup-plans",
            "list-topics",
            "list-aliases",
            "list-queues",
            "list-rules",
            "describe-alarms",
        }
        self.assertTrue(calls)
        self.assertTrue(all(call[1] in allowed_operations for call in calls))
        self.assertIn(
            ("cloudtrail", "describe-trails", "--no-include-shadow-trails"), calls
        )

    def test_existing_singletons_are_never_recommended_for_creation(self) -> None:
        responses = empty_responses()
        responses[("guardduty", "list-detectors")] = {"DetectorIds": ["detector-id"]}
        responses[("configservice", "describe-configuration-recorders")] = {
            "ConfigurationRecorders": [{"name": "default"}]
        }
        responses[("configservice", "describe-delivery-channels")] = {
            "DeliveryChannels": [{"name": "default"}]
        }
        responses[("securityhub", "describe-hub")] = {"HubArn": "arn:hub"}
        responses[("accessanalyzer", "list-analyzers")] = {
            "analyzers": [{"name": "account"}]
        }

        def caller(arguments: list[str], profile: str | None, region: str) -> dict:
            return responses[(arguments[0], arguments[1])]

        report, incomplete = security_preflight.inventory(
            stage="prod",
            region="us-west-2",
            profile=None,
            audit_log_group_name=None,
            details=False,
            caller=caller,
        )
        self.assertFalse(incomplete)
        for name in (
            "ConfigDeploymentMode",
            "GuardDutyDeploymentMode",
            "SecurityHubDeploymentMode",
            "AccessAnalyzerDeploymentMode",
        ):
            self.assertTrue(report["recommendedParameters"][name].startswith("skip-"))

    def test_unknown_is_not_treated_as_absent(self) -> None:
        responses = empty_responses()

        def caller(arguments: list[str], profile: str | None, region: str) -> dict:
            if arguments[:2] == ["guardduty", "list-detectors"]:
                raise security_preflight.AwsCallError(
                    "guardduty", "list-detectors", "AccessDeniedException"
                )
            return responses[(arguments[0], arguments[1])]

        report, incomplete = security_preflight.inventory(
            stage="prod",
            region="us-west-2",
            profile=None,
            audit_log_group_name=None,
            details=False,
            caller=caller,
        )
        self.assertTrue(incomplete)
        self.assertEqual(
            report["recommendedParameters"]["GuardDutyDeploymentMode"],
            "skip-inventory-incomplete",
        )


class InspectorHelperTests(unittest.TestCase):
    def test_apply_guards_require_exact_absent_state(self) -> None:
        inspector_helper.validate_apply_guards(
            apply=True,
            account_id="123456789012",
            region="us-west-2",
            expected_account_id="123456789012",
            expected_region="us-west-2",
            current_lambda_state="DISABLED",
            current_lambda_code_state="DISABLED",
            expected_lambda_state="DISABLED",
            expected_lambda_code_state="DISABLED",
            confirmation="enable-inspector-lambda-code-scanning",
        )
        with self.assertRaises(SystemExit):
            inspector_helper.validate_apply_guards(
                apply=True,
                account_id="123456789012",
                region="us-west-2",
                expected_account_id="123456789012",
                expected_region="us-west-2",
                current_lambda_state="ENABLED",
                current_lambda_code_state="DISABLED",
                expected_lambda_state="DISABLED",
                expected_lambda_code_state="DISABLED",
                confirmation="enable-inspector-lambda-code-scanning",
            )

    def test_dry_run_bypasses_mutation_guards(self) -> None:
        inspector_helper.validate_apply_guards(
            apply=False,
            account_id="123456789012",
            region="us-west-2",
            expected_account_id=None,
            expected_region=None,
            current_lambda_state="UNKNOWN",
            current_lambda_code_state="UNKNOWN",
            expected_lambda_state=None,
            expected_lambda_code_state=None,
            confirmation=None,
        )

    def test_status_parser_fails_closed(self) -> None:
        self.assertEqual(
            inspector_helper.resource_status(
                {"resourceState": {"lambda": {"status": "enabled"}}}, "lambda"
            ),
            "ENABLED",
        )
        self.assertEqual(inspector_helper.resource_status({}, "lambdaCode"), "UNKNOWN")


if __name__ == "__main__":
    unittest.main()
