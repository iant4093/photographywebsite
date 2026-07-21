import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
if str(OPS) not in sys.path:
    sys.path.insert(0, str(OPS))

import ci_bootstrap_preflight
from ci import frontend_edge_posture


TEMPLATE_PATH = OPS / "ci_bootstrap_template.yaml"
TEMPLATE = TEMPLATE_PATH.read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github" / "workflows" / "_quality.yml").read_text(encoding="utf-8")
VALIDATOR = (OPS / "validate_infrastructure.sh").read_text(encoding="utf-8")
RUNBOOK = (OPS / "CI_CD.md").read_text(encoding="utf-8")

EXECUTION_POLICY_IDS = (
    "CloudFormationExecutionIdentityAndComputePolicy",
    "CloudFormationExecutionDataAndMessagingPolicy",
    "CloudFormationExecutionEdgeAndIdentityPolicy",
    "CloudFormationExecutionEncryptionAndObservabilityPolicy",
)


def resource_block(logical_id: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(logical_id)}:\n.*?(?=^  [A-Za-z][A-Za-z0-9]+:\n|^Outputs:\n)",
        TEMPLATE,
    )
    if not match:
        raise AssertionError(f"resource not found: {logical_id}")
    return match.group(0)


def statement_block(resource: str, sid: str) -> str:
    match = re.search(
        rf"(?ms)^\s+- Sid: {re.escape(sid)}\n.*?(?=^\s+- Sid: |^\s+- PolicyName: |^\s+Tags:|^  [A-Za-z][A-Za-z0-9]+:|\Z)",
        resource,
    )
    if not match:
        raise AssertionError(f"statement not found: {sid}")
    return match.group(0)


def execution_permissions() -> str:
    return "\n".join(resource_block(logical_id) for logical_id in EXECUTION_POLICY_IDS)


