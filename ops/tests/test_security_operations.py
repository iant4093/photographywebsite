"""Regression tests for the guarded security operations rollout."""

from __future__ import annotations

import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import textwrap
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
sys.path.insert(0, str(OPS))
import security_preflight  # noqa: E402
import disable_inspector_lambda_scanning as inspector_helper  # noqa: E402


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
    OPS / "security_budget_template.yaml",
)


def resource_block(template: str, logical_id: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(logical_id)}:\n(?P<body>.*?)(?=^  [A-Za-z][A-Za-z0-9]+:\n|^Outputs:)",
        template,
    )
    if not match:
        raise AssertionError(f"Missing resource {logical_id}")
    return match.group("body")


def inline_python(template: str, logical_id: str) -> str:
    block = resource_block(template, logical_id)
    match = re.search(
        r"(?ms)^      Code:\n        ZipFile: \|\n(?P<code>.*?)^      Tags:\n",
        block,
    )
    if not match:
        raise AssertionError(f"Missing inline code for {logical_id}")
    return textwrap.dedent(match.group("code"))


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
            "SecurityAuditKey",
            "SecurityAuditKeyAlias",
            "SecurityAuditBucket",
            "SecurityAuditBucketPolicy",
            "SecurityAuditLogGroup",
            "CloudTrailLogsRole",
            "SecurityTrail",
        ):
            block = resource_block(FOUNDATION, logical_id)
            self.assertIn("DeletionPolicy: RetainExceptOnCreate", block)
            self.assertIn("UpdateReplacePolicy: Retain", block)
        self.assertGreaterEqual(FOUNDATION.count("aws:SourceArn:"), 4)
        self.assertIn("cloudtrail:${AWS::Region}:${AWS::AccountId}:trail/", FOUNDATION)
        key = resource_block(FOUNDATION, "SecurityAuditKey")
        self.assertIn("EnableKeyRotation: true", key)
        self.assertIn("Service: cloudtrail.amazonaws.com", key)
        self.assertIn("kms:GenerateDataKey*", key)
        bucket = resource_block(FOUNDATION, "SecurityAuditBucket")
        self.assertIn("SSEAlgorithm: aws:kms", bucket)
        self.assertIn("KMSMasterKeyID: !GetAtt SecurityAuditKey.Arn", bucket)
        trail = resource_block(FOUNDATION, "SecurityTrail")
        self.assertIn("KMSKeyId: !GetAtt SecurityAuditKey.Arn", trail)
        bucket_policy = resource_block(FOUNDATION, "SecurityAuditBucketPolicy")
        self.assertNotIn("config.amazonaws.com", bucket_policy)
        self.assertNotIn("ConfigLogDelivery", bucket_policy)

    def test_foundation_optionally_audits_only_the_exact_config_bucket(self) -> None:
        self.assertIn(
            "ConfigDeliveryBucketName:\n    Type: String\n    Default: ''",
            FOUNDATION,
        )
        self.assertIn("AuditConfigDeliveryObjectEvents: !Not", FOUNDATION)
        self.assertIn("- !Ref ConfigDeliveryBucketName\n      - ''", FOUNDATION)
        bucket_policy = resource_block(FOUNDATION, "SecurityAuditBucketPolicy")
        self.assertNotIn("ConfigDeliveryBucketName", bucket_policy)
        trail = resource_block(FOUNDATION, "SecurityTrail")
        self.assertIn("IncludeGlobalServiceEvents: true", trail)
        self.assertIn("IsMultiRegionTrail: true", trail)
        self.assertIn("IncludeManagementEvents: true", trail)
        self.assertIn("ReadWriteType: All", trail)
        self.assertIn("Type: AWS::S3::Object", trail)
        self.assertIn("- AuditConfigDeliveryObjectEvents", trail)
        self.assertIn("- !Ref AWS::NoValue", trail)
        self.assertIn(
            "arn:${AWS::Partition}:s3:::${ConfigDeliveryBucketName}/", trail
        )
        self.assertNotIn("${ConfigDeliveryBucketName}/*", trail)
        self.assertEqual(trail.count("Type: AWS::S3::Object"), 1)
        self.assertEqual(trail.count("DataResources:"), 1)

    def test_notifications_use_privacy_safe_topic_exact_publishers_and_delivery_guards(self) -> None:
        self.assertNotIn("alias/aws/sns", NOTIFICATIONS)
        self.assertNotIn("AWS::SNS::Subscription", NOTIFICATIONS)
        self.assertNotIn("NotificationEmail", NOTIFICATIONS)
        self.assertNotIn("AWS::KMS::Key", NOTIFICATIONS)
        self.assertNotIn("KmsMasterKeyId", NOTIFICATIONS)
        self.assertIn("events.amazonaws.com", NOTIFICATIONS)
        self.assertIn("cloudwatch.amazonaws.com", NOTIFICATIONS)
        self.assertEqual(NOTIFICATIONS.count("DeadLetterConfig:"), 1)
        self.assertEqual(NOTIFICATIONS.count("RetryPolicy:"), 1)
        self.assertIn("SqsManagedSseEnabled: true", NOTIFICATIONS)
        self.assertIn("MetricName: ApproximateNumberOfMessagesVisible", NOTIFICATIONS)
        self.assertIn("AlarmName: !Sub 'ian-photography-security-events-dlq-${Stage}'", NOTIFICATIONS)
        self.assertIn("MetricName: KmsSecurityConfigurationChange", NOTIFICATIONS)
        self.assertIn("MetricName: SecurityRoutingConfigurationChange", NOTIFICATIONS)
        self.assertIn("MetricName: SecurityServiceConfigurationChange", NOTIFICATIONS)
        self.assertIn("MetricName: DataProtectionConfigurationChange", NOTIFICATIONS)
        self.assertIn("MetricName: InfrastructureProtectionConfigurationChange", NOTIFICATIONS)
        for logical_id in (
            "DetectionTopologyChangeMetric",
            "ManagedSecurityOrganizationChangeMetric",
            "BackupProtectionChangeMetric",
            "DataRetentionAndOwnershipChangeMetric",
            "InfrastructureExecutionChangeMetric",
        ):
            self.assertIn("Type: AWS::Logs::MetricFilter", resource_block(NOTIFICATIONS, logical_id))
        for event_name in (
            "UpdateFindingAggregator",
            "PutConfigurationRecorder",
            "DeleteBucketEncryption",
            "PutBucketPublicAccessBlock",
            "DeleteBackupPlan",
            "PutBackupVaultAccessPolicy",
            "UpdateRecoveryPointLifecycle",
            "BatchUpdateStandardsControlAssociations",
            "UpdateOrganizationConfiguration",
            "DeleteBucketOwnershipControls",
            "UpdateTimeToLive",
            "ExecuteChangeSet",
            "DisassociateWebACL",
        ):
            self.assertIn(f'eventName = "{event_name}"', NOTIFICATIONS)
        self.assertNotIn("budgets.amazonaws.com", NOTIFICATIONS)
        self.assertIn("AllowExactWebsiteCloudWatchAlarms", NOTIFICATIONS)
        self.assertNotIn(":alarm:*", NOTIFICATIONS)
        for alarm_pattern in (
            "ian-website-ApiServerErrorAlarm-*",
            "ian-website-PreviewDeadLetterQueueAlarm-*",
            "ian-photography-frontend-5xx-${Stage}",
            "ian-photography-backup-freshness-${Stage}",
        ):
            self.assertIn(alarm_pattern, NOTIFICATIONS)
        for logical_id in (
            "GuardDutyFindingRule",
            "GuardDutyCriticalFindingRule",
            "SecurityHubFindingRule",
            "SecurityHubCriticalFindingRule",
        ):
            self.assertNotRegex(NOTIFICATIONS, rf"(?m)^  {logical_id}:$")
        topic_policy = resource_block(NOTIFICATIONS, "SecurityNotificationsPolicy")
        self.assertNotIn("AllowEventBridgeSecurityFindings", topic_policy)
        queue_policy = resource_block(NOTIFICATIONS, "SecuritySignalQueuePolicy")
        self.assertIn("aws:SourceAccount: !Ref AWS::AccountId", queue_policy)
        self.assertIn("aws:SourceArn:", queue_policy)
        self.assertIn("ArnEquals:\n                aws:SourceArn:", NOTIFICATIONS)
        for logical_id in (
            "RootActivityAlarm",
            "CloudTrailChangeAlarm",
            "IamChangeAlarm",
            "KmsChangeAlarm",
            "SecurityRoutingChangeAlarm",
            "SecurityServiceChangeAlarm",
            "DataProtectionChangeAlarm",
            "InfrastructureProtectionChangeAlarm",
        ):
            self.assertNotIn("AlarmActions:", resource_block(NOTIFICATIONS, logical_id))
        self.assertIn(
            "AlarmActions: [!Ref SecurityNotifications]",
            resource_block(NOTIFICATIONS, "SecurityEventDlqAlarm"),
        )
        waf_forward = resource_block(NOTIFICATIONS, "WafAlarmForwardRule")
        self.assertIn("InputTransformer:", waf_forward)
        self.assertIn("$.detail.alarmName", waf_forward)
        self.assertIn("region: [us-east-1]", waf_forward)

    def test_singletons_require_explicit_confirmed_absent_modes(self) -> None:
        self.assertEqual(MANAGED.count("Default: skip"), 4)
        self.assertEqual(MANAGED.count("create-confirmed-absent"), 8)
        self.assertIn("Features:", MANAGED)
        self.assertIn("Name: S3_DATA_EVENTS", MANAGED)
        self.assertIn("Name: RUNTIME_MONITORING", MANAGED)
        self.assertIn("AllSupported: false", MANAGED)
        self.assertIn("IncludeGlobalResourceTypes: false", MANAGED)
        delivery_channel = resource_block(MANAGED, "ConfigDeliveryChannel")
        self.assertIn("Type: Custom::ConfigDeliveryChannel", delivery_channel)
        self.assertIn("- ConfigDeliveryBucketPolicy", delivery_channel)
        self.assertIn("- ConfigRecorder", delivery_channel)
        recorder = resource_block(MANAGED, "ConfigRecorder")
        self.assertNotIn("DependsOn: ConfigDeliveryChannel", recorder)
        self.assertIn("\n        ResourceTypes:", recorder)

    def test_home_region_detection_is_exactly_guarded(self) -> None:
        self.assertIn("ExpectedAccountId:", MANAGED)
        self.assertIn("ExpectedRegion:", MANAGED)
        scope = MANAGED.split("  ExactDeploymentScope:", 1)[1].split(
            "Conditions:", 1
        )[0]
        self.assertIn("!Ref ExpectedAccountId, !Ref AWS::AccountId", scope)
        self.assertIn("!Ref ExpectedRegion, !Ref AWS::Region", scope)
        self.assertNotIn("SecurityHubFindingAggregator", MANAGED)
        self.assertNotIn("AWS::SecurityHub::FindingAggregator", MANAGED)
        self.assertNotIn("SecurityHubAggregationMode", MANAGED)
        self.assertNotIn("SecurityHubHomeRegion", MANAGED)
        hub = resource_block(MANAGED, "SecurityHub")
        self.assertIn("EnableDefaultStandards: false", hub)
        self.assertIn("ControlFindingGenerator: SECURITY_CONTROL", hub)

    def test_config_adds_high_signal_rules_with_existing_dependencies(self) -> None:
        expected = {
            "ConfigS3PublicWriteProhibited": "S3_BUCKET_PUBLIC_WRITE_PROHIBITED",
            "ConfigS3EncryptionEnabled": "S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED",
            "ConfigCmkBackingKeyRotationEnabled": "CMK_BACKING_KEY_ROTATION_ENABLED",
        }
        for logical_id, source_identifier in expected.items():
            block = resource_block(MANAGED, logical_id)
            self.assertIn("Type: AWS::Config::ConfigRule", block)
            self.assertIn("Condition: CreateConfig", block)
            self.assertIn("- ConfigRecorder", block)
            self.assertIn("- ConfigDeliveryChannel", block)
            self.assertIn(f"SourceIdentifier: {source_identifier}", block)
        self.assertNotIn("CLOUDFRONT_VIEWER_POLICY_HTTPS", MANAGED)

    def test_config_delivery_uses_a_dedicated_guarded_bucket(self) -> None:
        bucket = resource_block(MANAGED, "ConfigDeliveryBucket")
        self.assertIn("DeletionPolicy: RetainExceptOnCreate", bucket)
        self.assertIn("UpdateReplacePolicy: Retain", bucket)
        self.assertIn("SSEAlgorithm: AES256", bucket)
        self.assertIn("ObjectOwnership: BucketOwnerPreferred", bucket)
        self.assertIn("VersioningConfiguration:", bucket)
        self.assertIn("BlockPublicAcls: true", bucket)
        self.assertNotIn("ObjectLock", bucket)
        policy = resource_block(MANAGED, "ConfigDeliveryBucketPolicy")
        self.assertIn("aws:SecureTransport: false", policy)
        self.assertEqual(policy.count("aws:SourceAccount: !Ref AWS::AccountId"), 3)
        self.assertEqual(
            policy.count(
                "arn:${AWS::Partition}:config:${AWS::Region}:${AWS::AccountId}:'"
            ),
            3,
        )
        self.assertIn("s3:x-amz-acl: bucket-owner-full-control", policy)
        self.assertNotIn("SecurityAuditBucketName", MANAGED)

    def test_config_orchestrator_is_regional_and_minimally_privileged(self) -> None:
        role = resource_block(MANAGED, "ConfigDeliveryOrchestratorRole")
        for action in (
            "config:DeleteDeliveryChannel",
            "config:DescribeConfigurationRecorders",
            "config:DescribeConfigurationRecorderStatus",
            "config:DescribeDeliveryChannels",
            "config:PutDeliveryChannel",
            "config:StopConfigurationRecorder",
            "ssm:DeleteParameter",
            "ssm:GetParameter",
            "ssm:PutParameter",
        ):
            self.assertIn(action, role)
        self.assertIn("aws:RequestedRegion: !Ref AWS::Region", role)
        self.assertIn(
            "parameter/ian-photography/config-delivery/ian-photography-${Stage}/owner",
            role,
        )
        self.assertNotIn("config:DeleteConfigurationRecorder", role)
        function = resource_block(MANAGED, "ConfigDeliveryOrchestratorFunction")
        self.assertIn("Runtime: python3.12", function)
        self.assertIn("Timeout: 600", function)
        self.assertIn("RECORDER_WAIT_SECONDS: '420'", function)
        self.assertIn("hashlib.sha256(stack_id.encode", function)
        self.assertNotIn("LOG.info(event", function)
        self.assertNotIn("logger.exception", function.lower())
        channel = resource_block(MANAGED, "ConfigDeliveryChannel")
        self.assertIn("ServiceTimeout: 660", channel)
        self.assertNotIn("ConfigServiceLinkedRole:", MANAGED)
        self.assertIn("ExpectedRecorderRoleArn: !Sub", channel)
        self.assertIn("ExpectedAllSupported: false", channel)
        self.assertIn("ExpectedIncludeGlobalResourceTypes: false", channel)
        self.assertIn("ExpectedResourceTypes:", channel)
        self.assertIn(
            "OwnershipParameterName: !Sub '/ian-photography/config-delivery/ian-photography-${Stage}/owner'",
            channel,
        )
        recorder = resource_block(MANAGED, "ConfigRecorder")
        self.assertIn(
            "role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig",
            recorder,
        )
        self.assertIn("AllSupported: false", recorder)
        self.assertIn("IncludeGlobalResourceTypes: false", recorder)
        for resource_type in (
            "AWS::CloudTrail::Trail",
            "AWS::DynamoDB::Table",
            "AWS::KMS::Key",
            "AWS::S3::Bucket",
        ):
            self.assertIn(resource_type, recorder)

    def test_scheduled_backup_role_cannot_restore_and_arn_is_local(self) -> None:
        self.assertNotIn("AWSBackupServiceRolePolicyForRestores", BACKUP)
        self.assertIn("AWSBackupServiceRolePolicyForBackup", BACKUP)
        self.assertNotIn("AWSBackupServiceRolePolicyForS3Backup", BACKUP)
        backup_role = resource_block(BACKUP, "BackupRole")
        self.assertIn("aws:SourceAccount: !Ref AWS::AccountId", backup_role)
        self.assertIn(
            "arn:${AWS::Partition}:backup:${AWS::Region}:${AWS::AccountId}:*",
            backup_role,
        )
        self.assertNotIn("us-east-2", backup_role)
        self.assertNotIn("arn:${AWS::Partition}:backup:*:${AWS::AccountId}:*", backup_role)
        self.assertIn("Default: skip", BACKUP)
        self.assertIn("governance-confirmed-after-restore-test", BACKUP)
        self.assertNotIn("AWS::KMS::Key", BACKUP)
        self.assertNotIn("EncryptionKeyArn:", BACKUP)
        self.assertIn(
            "arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${AlbumsTableName}",
            BACKUP,
        )
        self.assertIn(
            "arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${PreviewMetadataTableName}",
            BACKUP,
        )
        self.assertNotIn("arn:${AWS::Partition}:s3:::${ImagesBucketName}", BACKUP)
        self.assertNotIn("ReplicaBackupVaultArn", BACKUP)
        self.assertNotIn("ReplicaBackupDeploymentMode", BACKUP)
        rules = BACKUP.split("Rules:", 1)[1].split("Conditions:", 1)[0]
        self.assertNotIn("!Sub", rules)
        self.assertNotIn("Fn::Sub", rules)
        self.assertNotIn("CopyActions:", BACKUP)
        self.assertIn("AWS::Backup::BackupVault", BACKUP_REPLICA)
        self.assertIn("MustDeployInReplicaRegion", BACKUP_REPLICA)
        self.assertIn("us-east-2", BACKUP_REPLICA)
        self.assertIn("governance-confirmed-after-restore-test", BACKUP_REPLICA)
        self.assertNotIn("AlbumsTableArn", BACKUP)
        self.assertIn(
            "BackupPlanName: !Sub 'ian-photography-protected-data-${Stage}'",
            BACKUP,
        )
        self.assertIn(
            'f"ian-photography-protected-data-{stage}"',
            (OPS / "security_preflight.py").read_text(encoding="utf-8"),
        )

    def test_backup_failure_events_are_static_privacy_safe_and_reliably_routed(self) -> None:
        for logical_id, event_name, detail_type in (
            ("BackupJobFailureRule", "backup.job.failed", "Backup Job State Change"),
        ):
            block = resource_block(BACKUP, logical_id)
            self.assertIn("Type: AWS::Events::Rule", block)
            self.assertIn(f"detail-type: [{detail_type}]", block)
            self.assertIn(f'"eventName":"{event_name}"', block)
            self.assertIn("DeadLetterConfig:", block)
            self.assertIn(
                "Arn: !Sub 'arn:${AWS::Partition}:sqs:us-west-2:${AWS::AccountId}:ian-photography-security-signals-${Stage}'",
                block,
            )
            self.assertIn(
                "Arn: !Sub 'arn:${AWS::Partition}:sqs:us-west-2:${AWS::AccountId}:ian-photography-security-events-${Stage}-dlq'",
                block,
            )
            self.assertIn("MaximumRetryAttempts: 10", block)
            for forbidden in (
                "statusMessage",
                "resourceArn",
                "backupJobId",
                "copyJobId",
                "restoreJobId",
            ):
                self.assertNotIn(forbidden, block)
        self.assertEqual(BACKUP.count("DeadLetterConfig:"), 1)
        self.assertNotIn("BackupRestoreFailureRule", BACKUP)
        self.assertNotIn("backup.restore.failed", BACKUP)
        for removed_input in (
            "SecurityAlarmTopicArn",
            "SecuritySignalQueueArn",
            "SecurityEventDlqArn",
            "HasSecurityAlarmTopic",
            "HasSecuritySignalQueue",
            "HasSecurityEventDlq",
            "BackupAlertsRequiredForCreatedPlan",
            "OptionalFailureDlqMustMatchDeployment",
        ):
            self.assertNotIn(removed_input, BACKUP)
        self.assertIn(
            "CreateBackupAlerts: !Equals [!Ref BackupDeploymentMode, create-confirmed-no-conflict]",
            BACKUP,
        )
        self.assertIn("ian-photography-security-${Stage}", BACKUP)
        self.assertIn("ian-photography-security-events-${Stage}-dlq", BACKUP)
        self.assertIn("ian-photography-security-signals-${Stage}", BACKUP)
        self.assertIn("BackupFreshnessFailureCount", BACKUP)
        self.assertIn(
            "TreatMissingData: breaching",
            resource_block(BACKUP, "BackupFreshnessAlarm"),
        )
        self.assertIn(
            "EXPECTED_RESOURCE_ARNS",
            resource_block(BACKUP, "BackupFreshnessFunction"),
        )
        self.assertNotIn("AWS::SNS::Subscription", BACKUP)

    def test_security_signal_processor_enforces_fixed_contract(self) -> None:
        published = []

        class Sns:
            def publish(self, **kwargs):
                published.append(kwargs)

        fake_boto3 = types.SimpleNamespace(client=lambda service, **kwargs: Sns())
        environment = {
            "SECURITY_TOPIC_ARN": "arn:aws:sns:us-west-2:123:topic",
            "STAGE": "prod",
        }
        namespace = {"__name__": "security_signal_processor_test"}
        with patch.dict(sys.modules, {"boto3": fake_boto3}), patch.dict(
            os.environ, environment, clear=False
        ):
            exec(compile(inline_python(NOTIFICATIONS, "SecuritySignalProcessor"), "<signal>", "exec"), namespace)

        valid = {
            "schemaVersion": 1,
            "eventName": "backup.job.failed",
            "severity": "high",
            "stage": "prod",
            "runbook": "ops/ALARM_REGISTRY.md#backup-job-failure",
        }
        result = namespace["handler"](
            {"Records": [{"body": json.dumps(valid)}]}, types.SimpleNamespace()
        )
        self.assertEqual(result, {"forwarded": 1})
        self.assertEqual(len(published), 1)
        self.assertEqual(json.loads(published[0]["Message"]), valid)

        for name, expected in (("frontend-5xx", "edge.alarm"), ("media-5xx", "edge.alarm"), ("waf-blocked", "waf.alarm")):
            signal = {"schemaVersion": 1, "alarmName": "ian-photography-" + name + "-prod", "stage": "prod"}
            result = namespace["_validated"](json.dumps(signal))
            self.assertEqual(result["eventName"], expected)
            self.assertNotIn("alarmName", result)
        with self.assertRaises(ValueError):
            namespace["_validated"](json.dumps({"schemaVersion": 1, "alarmName": "unrelated-account-alarm", "stage": "prod"}))

        tampered = {**valid, "severity": "high", "private": "must-not-forward"}
        with self.assertRaisesRegex(ValueError, "invalid security signal shape"):
            namespace["handler"](
                {"Records": [{"body": json.dumps(tampered)}]},
                types.SimpleNamespace(),
            )
        self.assertEqual(len(published), 1)

    def test_backup_freshness_verifier_checks_every_exact_resource(self) -> None:
        now = datetime.datetime.now(datetime.timezone.utc)
        expected = {
            "arn:aws:dynamodb:us-west-2:123:table/albums",
            "arn:aws:dynamodb:us-west-2:123:table/previews",
        }
        metrics = []

        class Paginator:
            def paginate(self, **kwargs):
                return [
                    {
                        "RecoveryPoints": [
                            {
                                "ResourceArn": resource,
                                "Status": "COMPLETED",
                                "CompletionDate": now,
                            }
                            for resource in expected
                        ]
                    }
                ]

        class Backup:
            def get_paginator(self, name):
                self_name = name
                if self_name != "list_recovery_points_by_backup_vault":
                    raise AssertionError(self_name)
                return Paginator()

        class CloudWatch:
            def put_metric_data(self, **kwargs):
                metrics.append(kwargs)

        def client(service, **kwargs):
            if service == "backup":
                return Backup()
            if service == "cloudwatch":
                return CloudWatch()
            raise AssertionError(service)

        fake_boto3 = types.SimpleNamespace(client=client)
        environment = {
            "EXPECTED_RESOURCE_ARNS": ",".join(sorted(expected)),
            "FRESHNESS_MAX_AGE_HOURS": "36",
            "SOURCE_VAULT_NAME": "source",
            "STAGE": "prod",
        }
        namespace = {"__name__": "backup_freshness_test"}
        with patch.dict(sys.modules, {"boto3": fake_boto3}), patch.dict(
            os.environ, environment, clear=False
        ):
            exec(compile(inline_python(BACKUP, "BackupFreshnessFunction"), "<freshness>", "exec"), namespace)
            result = namespace["handler"]({}, types.SimpleNamespace())
        self.assertEqual(result, {"expected": 2, "healthy": 2, "failed": 0})
        metric_values = {
            item["MetricName"]: item["Value"]
            for item in metrics[0]["MetricData"]
        }
        self.assertEqual(metric_values["BackupExpectedCoverageCount"], 2)
        self.assertEqual(metric_values["BackupHealthyCoverageCount"], 2)
        self.assertEqual(metric_values["BackupFreshnessFailureCount"], 0)


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
    def test_apply_guards_require_exact_enabled_state(self) -> None:
        inspector_helper.validate_apply_guards(
            apply=True,
            account_id="123456789012",
            region="us-west-2",
            expected_account_id="123456789012",
            expected_region="us-west-2",
            current_lambda_state="ENABLED",
            current_lambda_code_state="ENABLED",
            expected_lambda_state="ENABLED",
            expected_lambda_code_state="ENABLED",
            confirmation="disable-inspector-lambda-scanning",
        )
        with self.assertRaises(SystemExit):
            inspector_helper.validate_apply_guards(
                apply=True,
                account_id="123456789012",
                region="us-west-2",
                expected_account_id="123456789012",
                expected_region="us-west-2",
                current_lambda_state="DISABLED",
                current_lambda_code_state="ENABLED",
                expected_lambda_state="ENABLED",
                expected_lambda_code_state="ENABLED",
                confirmation="disable-inspector-lambda-scanning",
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

    def test_waits_through_disabling_until_both_modes_are_disabled(self) -> None:
        statuses = [
            {
                "accountId": "123456789012",
                "resourceState": {
                    "lambda": {"status": "ENABLED"},
                    "lambdaCode": {"status": "ENABLED"},
                },
            },
            {
                "accountId": "123456789012",
                "resourceState": {
                    "lambda": {"status": "DISABLING"},
                    "lambdaCode": {"status": "DISABLING"},
                },
            },
            {
                "accountId": "123456789012",
                "resourceState": {
                    "lambda": {"status": "DISABLED"},
                    "lambdaCode": {"status": "DISABLING"},
                },
            },
            {
                "accountId": "123456789012",
                "resourceState": {
                    "lambda": {"status": "DISABLED"},
                    "lambdaCode": {"status": "DISABLED"},
                },
            },
        ]
        with patch.object(
            inspector_helper, "get_account_status", side_effect=statuses
        ), patch.object(inspector_helper.time, "monotonic", return_value=0), patch.object(
            inspector_helper.time, "sleep"
        ) as sleep:
            result = inspector_helper.wait_until_lambda_scanning_disabled(
                account_id="123456789012",
                profile=None,
                region="us-west-2",
                timeout_seconds=30,
                poll_interval_seconds=5,
            )
        self.assertEqual(result, ("DISABLED", "DISABLED"))
        self.assertEqual(sleep.call_count, 3)

    def test_wait_fails_closed_on_unexpected_state_and_timeout(self) -> None:
        failed = {
            "accountId": "123456789012",
            "resourceState": {
                "lambda": {"status": "DISABLING"},
                "lambdaCode": {"status": "FAILED"},
            },
        }
        with patch.object(
            inspector_helper, "get_account_status", return_value=failed
        ), self.assertRaises(RuntimeError):
            inspector_helper.wait_until_lambda_scanning_disabled(
                account_id="123456789012",
                profile=None,
                region="us-west-2",
                timeout_seconds=30,
                poll_interval_seconds=5,
            )

        still_enabled = {
            "accountId": "123456789012",
            "resourceState": {
                "lambda": {"status": "ENABLED"},
                "lambdaCode": {"status": "ENABLED"},
            },
        }
        with patch.object(
            inspector_helper, "get_account_status", return_value=still_enabled
        ), patch.object(
            inspector_helper.time, "monotonic", side_effect=[0, 31]
        ), self.assertRaises(TimeoutError):
            inspector_helper.wait_until_lambda_scanning_disabled(
                account_id="123456789012",
                profile=None,
                region="us-west-2",
                timeout_seconds=30,
                poll_interval_seconds=5,
            )


if __name__ == "__main__":
    unittest.main()
