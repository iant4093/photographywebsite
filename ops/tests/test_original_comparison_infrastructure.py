"""Deployment contracts for private, read-only camera-original comparisons."""

from __future__ import annotations

import ast
import fnmatch
import json
from pathlib import Path
import re
import sys
import unittest

from cfnlint.decode import decode


ROOT = Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
if str(OPS) not in sys.path:
    sys.path.insert(0, str(OPS))

import cloudfront_frontend  # noqa: E402


API_READERS = {
    "GetPublicAlbumFunction", "GetAlbumFunction", "GetAdminAlbumMediaFunction", "GetSharedAlbumFunction",
    "CreateAlbumFunction", "AddImagesFunction",
}
UPLOAD_COMPLETERS = {"CreateAlbumFunction", "AddImagesFunction"}
BACKGROUND_FUNCTIONS = {"OriginalIndexRefreshFunction", "OriginalComparisonWorkerFunction"}


def sequence(value):
    return value if isinstance(value, list) else [value]


def statements(value):
    """Find IAM statements including conditional SAM policy branches."""
    if isinstance(value, dict):
        if "Effect" in value and "Action" in value:
            yield value
        for child in value.values():
            yield from statements(child)
    elif isinstance(value, list):
        for child in value:
            yield from statements(child)


def parse_csp(value):
    return {tokens[0]: set(tokens[1:]) for directive in value.split(";") if (tokens := directive.split())}


def local_imports(path):
    imports = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.ImportFrom) and node.module:
            imports.add(node.module.split(".", 1)[0])
        elif isinstance(node, ast.Import):
            imports.update(alias.name.split(".", 1)[0] for alias in node.names)
    return imports


class OriginalInfrastructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template, errors = decode(str(ROOT / "backend" / "template.yaml"))
        if errors:
            raise AssertionError(f"Application template decode failed: {len(errors)} errors")
        cls.bootstrap, errors = decode(str(OPS / "ci_bootstrap_template.yaml"))
        if errors:
            raise AssertionError(f"CI template decode failed: {len(errors)} errors")
        cls.resources = cls.template["Resources"]
        cls.makefile = (ROOT / "backend" / "Makefile").read_text(encoding="utf-8")
        cls.sources = {
            logical_id: set(value.split())
            for logical_id, value in re.findall(r"^SOURCES_(\w+)\s*:=\s*(.+)$", cls.makefile, re.MULTILINE)
        }

    def function(self, logical_id):
        resource = self.resources[logical_id]
        self.assertEqual(resource["Type"], "AWS::Serverless::Function")
        return resource["Properties"]

    def allowed(self, logical_id):
        return [entry for entry in statements(self.function(logical_id)["Policies"]) if entry["Effect"] == "Allow"]

    def test_original_preview_storage_stays_private_encrypted_and_retained(self):
        bucket = self.resources["OriginalPreviewBucket"]
        self.assertEqual(bucket["Type"], "AWS::S3::Bucket")
        self.assertEqual(bucket["DeletionPolicy"], "Retain")
        self.assertEqual(bucket["UpdateReplacePolicy"], "Retain")
        properties = bucket["Properties"]
        self.assertEqual(properties["PublicAccessBlockConfiguration"], {
            "BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True,
        })
        self.assertEqual(properties["OwnershipControls"]["Rules"], [{"ObjectOwnership": "BucketOwnerEnforced"}])
        self.assertEqual(properties["BucketEncryption"]["ServerSideEncryptionConfiguration"], [
            {"ServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}},
        ])
        self.assertNotIn("WebsiteConfiguration", properties)
        policy = self.resources["OriginalPreviewBucketPolicy"]["Properties"]["PolicyDocument"]
        self.assertFalse([entry for entry in statements(policy) if entry["Effect"] == "Allow"])
        deny = next(entry for entry in statements(policy) if entry.get("Sid") == "DenyInsecureTransport")
        self.assertEqual(deny["Condition"], {"Bool": {"aws:SecureTransport": "false"}})
        self.assertEqual(deny["Principal"], "*")
        self.assertEqual(deny["Action"], "s3:*")
        # Public gallery delivery uses short-lived signatures; the archive index
        # has no CloudFront origin or public bucket policy path.
        for resource in self.resources.values():
            if resource["Type"] == "AWS::CloudFront::Distribution":
                origins = resource["Properties"]["DistributionConfig"]["Origins"]
                self.assertNotIn("OriginalPreviewBucket", json.dumps(origins))

    def test_only_index_snapshots_expire_and_preview_cors_is_read_only(self):
        properties = self.resources["OriginalPreviewBucket"]["Properties"]
        expiry_rules = [rule for rule in properties["LifecycleConfiguration"]["Rules"] if "ExpirationInDays" in rule]
        self.assertTrue(expiry_rules)
        self.assertTrue(all(rule.get("Prefix") == "index/" and rule["ExpirationInDays"] >= 7 for rule in expiry_rules))
        cors = properties["CorsConfiguration"]["CorsRules"]
        self.assertEqual(len(cors), 1)
        self.assertEqual(cors[0]["AllowedOrigins"], [{"Ref": "FrontendUrl"}])
        self.assertEqual(set(cors[0]["AllowedMethods"]), {"GET", "HEAD"})
        self.assertNotIn("*", cors[0].get("AllowedHeaders", []))

    def test_match_records_are_independent_recoverable_and_deletion_protected(self):
        table = self.resources["OriginalComparisonTable"]
        self.assertEqual(table["Type"], "AWS::DynamoDB::Table")
        self.assertEqual(table["DeletionPolicy"], "Retain")
        self.assertEqual(table["UpdateReplacePolicy"], "Retain")
        properties = table["Properties"]
        self.assertIs(properties["DeletionProtectionEnabled"], True)
        self.assertIs(properties["PointInTimeRecoverySpecification"]["PointInTimeRecoveryEnabled"], True)
        self.assertEqual(properties["BillingMode"], "PAY_PER_REQUEST")
        self.assertEqual(properties["KeySchema"], [
            {"AttributeName": "albumId", "KeyType": "HASH"},
            {"AttributeName": "mediaId", "KeyType": "RANGE"},
        ])
        self.assertNotIn("TimeToLiveSpecification", properties)

    def test_background_roles_cannot_mutate_website_sources_or_delete_data(self):
        expected_s3 = {
            "OriginalIndexRefreshFunction": {
                ("s3:GetObject", "${OriginalPreviewBucket.Arn}/index/*"),
                ("s3:PutObject", "${OriginalPreviewBucket.Arn}/index/*"),
            },
            "OriginalComparisonWorkerFunction": {
                ("s3:GetObject", "${ImagesBucket.Arn}/albums/*"),
                ("s3:GetObject", "${OriginalPreviewBucket.Arn}/index/*"),
                ("s3:PutObject", "${OriginalPreviewBucket.Arn}/before/*"),
            },
        }
        for logical_id in BACKGROUND_FUNCTIONS:
            with self.subTest(function=logical_id):
                permissions = self.allowed(logical_id)
                actions = {action for entry in permissions for action in sequence(entry["Action"])}
                self.assertFalse(actions.intersection({
                    "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectAcl", "s3:PutObjectTagging",
                    "dynamodb:DeleteItem", "dynamodb:DeleteTable", "ssm:PutParameter", "lambda:InvokeFunction",
                }))
                self.assertTrue(all("*" not in action for action in actions))
                self.assertTrue(all(entry["Resource"] != "*" for entry in permissions))
                actual_s3 = {
                    (action, entry["Resource"]["Fn::Sub"])
                    for entry in permissions for action in sequence(entry["Action"]) if action.startswith("s3:")
                }
                self.assertEqual(actual_s3, expected_s3[logical_id])
                secrets = [entry for entry in permissions if "ssm:GetParameter" in sequence(entry["Action"])]
                self.assertEqual(len(secrets), 1)
                self.assertEqual(secrets[0]["Resource"], {
                    "Fn::Sub": "arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter${GoogleOAuthSecretArn}",
                })
                self.assertEqual(self.function(logical_id)["Environment"]["Variables"]["GOOGLE_OAUTH_PARAMETER"], {"Ref": "GoogleOAuthSecretArn"})
                kms_branches = [
                    policy["Fn::If"] for policy in self.function(logical_id)["Policies"]
                    if isinstance(policy, dict) and "Fn::If" in policy
                    and policy["Fn::If"][0] == "HasApplicationSecretsKmsKey"
                ]
                self.assertEqual(kms_branches, [[
                    "HasApplicationSecretsKmsKey",
                    {"Statement": [{"Effect": "Allow", "Action": "kms:Decrypt", "Resource": {"Ref": "ApplicationSecretsKmsKeyArn"}}]},
                    {"Ref": "AWS::NoValue"},
                ]])
                self.assertNotIn("kms:GenerateDataKey", actions)

    def test_api_readers_can_sign_only_before_previews_and_cannot_read_drive_credentials(self):
        consumers = {
            name for name, resource in self.resources.items()
            if resource["Type"] == "AWS::Serverless::Function"
            and "ORIGINAL_COMPARISON_TABLE" in resource["Properties"].get("Environment", {}).get("Variables", {})
        }
        self.assertEqual(consumers, API_READERS | BACKGROUND_FUNCTIONS)
        for logical_id in API_READERS:
            with self.subTest(function=logical_id):
                function = self.function(logical_id)
                variables = function["Environment"]["Variables"]
                self.assertNotIn("GOOGLE_OAUTH_PARAMETER", variables)
                for env, target in (("ORIGINAL_COMPARISON_TABLE", "OriginalComparisonTable"), ("ORIGINAL_PREVIEW_BUCKET", "OriginalPreviewBucket")):
                    self.assertEqual(variables[env], {"Fn::If": ["EnableOriginalComparisons", {"Ref": target}, ""]})
                permissions = self.allowed(logical_id)
                original_s3 = [entry for entry in permissions if "OriginalPreviewBucket" in json.dumps(entry["Resource"])]
                self.assertEqual(original_s3, [{
                    "Effect": "Allow", "Action": "s3:GetObject", "Resource": {"Fn::Sub": "${OriginalPreviewBucket.Arn}/before/*"},
                }])
                table = [entry for entry in permissions if entry["Resource"] == {"Fn::GetAtt": ["OriginalComparisonTable", "Arn"]}]
                expected = {"dynamodb:BatchGetItem"} | ({"dynamodb:UpdateItem"} if logical_id in UPLOAD_COMPLETERS else set())
                self.assertEqual({action for entry in table for action in sequence(entry["Action"])}, expected)

    def test_only_committed_upload_handlers_and_reconciler_enqueue_comparisons(self):
        queue_consumers = {
            name for name, resource in self.resources.items()
            if resource["Type"] == "AWS::Serverless::Function"
            and "ORIGINAL_COMPARISON_QUEUE_URL" in resource["Properties"].get("Environment", {}).get("Variables", {})
        }
        self.assertEqual(queue_consumers, UPLOAD_COMPLETERS | {"OriginalIndexRefreshFunction"})
        for logical_id in UPLOAD_COMPLETERS:
            function = self.function(logical_id)
            self.assertEqual(function["Environment"]["Variables"]["ORIGINAL_COMPARISON_QUEUE_URL"], {
                "Fn::If": ["EnableOriginalComparisons", {"Ref": "OriginalComparisonQueue"}, ""],
            })
            grants = [entry for entry in self.allowed(logical_id) if entry["Resource"] == {"Fn::GetAtt": ["OriginalComparisonQueue", "Arn"]}]
            self.assertEqual(grants, [{"Effect": "Allow", "Action": "sqs:SendMessage", "Resource": {"Fn::GetAtt": ["OriginalComparisonQueue", "Arn"]}}])
            self.assertIn("original_comparison_jobs.py", self.sources[logical_id])
        self.assertNotIn("original_comparison_jobs.py", self.sources["GetUploadUrlFunction"])

    def test_disable_switch_stops_background_work_and_queue_failures_are_bounded(self):
        condition = self.template["Conditions"]["EnableOriginalComparisons"]
        self.assertEqual(condition, {"Fn::And": [
            {"Fn::Equals": [{"Ref": "OriginalComparisonsEnabled"}, "true"]},
            {"Fn::Not": [{"Fn::Equals": [{"Ref": "GoogleOAuthSecretArn"}, ""]}]},
        ]})
        worker = self.function("OriginalComparisonWorkerFunction")
        coordinator = self.function("OriginalIndexRefreshFunction")
        worker_event = worker["Events"]["OriginalComparisonJobs"]
        schedule = coordinator["Events"]["RefreshOriginalIndex"]
        self.assertEqual(worker_event["Type"], "SQS")
        self.assertEqual(schedule["Type"], "Schedule")
        for event in (worker_event, schedule):
            self.assertEqual(event["Properties"]["Enabled"], {"Fn::If": ["EnableOriginalComparisons", True, False]})
        self.assertEqual(worker_event["Properties"]["Queue"], {"Fn::GetAtt": ["OriginalComparisonQueue", "Arn"]})
        self.assertEqual(worker_event["Properties"]["BatchSize"], 1)
        self.assertEqual(worker_event["Properties"]["FunctionResponseTypes"], ["ReportBatchItemFailures"])
        self.assertEqual(worker_event["Properties"]["ScalingConfig"]["MaximumConcurrency"], worker["ReservedConcurrentExecutions"])
        self.assertLessEqual(worker["ReservedConcurrentExecutions"], 2)
        self.assertEqual(coordinator["ReservedConcurrentExecutions"], 1)
        self.assertEqual(schedule["Properties"]["Schedule"], "rate(15 minutes)")
        queue = self.resources["OriginalComparisonQueue"]["Properties"]
        dlq = self.resources["OriginalComparisonDeadLetterQueue"]["Properties"]
        self.assertGreaterEqual(queue["VisibilityTimeout"], worker["Timeout"] * 6)
        self.assertEqual(queue["RedrivePolicy"], {"deadLetterTargetArn": {"Fn::GetAtt": ["OriginalComparisonDeadLetterQueue", "Arn"]}, "maxReceiveCount": 5})
        self.assertTrue(queue["SqsManagedSseEnabled"] and dlq["SqsManagedSseEnabled"])
        self.assertGreaterEqual(dlq["MessageRetentionPeriod"], queue["MessageRetentionPeriod"])
        alarm = self.resources["OriginalComparisonFailureAlarm"]["Properties"]
        self.assertEqual(alarm["Namespace"], "AWS/SQS")
        self.assertEqual(alarm["Dimensions"], [{"Name": "QueueName", "Value": {"Fn::GetAtt": ["OriginalComparisonDeadLetterQueue", "QueueName"]}}])
        existing_route = self.resources["PreviewDeadLetterQueueAlarm"]["Properties"]["AlarmActions"]
        self.assertEqual(alarm["AlarmActions"], existing_route)
        registry = json.loads((OPS / "alarm_registry.json").read_text(encoding="utf-8"))
        groups = [group for group in registry["groups"] if "OriginalComparisonFailureAlarm" in group["logicalResourceIds"]]
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["route"], "security-notification-topic")

    def test_index_failures_have_a_scoped_native_alarm_and_documented_recovery(self):
        alarm = self.resources["OriginalIndexRefreshErrorsAlarm"]["Properties"]
        self.assertEqual(alarm["Namespace"], "AWS/Lambda")
        self.assertEqual(alarm["MetricName"], "Errors")
        self.assertEqual(alarm["Dimensions"], [{"Name": "FunctionName", "Value": {"Ref": "OriginalIndexRefreshFunction"}}])
        self.assertEqual(alarm["Statistic"], "Sum")
        self.assertLessEqual(alarm["Period"], 900)
        self.assertEqual(alarm["Threshold"], 1)
        self.assertEqual(alarm["TreatMissingData"], "notBreaching")
        self.assertEqual(alarm["AlarmActions"], self.resources["OriginalComparisonFailureAlarm"]["Properties"]["AlarmActions"])
        registry = json.loads((OPS / "alarm_registry.json").read_text(encoding="utf-8"))
        groups = [group for group in registry["groups"] if "OriginalIndexRefreshErrorsAlarm" in group["logicalResourceIds"]]
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["route"], "security-notification-topic")
        recovery = (OPS / "ALARM_REGISTRY.md").read_text(encoding="utf-8")
        self.assertIn("OriginalIndexRefreshErrorsAlarm", recovery)
        self.assertIn("PHOTO_ORIGINAL_COMPARISONS.md#failure-recovery-and-retention", recovery)

    def test_per_function_packages_include_local_access_dependency_without_archive_reader(self):
        shared_consumers = {name for name, sources in self.sources.items() if "media_access.py" in sources}
        self.assertTrue(API_READERS.issubset(shared_consumers))
        for logical_id in shared_consumers:
            with self.subTest(function=logical_id):
                self.assertIn("original_comparison_access.py", self.sources[logical_id])
                if logical_id not in BACKGROUND_FUNCTIONS:
                    self.assertTrue(self.sources[logical_id].isdisjoint({"original_drive.py", "original_match.py", "original_comparison_worker.py"}))
        module_paths = {path.stem: path for path in (ROOT / "backend" / "functions").glob("*.py")}
        for logical_id in BACKGROUND_FUNCTIONS:
            pending = [self.function(logical_id)["Handler"].split(".")[0]]
            modules = set(pending)
            while pending:
                module = pending.pop()
                for imported in local_imports(module_paths[module]).intersection(module_paths):
                    if imported not in modules:
                        modules.add(imported)
                        pending.append(imported)
            self.assertEqual(self.sources[logical_id], {f"{module}.py" for module in modules})
            self.assertTrue(all(re.fullmatch(r"[a-z_]+\.py", source) for source in self.sources[logical_id]))
        requirements = set((ROOT / "backend" / "functions" / "requirements.txt").read_text().splitlines())
        deps = dict(re.findall(r"^DEPS_(\w+)\s*:=\s*(.+)$", self.makefile, re.MULTILINE))
        for logical_id in BACKGROUND_FUNCTIONS:
            packages = deps[logical_id].split()
            self.assertTrue(all(package in requirements and "==" in package for package in packages))
            self.assertTrue({"google-auth", "requests", "ExifRead"}.issubset({package.split("==")[0] for package in packages}))
        self.assertTrue(any(package.startswith("Pillow==") for package in deps["OriginalComparisonWorkerFunction"].split()))
        self.assertIn("PIP_PLATFORM_OriginalComparisonWorkerFunction := manylinux_2_28_x86_64", self.makefile)
        self.assertIn("--only-binary=:all:", self.makefile)

    def test_physical_names_fit_existing_release_role_without_credential_reads(self):
        policy = self.bootstrap["Resources"]["CloudFormationExecutionDataAndMessagingPolicy"]["Properties"]["PolicyDocument"]
        by_sid = {entry["Sid"]: entry for entry in statements(policy)}
        bucket_rule = by_sid["ManageApplicationBuckets"]
        bucket_name = self.resources["OriginalPreviewBucket"]["Properties"]["BucketName"]["Fn::Sub"]
        self.assertTrue(any(fnmatch.fnmatch("arn:${AWS::Partition}:s3:::" + bucket_name, value["Fn::Sub"]) for value in sequence(bucket_rule["Resource"])))
        self.assertTrue({
            "s3:CreateBucket", "s3:GetBucketLocation", "s3:GetBucketPolicy", "s3:PutBucketPolicy",
            "s3:PutBucketPublicAccessBlock", "s3:PutBucketOwnershipControls", "s3:PutEncryptionConfiguration",
            "s3:PutLifecycleConfiguration", "s3:PutBucketCors", "s3:GetBucketCors",
        }.issubset(set(bucket_rule["Action"])))
        table_rule = by_sid["ManageApplicationTables"]
        table_name = self.resources["OriginalComparisonTable"]["Properties"]["TableName"]["Fn::Sub"]
        self.assertTrue(fnmatch.fnmatch("arn:${AWS::Partition}:dynamodb:us-west-2:${AWS::AccountId}:table/" + table_name, table_rule["Resource"]["Fn::Sub"]))
        self.assertTrue({"dynamodb:CreateTable", "dynamodb:UpdateTable", "dynamodb:UpdateContinuousBackups"}.issubset(set(table_rule["Action"])))
        queue_rule = by_sid["ManageApplicationQueuesAndTopics"]
        application_stack = self.bootstrap["Parameters"]["ApplicationStackName"]["Default"]
        for logical_id in ("OriginalComparisonQueue", "OriginalComparisonDeadLetterQueue"):
            properties = self.resources[logical_id]["Properties"]
            # Without QueueName, CloudFormation uses its actual stack name;
            # ian-website-* does not match the retained ian-photography-* grant.
            name = properties.get("QueueName", {"Fn::Sub": f"{application_stack}-{logical_id}-generated"})["Fn::Sub"]
            arn = "arn:${AWS::Partition}:sqs:us-west-2:${AWS::AccountId}:" + name
            self.assertTrue(any(fnmatch.fnmatch(arn, resource["Fn::Sub"]) for resource in sequence(queue_rule["Resource"])), logical_id)
        # Release infrastructure management never needs the Google private key;
        # only the two runtime readers resolve the narrow encrypted SSM name.
        for name, resource in self.bootstrap["Resources"].items():
            if name.startswith("CloudFormationExecution") or name in {"PlanRole", "ExecuteRole", "FrontendRole", "AuditRole"}:
                granted = {action for entry in statements(resource) if entry["Effect"] == "Allow" for action in sequence(entry["Action"])}
                self.assertTrue(granted.isdisjoint({"ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"}))