class CiBootstrapTemplateTests(unittest.TestCase):
    def test_template_passes_cfn_lint(self):
        executable = shutil.which("cfn-lint") or str(ROOT / ".venv-ci" / "bin" / "cfn-lint")
        if not pathlib.Path(executable).is_file():
            self.skipTest("cfn-lint is not installed")
        subprocess.run([executable, str(TEMPLATE_PATH)], cwd=ROOT, check=True, capture_output=True, text=True)

    def test_provider_has_explicit_create_or_use_mode_and_region_guard(self):
        self.assertIn("GitHubOidcProviderMode:", TEMPLATE)
        self.assertIn("AllowedValues: [create, use-existing]", TEMPLATE)
        self.assertIn("ExistingGitHubOidcProviderArn:", TEMPLATE)
        self.assertIn("ExistingProviderRequiredOnlyInUseMode:", TEMPLATE)
        self.assertIn("ExistingProviderMustBeEmptyInCreateMode:", TEMPLATE)
        self.assertIn("The CI bootstrap must be deployed in us-west-2", TEMPLATE)
        provider = resource_block("GitHubOidcProvider")
        self.assertIn("Condition: CreateGitHubOidcProvider", provider)
        self.assertIn("DeletionPolicy: RetainExceptOnCreate", provider)
        self.assertIn("UpdateReplacePolicy: Retain", provider)
        self.assertIn("Url: https://token.actions.githubusercontent.com", provider)
        self.assertIn("- sts.amazonaws.com", provider)

    def test_all_oidc_trusts_use_exact_repository_audience_and_main_ref_subject(self):
        for logical_id in ("PlanRole", "ExecuteRole", "FrontendRole", "AuditRole"):
            with self.subTest(role=logical_id):
                block = resource_block(logical_id)
                self.assertIn("Action: sts:AssumeRoleWithWebIdentity", block)
                self.assertIn("token.actions.githubusercontent.com:aud: sts.amazonaws.com", block)
                self.assertIn(
                    "token.actions.githubusercontent.com:sub: !Sub 'repo:iant4093/photographywebsite:ref:refs/heads/${DefaultBranch}'",
                    block,
                )
                self.assertNotIn("repo:iant4093/photographywebsite:*", block)
                self.assertNotIn("refs/heads/*", block)
                self.assertNotIn(":environment:", block)

    def test_plan_execute_frontend_and_audit_permissions_are_separated(self):
        plan = resource_block("PlanRole")
        execute = resource_block("ExecuteRole")
        frontend = resource_block("FrontendRole")
        audit = resource_block("AuditRole")
        self.assertIn("cloudformation:CreateChangeSet", plan)
        self.assertIn("PassOnlyExecutionRoleToCloudFormation", plan)
        self.assertIn("cloudformation:ExecuteChangeSet", plan)
        self.assertIn("ExplicitlyDenyExecutionAndDirectMutation", plan)
        self.assertIn("ExecuteExistingGuardedChangeSet", execute)
        self.assertIn("DenyPlanningAndDirectStackMutation", execute)
        self.assertNotIn("iam:PassRole", execute)
        self.assertIn("iantruong-photography", TEMPLATE)
        self.assertIn("EIOCCNR8XGQ1B", TEMPLATE)
        self.assertIn("s3:PutObject", frontend)
        self.assertIn("cloudfront:CreateInvalidation", frontend)
        self.assertIn("s3:DeleteObject", frontend)
        self.assertIn("DenyFrontendControlPlaneAndDeletion", frontend)
        self.assertNotIn("cloudformation:", frontend)
        self.assertIn("cloudformation:DetectStackDrift", audit)
        self.assertIn("DenyAllCloudFormationMutation", audit)
        forwarded = statement_block(audit, "CloudFormationForwardAccessReads")
        self.assertIn("ForAnyValue:StringEquals:", forwarded)
        self.assertIn("aws:CalledVia: cloudformation.amazonaws.com", forwarded)
        audit_actions = {
            line.strip()[2:]
            for line in audit.splitlines()
            if line.strip().startswith("- ")
        }
        for forbidden_data_read in (
            "s3:GetObject",
            "s3:GetObjectAcl",
            "dynamodb:GetItem",
            "secretsmanager:GetSecretValue",
            "kms:Decrypt",
        ):
            self.assertNotIn(forbidden_data_read, audit_actions)
        self.assertNotIn("iam:PassRole", audit_actions)
        for required_metadata_read in (
            "cloudfront:GetMonitoringSubscription",
            "kms:GetKeyPolicy",
            "lambda:GetEventSourceMapping",
            "lambda:GetPolicy",
            "lambda:ListTags",
            "s3:GetBucketPolicy",
            "s3:ListBucket",
            "wafv2:GetWebACL",
            "wafv2:GetLoggingConfiguration",
        ):
            self.assertIn(required_metadata_read, audit_actions)
        self.assertNotIn("rum:", audit)
        self.assertNotIn("synthetics:", audit)
        self.assertNotIn("cognito-identity:", audit)
        self.assertNotIn("logs:GetLogEvents", audit)
        self.assertNotIn("cloudformation:DescribeStackResourceDrifts", audit)
        edge = statement_block(audit, "ReadExactFrontendDistributionPosture")
        self.assertIn("cloudfront:GetDistribution", edge)
        self.assertIn("distribution/${FrontendDistributionId}", edge)
        bucket = statement_block(audit, "ReadExactFrontendBucketPosture")
        self.assertIn("s3:GetBucketPolicyStatus", bucket)
        self.assertIn("s3:GetEncryptionConfiguration", bucket)

    def test_audit_role_drift_scope_matches_exact_versioned_multi_region_inventory(self):
        audit = resource_block("AuditRole")
        inventory = json.loads((OPS / "ci" / "audit_stacks.json").read_text(encoding="utf-8"))
        self.assertEqual(inventory["version"], 3)
        regional = inventory["regionalSecurityPosture"]
        self.assertEqual(regional["homeRegion"], "us-west-2")
        self.assertEqual(
            regional["satelliteStackName"], "ian-photography-security-regional"
        )
        self.assertEqual(
            regional["cloudFormationExclusion"],
            {
                "region": "us-west-2",
                "stackName": "ian-photography-security-managed",
                "logicalResourceId": "GuardDutyDetector",
                "unsupportedLogicalResourceIds": [
                    "ConfigDeliveryBucketPolicy",
                    "ConfigDeliveryChannel",
                    "ConfigRecorder",
                ],
            },
        )
        managed_source = (OPS / "security_managed_services_template.yaml").read_text()
        for logical_id, resource_type in {
            "ConfigDeliveryBucketPolicy": "AWS::S3::BucketPolicy",
            "ConfigDeliveryChannel": "Custom::ConfigDeliveryChannel",
            "ConfigRecorder": "AWS::Config::ConfigurationRecorder",
            "GuardDutyDetector": "AWS::GuardDuty::Detector",
        }.items():
            self.assertRegex(
                managed_source,
                rf"(?m)^  {logical_id}:\n    Type: {re.escape(resource_type)}$",
            )
        self.assertNotIn("rumAppMonitor", inventory)
        self.assertEqual(
            {(item["region"], item["name"]) for item in inventory["stacks"]},
            {
                ("us-west-2", "ian-website"),
                ("us-west-2", "ian-photography-ci-bootstrap"),
                ("us-west-2", "ian-photography-security-audit"),
                ("us-west-2", "ian-photography-security-notifications"),
                ("us-west-2", "ian-photography-security-managed"),
                ("us-west-2", "ian-photography-backup-primary"),
                ("us-west-2", "ian-photography-observability"),
                ("us-east-1", "ian-photography-front-door-waf"),
                ("us-east-2", "ian-photography-backup-replica"),
            },
        )
        for region, stack_name in sorted(
            {(item["region"], item["name"]) for item in inventory["stacks"]}
        ):
            stack_expression = "${ApplicationStackName}" if stack_name == "ian-website" else stack_name
            self.assertIn(
                f"cloudformation:{region}:${{AWS::AccountId}}:stack/{stack_expression}/*",
                audit,
            )
        poll = statement_block(audit, "ReadTypeConfigurationAndPoll")
        self.assertIn("cloudformation:BatchDescribeTypeConfigurations", poll)
        self.assertIn("aws:RequestedRegion:", poll)
        self.assertIn("- us-west-2", poll)
        self.assertIn("- us-east-1", poll)
        self.assertIn("- us-east-2", poll)
        detect = statement_block(audit, "DetectExactStackDrift")
        self.assertIn("cloudformation:ListStackResources", detect)
        self.assertIn("ec2:DescribeRegions", statement_block(audit, "InventoryEnabledRegions"))
        guardduty = statement_block(audit, "ReadRegionalGuardDutyPosture")
        self.assertIn("guardduty:ListDetectors", guardduty)
        self.assertIn("guardduty:GetDetector", guardduty)
        self.assertIn("aws:RequestedRegion:", guardduty)
        security_hub = statement_block(audit, "ReadRegionalSecurityHubPosture")
        for action in (
            "securityhub:DescribeHub",
            "securityhub:GetEnabledStandards",
            "securityhub:GetFindingAggregator",
            "securityhub:ListFindingAggregators",
            "securityhub:ListTagsForResource",
        ):
            self.assertIn(action, security_hub)
        governance = statement_block(audit, "ReadRegionalSecurityStackGovernance")
        self.assertIn("cloudformation:DescribeStacks", governance)
        self.assertIn("cloudformation:ListStackResources", governance)
        self.assertIn("cloudformation:*:${AWS::AccountId}:stack/ian-photography-security-regional/*", governance)
        self.assertIn("aws:RequestedRegion:", governance)
        expected_enabled_regions = {
            "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1",
            "ap-southeast-1", "ap-southeast-2", "ca-central-1", "eu-central-1",
            "eu-north-1", "eu-west-1", "eu-west-2", "eu-west-3", "sa-east-1",
            "us-east-1", "us-east-2", "us-west-1", "us-west-2",
        }
        mapping = TEMPLATE.split("\nMappings:\n", 1)[1].split("\nRules:\n", 1)[0]
        for region in expected_enabled_regions:
            self.assertIn(f"- {region}", mapping)
        for block in (guardduty, security_hub, governance):
            self.assertIn(
                "!FindInMap [AuditRegionContract, Enabled, Regions]", block
            )

        observability = next(
            item
            for item in inventory["stacks"]
            if item["name"] == "ian-photography-observability"
        )
        self.assertEqual(
            observability,
            {"region": "us-west-2", "name": "ian-photography-observability"},
        )
        drift_script = (OPS / "ci" / "audit_stack_drift.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("detect-stack-resource-drift", drift_script)
        self.assertNotIn("--logical-resource-ids", drift_script)
        self.assertIn('.Status == "IN_SYNC"', drift_script)
        self.assertIn("regional_security_posture.py", drift_script)
        self.assertNotIn("mapfile", drift_script)
        self.assertNotIn("rum get-app-monitor", drift_script)

    def test_new_lambda_security_resources_remain_drifted_without_kms_data_access(self):
        inventory = json.loads((OPS / "ci" / "audit_stacks.json").read_text())
        by_name = {item["name"]: item for item in inventory["stacks"]}
        self.assertNotIn(
            "logicalResourceIds",
            by_name["ian-photography-security-notifications"],
        )
        self.assertNotIn(
            "logicalResourceIds",
            by_name["ian-photography-backup-primary"],
        )

        notifications = (OPS / "security_notifications_template.yaml").read_text()
        mapping = re.search(
            r"(?ms)^  SecuritySignalProcessorMapping:\n.*?"
            r"(?=^  [A-Za-z][A-Za-z0-9]+:\n|^Outputs:)",
            notifications,
        )
        self.assertIsNotNone(mapping)
        self.assertNotIn("KmsKeyArn", mapping.group(0))
        self.assertNotIn("FilterCriteria", mapping.group(0))

        audit = resource_block("AuditRole")
        forwarded = statement_block(audit, "CloudFormationForwardAccessReads")
        self.assertIn("lambda:GetEventSourceMapping", forwarded)
        self.assertIn("lambda:ListTags", forwarded)
        self.assertIn("lambda:GetPolicy", forwarded)
        self.assertNotIn("kms:Decrypt", audit)

    def test_multi_stack_drift_script_audits_edge_stack_and_emits_aggregate_only(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            fake_bin = temporary / "bin"
            fake_bin.mkdir()
            call_log = temporary / "aws-calls.log"
            edge_documents = {
                "distribution": {"Distribution": {
                    "ARN": "arn:aws:cloudfront::123456789012:distribution/EXAMPLE",
                    "Status": "Deployed",
                    "DistributionConfig": {"Enabled": True, "Origins": {"Items": [{
                        "Id": "api", "CustomHeaders": {"Items": [{
                            "HeaderName": "X-Origin-Verify", "HeaderValue": "test-secret"
                        }]},
                    }]}},
                }},
                "publicAccessBlock": {"pab": True},
                "encryption": {"encryption": "AES256"},
                "ownership": {"ownership": "enforced"},
                "versioning": {},
                "policyStatus": {"public": False},
            }
            edge_contract = {
                "version": 1,
                "distributionId": "EXAMPLE",
                "bucketName": "example-bucket",
                "region": "us-west-2",
                "distributionSha256": frontend_edge_posture._digest(
                    frontend_edge_posture.sanitized_distribution(edge_documents["distribution"])
                ),
                "publicAccessBlockSha256": frontend_edge_posture._digest(edge_documents["publicAccessBlock"]),
                "encryptionSha256": frontend_edge_posture._digest(edge_documents["encryption"]),
                "ownershipSha256": frontend_edge_posture._digest(edge_documents["ownership"]),
                "versioningSha256": frontend_edge_posture._digest(edge_documents["versioning"]),
                "policyStatusSha256": frontend_edge_posture._digest(edge_documents["policyStatus"]),
            }
            edge_contract_path = temporary / "edge-contract.json"
            edge_contract_path.write_text(json.dumps(edge_contract), encoding="utf-8")
            fake_aws = fake_bin / "aws"
            fake_aws.write_text(
                """#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' \"$*\" >> \"$AWS_CALL_LOG\"
if [[ \"$1 $2\" == \"cloudformation detect-stack-resource-drift\" ]]; then
  logical_id=''
  while [[ $# -gt 0 ]]; do
    if [[ \"$1\" == \"--logical-resource-id\" ]]; then
      logical_id=\"$2\"
      break
    fi
    shift
  done
  [[ -n \"$logical_id\" ]] || exit 64
  printf '{\"LogicalId\":\"%s\",\"Status\":\"IN_SYNC\"}\\n' \"$logical_id\"
elif [[ \"$1 $2\" == \"cloudformation detect-stack-drift\" ]]; then
  printf '00000000-0000-0000-0000-000000000000\\n'
elif [[ \"$1 $2\" == \"cloudformation describe-stack-drift-detection-status\" ]]; then
  printf 'DETECTION_COMPLETE\\tIN_SYNC\\n'
elif [[ \"$1 $2\" == \"cloudformation list-stack-resources\" ]]; then
  printf '%s\\n' '[\"ConfigDeliveryBucketPolicy\",\"ConfigDeliveryChannel\",\"ConfigRecorder\",\"ConfigRule\",\"GuardDutyDetector\",\"SecurityHub\"]'
elif [[ \"$1 $2\" == \"cloudfront get-distribution\" ]]; then
  printf '%s\\n' '{"Distribution":{"ARN":"arn:aws:cloudfront::123456789012:distribution/EXAMPLE","Status":"Deployed","DistributionConfig":{"Enabled":true,"Origins":{"Items":[{"Id":"api","CustomHeaders":{"Items":[{"HeaderName":"X-Origin-Verify","HeaderValue":"test-secret"}]}}]}}}}'
elif [[ \"$1 $2\" == \"s3api get-public-access-block\" ]]; then
  printf '%s\\n' '{"pab":true}'
elif [[ \"$1 $2\" == \"s3api get-bucket-encryption\" ]]; then
  printf '%s\\n' '{"encryption":"AES256"}'
elif [[ \"$1 $2\" == \"s3api get-bucket-ownership-controls\" ]]; then
  printf '%s\\n' '{"ownership":"enforced"}'
elif [[ \"$1 $2\" == \"s3api get-bucket-versioning\" ]]; then
  printf '%s\\n' '{}'
elif [[ \"$1 $2\" == \"s3api get-bucket-policy-status\" ]]; then
  printf '%s\\n' '{"public":false}'
else
  exit 64
fi
""",
                encoding="utf-8",
            )
            fake_aws.chmod(0o700)
            fake_python = fake_bin / "python3"
            fake_python.write_text(
                """#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "ops/ci/regional_security_posture.py" ]]; then
  printf '%s\\n' '{"detectorCount":2,"enabledRegionCount":2,"findingAggregatorCount":1,"homeStandardCount":2,"satelliteStandardCount":0,"satelliteStackCount":1,"securityHubCount":2,"status":"IN_SYNC"}'
else
  exec "$REAL_PYTHON" "$@"
fi
""",
                encoding="utf-8",
            )
            fake_python.chmod(0o700)
            environment = os.environ.copy()
            environment.update(
                {
                    "AWS_CALL_LOG": str(call_log),
                    "PATH": f"{fake_bin}:{environment['PATH']}",
                    "RUNNER_TEMP": str(temporary),
                    "FRONTEND_EDGE_CONTRACT_PATH": str(edge_contract_path),
                    "REAL_PYTHON": sys.executable,
                }
            )
            completed = subprocess.run(
                ["bash", "ops/ci/audit_stack_drift.sh"],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(
                json.loads(completed.stdout),
                {
                    "directPostureResourceCount": 1,
                    "excludedResourceCount": 4,
                    "filteredStackCount": 1,
                    "guardDutyPostureCheckCount": 2,
                    "metadataPostureCheckCount": 1,
                    "resourceDriftCheckCount": 2,
                    "frontendEdgeCheckCount": 1,
                    "securityHubPostureCheckCount": 2,
                    "stackCount": 9,
                    "status": "IN_SYNC",
                    "unsupportedResourceCount": 3,
                },
            )
            calls = call_log.read_text(encoding="utf-8").splitlines()
            detections = [
                call for call in calls if call.startswith("cloudformation detect-stack-drift")
            ]
            self.assertEqual(len(detections), 8)
            resource_detections = [
                call
                for call in calls
                if call.startswith("cloudformation detect-stack-resource-drift")
            ]
            self.assertEqual(len(resource_detections), 2)
            joined_resource_calls = "\n".join(resource_detections)
            self.assertIn("ConfigRule", joined_resource_calls)
            self.assertIn("SecurityHub", joined_resource_calls)
            self.assertNotIn("GuardDutyDetector", joined_resource_calls)
            self.assertNotIn("ConfigDeliveryBucketPolicy", joined_resource_calls)
            self.assertNotIn("ConfigDeliveryChannel", joined_resource_calls)
            self.assertNotIn("--logical-resource-id ConfigRecorder", joined_resource_calls)
            self.assertFalse(any(call.startswith("rum ") for call in calls))

    def test_multi_stack_drift_inventory_rejects_unreviewed_exclusions(self):
        source = json.loads((OPS / "ci" / "audit_stacks.json").read_text())
        mutations = []
        legacy = json.loads(json.dumps(source))
        legacy["version"] = 2
        mutations.append(legacy)
        extra = json.loads(json.dumps(source))
        extra["stacks"][0]["excludedLogicalResourceIds"] = ["UnexpectedResource"]
        mutations.append(extra)
        mismatch = json.loads(json.dumps(source))
        mismatch["regionalSecurityPosture"]["cloudFormationExclusion"][
            "logicalResourceId"
        ] = "SecurityHub"
        mutations.append(mismatch)
        empty = json.loads(json.dumps(source))
        managed = next(
            item
            for item in empty["stacks"]
            if item["name"] == "ian-photography-security-managed"
        )
        managed["excludedLogicalResourceIds"] = []
        mutations.append(empty)
        unexpected_key = json.loads(json.dumps(source))
        unexpected_key["regionalSecurityPosture"]["bypass"] = True
        mutations.append(unexpected_key)
        unsupported = json.loads(json.dumps(source))
        unsupported["regionalSecurityPosture"]["cloudFormationExclusion"][
            "unsupportedLogicalResourceIds"
        ].append("UnexpectedResource")
        mutations.append(unsupported)

        for inventory in mutations:
            with self.subTest(
                inventory=inventory["version"]
            ), tempfile.TemporaryDirectory() as directory:
                temporary = pathlib.Path(directory)
                inventory_path = temporary / "audit.json"
                inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
                environment = os.environ.copy()
                environment.update(
                    {
                        "AUDIT_STACKS_PATH": str(inventory_path),
                        "RUNNER_TEMP": str(temporary),
                    }
                )
                completed = subprocess.run(
                    ["bash", "ops/ci/audit_stack_drift.sh"],
                    cwd=ROOT,
                    env=environment,
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.returncode, 2)
                self.assertEqual(completed.stdout, "")
                self.assertEqual(completed.stderr, "Drift inventory is invalid.\n")

    def test_release_bucket_and_key_are_private_encrypted_versioned_lifecycle_managed_and_retained(self):
        key = resource_block("ReleaseArtifactKey")
        bucket = resource_block("ReleaseArtifactBucket")
        policy = resource_block("ReleaseArtifactBucketPolicy")
        for block in (key, bucket, policy):
            self.assertIn("DeletionPolicy: RetainExceptOnCreate", block)
            self.assertIn("UpdateReplacePolicy: Retain", block)
        self.assertIn("EnableKeyRotation: true", key)
        self.assertIn("SSEAlgorithm: aws:kms", bucket)
        self.assertIn("BucketKeyEnabled: true", bucket)
        self.assertIn("VersioningConfiguration:\n        Status: Enabled", bucket)
        for setting in ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"):
            self.assertIn(f"{setting}: true", bucket)
        self.assertIn("AbortIncompleteMultipartUpload", bucket)
        self.assertIn("NoncurrentVersionExpiration", bucket)
        self.assertIn("aws:SecureTransport: 'false'", policy)
        self.assertIn("s3:x-amz-server-side-encryption", policy)

    def test_execution_role_is_bounded_to_current_application_families_and_protects_retained_data(self):
        execution = execution_permissions()
        self.assertNotIn("AdministratorAccess", TEMPLATE)
        self.assertNotIn("Action: '*'", TEMPLATE)
        for scope in (
            "role/${ApplicationStackName}-*",
            "function:${ApplicationStackName}-*",
            "s3:::goldenhour-*",
            "table/GoldenHour-*",
            "ian-photography-*",
            "secret:${ApplicationStackName}-*",
        ):
            self.assertIn(scope, execution)
        self.assertIn("ProtectRetainedApplicationData", execution)
        for action in (
            "cloudfront:DeleteDistribution",
            "cognito-idp:DeleteUserPool",
            "dynamodb:DeleteTable",
            "kms:ScheduleKeyDeletion",
            "s3:DeleteBucket",
            "secretsmanager:DeleteSecret",
        ):
            self.assertIn(action, execution)
        self.assertIn("iam:PassedToService", execution)
        self.assertIn("lambda.amazonaws.com", execution)
        self.assertIn("mediaconvert.amazonaws.com", execution)

        service_grants = statement_block(
            execution, "CreateAwsServiceGrantsForTaggedApplicationKeys"
        )
        self.assertIn("Action: kms:CreateGrant", service_grants)
        self.assertIn(
            "aws:ResourceTag/Application: IanTruongPhotography", service_grants
        )
        self.assertIn("kms:GrantIsForAWSResource: 'true'", service_grants)
        self.assertIn(
            "arn:${AWS::Partition}:kms:us-west-2:${AWS::AccountId}:key/*",
            service_grants,
        )
        self.assertIn("kms:DeleteAlias", execution)
        self.assertIn("sqs:DeleteQueue", execution)
        self.assertNotIn("kms:ScheduleKeyDeletion", service_grants)
        for forbidden in ("kms:ListGrants", "kms:RevokeGrant", "kms:RetireGrant"):
            self.assertNotIn(forbidden, service_grants)

        dynamodb_crypto = statement_block(
            execution, "UseTaggedApplicationKeysForDynamoDb"
        )
        for action in (
            "kms:Decrypt",
            "kms:DescribeKey",
            "kms:Encrypt",
            "kms:GenerateDataKey",
            "kms:GenerateDataKeyWithoutPlaintext",
            "kms:ReEncryptFrom",
            "kms:ReEncryptTo",
        ):
            self.assertIn(f"- {action}", dynamodb_crypto)
        self.assertIn(
            "aws:ResourceTag/Application: IanTruongPhotography", dynamodb_crypto
        )
        self.assertIn(
            "kms:ViaService: !Sub 'dynamodb.us-west-2.${AWS::URLSuffix}'",
            dynamodb_crypto,
        )
        self.assertIn(
            "arn:${AWS::Partition}:kms:us-west-2:${AWS::AccountId}:key/*",
            dynamodb_crypto,
        )
        for forbidden in (
            "kms:CreateGrant",
            "kms:ListGrants",
            "kms:RevokeGrant",
            "kms:RetireGrant",
        ):
            self.assertNotIn(forbidden, dynamodb_crypto)

        transform = statement_block(execution, "InvokeExactSamTransform")
        self.assertIn("Action: cloudformation:CreateChangeSet", transform)
        self.assertIn(
            "arn:${AWS::Partition}:cloudformation:us-west-2:aws:transform/Serverless-2016-10-31",
            transform,
        )
        self.assertNotIn("Resource: '*'", transform)

    def test_execution_role_can_manage_only_the_exact_front_door_domain_and_dns_zone(self):
        execution = execution_permissions()
        self.assertIn("AllowedValues: [origin-api.iantruongphotography.com]", TEMPLATE)
        self.assertIn("AllowedValues: [Z0915663I4P8Y0MEDWH]", TEMPLATE)

        domain = statement_block(execution, "ManageExactRegionalApiDomainAndMappings")
        self.assertIn("/domainnames/${ApplicationApiDomainName}'", domain)
        self.assertIn("/domainnames/${ApplicationApiDomainName}/apimappings'", domain)
        self.assertIn("/domainnames/${ApplicationApiDomainName}/apimappings/*'", domain)
        self.assertNotIn("/domainnames*", domain)
        self.assertIn("apigateway:AddCertificateToDomain", execution)
        self.assertIn("apigateway:RemoveCertificateFromDomain", domain)

        dns = statement_block(execution, "ChangeExactFrontDoorRecords")
        self.assertIn("hostedzone/${ApplicationHostedZoneId}", dns)
        # ACM's CloudFormation resource provider does not populate the Route53
        # record-level condition keys when it creates DNS validation records.
        # The permission must therefore be unconditional but remains bounded to
        # the one allow-listed hosted zone.
        self.assertNotIn("Condition:", dns)
        self.assertNotIn("Resource: '*'", dns)

    def test_execution_role_has_no_legacy_package_bridge_and_keeps_table_tag_reads(self):
        execution = execution_permissions()
        self.assertNotIn("ReadLegacySamRollbackPackages", execution)
        self.assertNotIn("aws-sam-cli-managed-default-samclisourcebucket", execution)

        tables = statement_block(execution, "ManageApplicationTables")
        self.assertIn("dynamodb:ListTagsOfResource", tables)
        self.assertIn("table/GoldenHour-*", tables)
        self.assertNotIn("Resource: '*'", tables)

    def test_execution_role_can_inspect_exact_drift_detection_dependencies(self):
        execution = execution_permissions()
        secrets = statement_block(execution, "ReadRateLimitSecretMetadata")
        self.assertIn("Action: secretsmanager:DescribeSecret", secrets)
        self.assertIn("secret:RateLimitHashSecret-*", secrets)
        self.assertNotIn("secretsmanager:GetSecretValue", secrets)
        self.assertNotIn("secretsmanager:PutSecretValue", secrets)
        self.assertNotIn("Resource: '*'", secrets)

        observability = statement_block(execution, "ReadGlobalObservabilityInventories")
        self.assertIn("logs:DescribeIndexPolicies", observability)
        self.assertIn("Resource: '*'", observability)
        self.assertNotIn("logs:GetLogEvents", observability)

        messaging = statement_block(execution, "ManageApplicationQueuesAndTopics")
        self.assertIn("sns:ListTagsForResource", messaging)
        self.assertIn(
            "arn:${AWS::Partition}:sns:us-west-2:${AWS::AccountId}:ian-photography-*",
            messaging,
        )
        self.assertNotIn("sns:ListTopics", messaging)
        self.assertNotIn("Resource: '*'", messaging)

    def test_execution_role_has_only_metadata_permissions_for_api_log_delivery(self):
        execution = execution_permissions()
        delivery = statement_block(execution, "ManageApiGatewayAccessLogDeliveries")
        for action in (
            "logs:CreateLogDelivery",
            "logs:DeleteLogDelivery",
            "logs:GetLogDelivery",
            "logs:ListLogDeliveries",
            "logs:UpdateLogDelivery",
        ):
            self.assertIn(f"- {action}", delivery)
        self.assertIn("Resource: '*'", delivery)
        self.assertIn("aws:RequestedRegion: us-west-2", delivery)

        policies = statement_block(
            execution, "EstablishApiGatewayAccessLogResourcePolicies"
        )
        self.assertIn("- logs:DescribeResourcePolicies", policies)
        self.assertIn("- logs:PutResourcePolicy", policies)
        self.assertIn("Resource: '*'", policies)
        self.assertIn("aws:RequestedRegion: us-west-2", policies)
        for forbidden in (
            "logs:CreateLogGroup",
            "logs:CreateDelivery",
            "logs:DeleteLogGroup",
            "logs:DeleteResourcePolicy",
            "logs:FilterLogEvents",
            "logs:GetLogEvents",
            "logs:PutLogEvents",
            "logs:PutDeliveryDestination",
            "logs:PutDeliverySource",
        ):
            self.assertNotIn(forbidden, delivery)
            self.assertNotIn(forbidden, policies)

    def test_cloudfront_permissions_cover_reversible_application_resource_lifecycles(self):
        execution = execution_permissions()
        managed = statement_block(execution, "ManageApplicationCloudFront")
        for action in (
            "cloudfront:DeleteCachePolicy",
            "cloudfront:DeleteOriginAccessControl",
            "cloudfront:DeleteResponseHeadersPolicy",
            "cloudfront:GetCachePolicy",
            "cloudfront:GetDistribution",
            "cloudfront:GetDistributionConfig",
            "cloudfront:GetOriginAccessControl",
            "cloudfront:GetResponseHeadersPolicy",
            "cloudfront:ListTagsForResource",
            "cloudfront:TagResource",
            "cloudfront:UntagResource",
            "cloudfront:UpdateCachePolicy",
            "cloudfront:UpdateDistribution",
            "cloudfront:UpdateOriginAccessControl",
            "cloudfront:UpdateResponseHeadersPolicy",
        ):
            self.assertIn(action, managed)
        for resource_family in (
            "distribution/*",
            "cache-policy/*",
            "origin-access-control/*",
            "response-headers-policy/*",
        ):
            self.assertIn(resource_family, managed)
        self.assertNotIn("Resource: '*'", managed)
        self.assertNotIn("cloudfront:DeleteDistribution", managed)

        create_and_list = statement_block(execution, "CreateCloudFrontResources")
        for action in (
            "cloudfront:CreateCachePolicy",
            "cloudfront:CreateDistribution",
            "cloudfront:CreateOriginAccessControl",
            "cloudfront:CreateResponseHeadersPolicy",
            "cloudfront:ListCachePolicies",
            "cloudfront:ListDistributions",
            "cloudfront:ListOriginAccessControls",
            "cloudfront:ListResponseHeadersPolicies",
        ):
            self.assertIn(action, create_and_list)
        self.assertIn("Resource: '*'", create_and_list)

        protection = statement_block(execution, "ProtectRetainedApplicationData")
        self.assertIn("cloudfront:DeleteDistribution", protection)

    def test_event_source_mapping_tag_lifecycle_is_scoped_to_regional_account_arns(self):
        execution = execution_permissions()
        mappings = statement_block(execution, "ManageStackEventSourceMappings")
        for action in (
            "lambda:ListTags",
            "lambda:TagResource",
            "lambda:UntagResource",
            "lambda:UpdateEventSourceMapping",
            "lambda:DeleteEventSourceMapping",
        ):
            self.assertIn(f"- {action}", mappings)
        self.assertIn(
            "arn:${AWS::Partition}:lambda:us-west-2:${AWS::AccountId}:event-source-mapping:*",
            mappings,
        )
        self.assertNotIn("Resource: '*'", mappings)
        self.assertNotIn("lambda:GetEventSourceMapping", mappings)

        inventory = statement_block(execution, "ListEventSourceMappings")
        self.assertIn("- lambda:GetEventSourceMapping", inventory)
        self.assertIn("- lambda:ListEventSourceMappings", inventory)
        self.assertIn("Resource: '*'", inventory)
        for forbidden in (
            "lambda:CreateEventSourceMapping",
            "lambda:DeleteEventSourceMapping",
            "lambda:TagResource",
            "lambda:UntagResource",
            "lambda:UpdateEventSourceMapping",
        ):
            self.assertNotIn(forbidden, inventory)

    def test_certificate_secret_and_managed_policy_lifecycles_are_narrow_and_complete(self):
        execution = execution_permissions()
        request = statement_block(execution, "RequestExactRegionalApiCertificate")
        self.assertIn("acm:RequestCertificate", request)
        self.assertIn("acm:ValidationMethod: DNS", request)
        self.assertIn("acm:DomainNames", request)
        self.assertIn("aws:RequestedRegion: us-west-2", request)
        self.assertIn("acm:DomainNames: 'false'", request)
        self.assertIn("acm:ValidationMethod: 'false'", request)
        self.assertNotIn("aws:RequestTag/Application", request)
        initial_tags = statement_block(execution, "AddInitialApplicationCertificateTags")
        self.assertIn("acm:AddTagsToCertificate", initial_tags)
        self.assertIn(
            "arn:${AWS::Partition}:acm:us-west-2:${AWS::AccountId}:certificate/*",
            initial_tags,
        )
        self.assertNotIn("aws:RequestTag/Application", initial_tags)
        self.assertNotIn("Condition:", initial_tags)
        certificate = statement_block(execution, "ManageTaggedRegionalApiCertificates")
        for action in (
            "acm:AddTagsToCertificate",
            "acm:DescribeCertificate",
            "acm:ListTagsForCertificate",
            "acm:RemoveTagsFromCertificate",
        ):
            self.assertIn(action, certificate)
        self.assertIn("aws:ResourceTag/Application: IanTruongPhotography", certificate)
        self.assertNotIn("acm:DeleteCertificate", execution)

        secret = statement_block(execution, "ManageApplicationSecrets")
        self.assertIn("secret:ian-photography/front-door/*", secret)
        self.assertIn("secretsmanager:PutSecretValue", secret)
        self.assertIn("secretsmanager:ListSecretVersionIds", secret)
        self.assertNotIn("secretsmanager:DeleteSecret", secret)
        managed = statement_block(execution, "ManageStackManagedPolicyVersions")
        for action in (
            "iam:CreatePolicy",
            "iam:CreatePolicyVersion",
            "iam:DeletePolicyVersion",
            "iam:SetDefaultPolicyVersion",
        ):
            self.assertIn(action, managed)
        self.assertIn("policy/${ApplicationStackName}-*", managed)
        self.assertNotIn("iam:DeletePolicy\n", managed)

    def test_execution_role_allow_wildcards_are_explicit_and_minimal(self):
        execution = execution_permissions()
        allowed = {
            "CreateStackEventSourceMappings",
            "ListEventSourceMappings",
            "GenerateApplicationSecretValues",
            "RequestExactRegionalApiCertificate",
            "CreateTaggedUserPool",
            "CreateCloudFrontResources",
            "CreateTaggedApplicationKey",
            "EstablishApiGatewayAccessLogResourcePolicies",
            "ManageApiGatewayAccessLogDeliveries",
            "ReadGlobalObservabilityInventories",
        }
        allow_star = {
            sid
            for sid in re.findall(r"(?m)^\s+- Sid: ([A-Za-z0-9]+)$", execution)
            if "Effect: Allow" in statement_block(execution, sid)
            and "Resource: '*'" in statement_block(execution, sid)
        }
        self.assertEqual(allow_star, allowed)

    def test_execution_permissions_use_bounded_managed_policies(self):
        from cfnlint.decode import decode

        template, errors = decode(str(TEMPLATE_PATH))
        self.assertEqual(errors, [])
        role = template["Resources"]["CloudFormationExecutionRole"]["Properties"]
        self.assertNotIn("Policies", role)
        self.assertEqual(
            role["ManagedPolicyArns"],
            [{"Ref": logical_id} for logical_id in EXECUTION_POLICY_IDS],
        )
        for logical_id in EXECUTION_POLICY_IDS:
            with self.subTest(policy=logical_id):
                resource = template["Resources"][logical_id]
                self.assertEqual(resource["Type"], "AWS::IAM::ManagedPolicy")
                compact = json.dumps(
                    resource["Properties"]["PolicyDocument"],
                    separators=(",", ":"),
                )
                self.assertLess(len(compact), 6144)
                self.assertEqual(resource["DeletionPolicy"], "RetainExceptOnCreate")
                self.assertEqual(resource["UpdateReplacePolicy"], "Retain")

    def test_bootstrap_resources_clean_up_failed_creates_but_retain_replacements(self):
        retained_ids = (
            "GitHubOidcProvider",
            "ReleaseArtifactKey",
            "ReleaseArtifactKeyAlias",
            "ReleaseArtifactBucket",
            "ReleaseArtifactBucketPolicy",
            "PlanRole",
            "ExecuteRole",
            "FrontendRole",
            "AuditRole",
            "CloudFormationExecutionRole",
            *EXECUTION_POLICY_IDS,
        )
        for logical_id in retained_ids:
            with self.subTest(resource=logical_id):
                block = resource_block(logical_id)
                self.assertIn("DeletionPolicy: RetainExceptOnCreate", block)
                self.assertIn("UpdateReplacePolicy: Retain", block)

    def test_roles_and_outputs_are_retained_and_operationally_complete(self):
        for logical_id in ("PlanRole", "ExecuteRole", "FrontendRole", "AuditRole", "CloudFormationExecutionRole"):
            block = resource_block(logical_id)
            self.assertIn("DeletionPolicy: RetainExceptOnCreate", block)
            self.assertIn("UpdateReplacePolicy: Retain", block)
        for output in (
            "PlanRoleArn",
            "ExecuteRoleArn",
            "FrontendRoleArn",
            "AuditRoleArn",
            "CloudFormationExecutionRoleArn",
            "ReleaseArtifactBucketName",
            "ReleaseArtifactKeyArn",
        ):
            self.assertIn(f"  {output}:", TEMPLATE)

    def test_validation_lists_and_runbook_include_bootstrap(self):
        self.assertIn("ops/ci_bootstrap_template.yaml", WORKFLOW)
        self.assertIn("ops/ci_bootstrap_template.yaml", VALIDATOR)
        self.assertIn("ci_bootstrap_preflight.py", RUNBOOK)
        self.assertIn("CAPABILITY_NAMED_IAM", RUNBOOK)
        self.assertIn("termination protection", RUNBOOK.lower())

    def test_quality_gate_enforces_and_retains_both_artifact_budget_reports(self):
        self.assertEqual(WORKFLOW.count("python3 ops/ci/artifact_budget.py"), 2)
        self.assertIn("--root release-frontend/dist", WORKFLOW)
        self.assertIn("--build-root backend/.aws-sam/build", WORKFLOW)
        self.assertIn("--makefile backend/Makefile", WORKFLOW)
        self.assertIn("name: frontend-artifact-budget", WORKFLOW)
        self.assertIn("name: backend-artifact-budget", WORKFLOW)
        self.assertNotIn("public_catalog_load_test.py", WORKFLOW)


class CiBootstrapPreflightTests(unittest.TestCase):
    def test_inventory_filters_to_exact_account_and_github_host(self):
        response = {
            "OpenIDConnectProviderList": [
                {"Arn": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"},
                {"Arn": "arn:aws:iam::999999999999:oidc-provider/token.actions.githubusercontent.com"},
                {"Arn": "arn:aws:iam::123456789012:oidc-provider/example.com"},
                None,
            ]
        }
        self.assertEqual(
            ci_bootstrap_preflight.provider_inventory(response, "123456789012"),
            ["arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"],
        )

    def test_create_mode_requires_absence_and_performs_only_read_calls(self):
        calls = []

        def aws(arguments, profile, region):
            calls.append(arguments)
            return {"Account": "123456789012"} if arguments[0] == "sts" else {"OpenIDConnectProviderList": []}

        with mock.patch.object(ci_bootstrap_preflight, "aws_json", side_effect=aws):
            result = ci_bootstrap_preflight.validate_preflight(
                provider_mode="create",
                existing_provider_arn="",
                expected_account_id="123456789012",
                stack_name="ian-photography-ci-bootstrap",
                region="us-west-2",
                profile=None,
            )
        self.assertFalse(result["providerExists"])
        self.assertEqual(calls, [["sts", "get-caller-identity"], ["iam", "list-open-id-connect-providers"]])

    def test_use_existing_validates_exact_arn_url_and_audience(self):
        arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
        responses = [
            {"Account": "123456789012"},
            {"OpenIDConnectProviderList": [{"Arn": arn}]},
            {"Url": "token.actions.githubusercontent.com", "ClientIDList": ["sts.amazonaws.com"]},
        ]
        with mock.patch.object(ci_bootstrap_preflight, "aws_json", side_effect=responses):
            result = ci_bootstrap_preflight.validate_preflight(
                provider_mode="use-existing",
                existing_provider_arn=arn,
                expected_account_id="123456789012",
                stack_name="ian-photography-ci-bootstrap",
                region="us-west-2",
                profile="production",
            )
        self.assertEqual(result["selectedProviderArn"], arn)
        self.assertEqual(result["githubRepository"], "iant4093/photographywebsite")
        self.assertEqual(
            result["oidcSubject"],
            "repo:iant4093/photographywebsite:ref:refs/heads/main",
        )
        self.assertNotIn("githubEnvironments", result)

    def test_preflight_fails_closed_on_account_conflict_provider_and_bad_provider_contract(self):
        base = dict(
            provider_mode="create",
            existing_provider_arn="",
            expected_account_id="123456789012",
            stack_name="ian-photography-ci-bootstrap",
            region="us-west-2",
            profile=None,
        )
        with mock.patch.object(ci_bootstrap_preflight, "aws_json", return_value={"Account": "999999999999"}):
            with self.assertRaises(SystemExit):
                ci_bootstrap_preflight.validate_preflight(**base)

        arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
        with mock.patch.object(
            ci_bootstrap_preflight,
            "aws_json",
            side_effect=[{"Account": "123456789012"}, {"OpenIDConnectProviderList": [{"Arn": arn}]}],
        ):
            with self.assertRaisesRegex(SystemExit, "already exists"):
                ci_bootstrap_preflight.validate_preflight(**base)

        use = {**base, "provider_mode": "use-existing", "existing_provider_arn": arn}
        with mock.patch.object(
            ci_bootstrap_preflight,
            "aws_json",
            side_effect=[
                {"Account": "123456789012"},
                {"OpenIDConnectProviderList": [{"Arn": arn}]},
                {"Url": "token.actions.githubusercontent.com", "ClientIDList": ["wrong"]},
            ],
        ):
            with self.assertRaisesRegex(SystemExit, "audience"):
                ci_bootstrap_preflight.validate_preflight(**use)


if __name__ == "__main__":
    unittest.main()