class OriginalPreviewCspTests(unittest.TestCase):
    def test_original_bucket_adds_exact_image_and_fetch_origins_only(self):
        baseline = json.loads((OPS / "frontend_cloudfront_baseline.json").read_text(encoding="utf-8"))
        args = {"media_domain": "media.example.test", "api_id": "api-id", "region": "us-west-2", "bucket": "website-images-test"}
        before = parse_csp(cloudfront_frontend.render_csp(baseline, **args))
        after = parse_csp(cloudfront_frontend.render_csp(baseline, **args, original_preview_bucket="originals-test"))
        expected = {"https://originals-test.s3.amazonaws.com", "https://originals-test.s3.us-west-2.amazonaws.com"}
        self.assertEqual(set(before), set(after))
        for directive in before:
            with self.subTest(directive=directive):
                self.assertEqual(after[directive] - before[directive], expected if directive in {"img-src", "connect-src"} else set())
                self.assertTrue(before[directive].issubset(after[directive]))
        self.assertFalse(any("*" in source or "googleapis.com/drive" in source for sources in after.values() for source in sources))
        self.assertEqual(cloudfront_frontend.render_csp(baseline, **args, original_preview_bucket=None), cloudfront_frontend.render_csp(baseline, **args))


if __name__ == "__main__":
    unittest.main()
