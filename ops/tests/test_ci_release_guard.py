from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ops.ci import (  # noqa: E402
    coverage_gate,
    credential_artifact_scan,
    bind_s3_versions,
    frontend_edge_posture,
    git_history_credential_scan,
    public_posture_smoke,
    release_guard,
    workflow_policy,
)


def private_key_marker(label: str = "", *, ending: bool = False) -> str:
    kind = f"{label} " if label else ""
    return "-----" + ("END" if ending else "BEGIN") + f" {kind}PRIVATE KEY-----"


def access_key_id(prefix: str, suffix: str) -> str:
    return prefix + suffix


def credentialed_url(
    scheme: str, username: str, password: str, host: str, path: str = ""
) -> bytes:
    return f"{scheme}://{username}:{password}@{host}{path}".encode()


def iam_credentials_discovery_document() -> dict[str, str]:
    return {
        "discoveryVersion": "v1",
        "id": "iamcredentials:v1",
        "name": "iamcredentials",
        "rootUrl": "https://iamcredentials.googleapis.com/",
        "version": "v1",
    }


def change(
    action="Modify",
    logical_id="OrdinaryFunction",
    replacement="False",
    recreation="Never",
    resource_type="AWS::Lambda::Function",
    property_name="Environment",
):
    return {
        "ResourceChange": {
            "Action": action,
            "LogicalResourceId": logical_id,
            "ResourceType": resource_type,
            "Replacement": replacement,
            "Details": [
                {
                    "Target": {
                        "Attribute": "Properties",
                        "Name": property_name,
                        "RequiresRecreation": recreation,
                    }
                }
            ],
        }
    }


class ChangeSetGateTests(unittest.TestCase):
    def test_accepts_all_pages_and_returns_safe_aggregate_counts(self):
        pages = [
            {"Changes": [change()]},
            {"Changes": [change(action="Add", logical_id="NewFunction", replacement=None)]},
        ]
        self.assertEqual(
            release_guard.gate_change_set(pages),
            {"Add": 1, "Modify": 1, "Total": 2},
        )

    def test_accepts_empty_change_set(self):
        self.assertEqual(
            release_guard.gate_change_set([{"Changes": []}]),
            {"Add": 0, "Modify": 0, "Total": 0},
        )

    def test_rejects_removal_unknown_action_and_protected_resources(self):
        cases = [
            change(action="Remove"),
            change(action="Import"),
            change(logical_id="AlbumsTable"),
            change(logical_id="GeneratedRole", resource_type="AWS::IAM::Role"),
        ]
        for item in cases:
            with self.subTest(item=item), self.assertRaises(release_guard.GateError):
                release_guard.gate_change_set([{"Changes": [item]}])

    def test_rejects_true_conditional_and_unknown_replacement(self):
        for replacement in ("True", "Conditional", "Maybe"):
            with self.subTest(replacement=replacement), self.assertRaises(release_guard.GateError):
                release_guard.gate_change_set([{"Changes": [change(replacement=replacement)]}])

    def test_rejects_recreation_and_unknown_recreation(self):
        for recreation in ("Always", "Conditionally", "Unknown"):
            with self.subTest(recreation=recreation), self.assertRaises(release_guard.GateError):
                release_guard.gate_change_set([{"Changes": [change(recreation=recreation)]}])

    def test_rejects_malformed_pages_entries_details_and_targets(self):
        malformed = [
            {},
            {"Changes": None},
            {"Changes": [None]},
            {"Changes": [{}]},
            {"Changes": [{"ResourceChange": {}}]},
            {"Changes": [change() | {"ResourceChange": change()["ResourceChange"] | {"Details": None}}]},
            {"Changes": [change() | {"ResourceChange": change()["ResourceChange"] | {"Details": [None]}}]},
            {"Changes": [change() | {"ResourceChange": change()["ResourceChange"] | {"Details": [{"Target": None}]}}]},
        ]
        for page in malformed:
            with self.subTest(page=page), self.assertRaises(release_guard.GateError):
                release_guard.gate_change_set([page])


class ReleaseIntentTests(unittest.TestCase):
    @staticmethod
    def intent(*, action="Modify", allow_no_details=False, property_paths=None):
        return {
            "version": 1,
            "rules": [
                {
                    "logicalId": "OrdinaryFunction",
                    "resourceType": "AWS::Lambda::Function",
                    "action": action,
                    "propertyPaths": (
                        ["Code", "Environment"]
                        if property_paths is None
                        else property_paths
                    ),
                    "allowNoDetails": allow_no_details,
                }
            ],
        }

    def test_exact_resource_action_and_property_subset_is_required(self):
        intent = release_guard.load_release_intent(self.intent())
        self.assertEqual(
            release_guard.gate_change_set(
                [{"Changes": [change(property_name="Environment"), change(property_name="Code")]}],
                release_intent=intent,
            ),
            {"Add": 0, "Modify": 2, "Total": 2},
        )
        for item in (
            change(logical_id="OtherFunction"),
            change(resource_type="AWS::Lambda::Version"),
            change(property_name="Tags"),
        ):
            with self.subTest(item=item), self.assertRaises(release_guard.GateError):
                release_guard.gate_change_set(
                    [{"Changes": [item]}], release_intent=intent
                )

    def test_missing_details_fail_unless_explicitly_allowed_for_exact_rule(self):
        item = change()
        item["ResourceChange"]["Details"] = []
        with self.assertRaises(release_guard.GateError):
            release_guard.gate_change_set(
                [{"Changes": [item]}],
                release_intent=release_guard.load_release_intent(self.intent()),
            )
        add_item = change(action="Add", replacement=None)
        add_item["ResourceChange"]["Details"] = []
        self.assertEqual(
            release_guard.gate_change_set(
                [{"Changes": [add_item]}],
                release_intent=release_guard.load_release_intent(
                    self.intent(
                        action="Add", allow_no_details=True, property_paths=[]
                    )
                ),
            )["Total"],
            1,
        )

    def test_release_intent_cannot_bypass_protected_rate_limit_table(self):
        intent = release_guard.load_release_intent(
            {
                "version": 1,
                "rules": [
                    {
                        "logicalId": "RateLimitTable",
                        "resourceType": "AWS::DynamoDB::Table",
                        "action": "Modify",
                        "propertyPaths": ["PointInTimeRecoverySpecification"],
                        "allowNoDetails": False,
                    }
                ],
            }
        )
        pitr_change = change(
            logical_id="RateLimitTable",
            resource_type="AWS::DynamoDB::Table",
            property_name="PointInTimeRecoverySpecification",
            replacement="False",
            recreation="Never",
        )
        with self.assertRaises(release_guard.GateError):
            release_guard.gate_change_set(
                [{"Changes": [pitr_change]}], release_intent=intent
            )

    def test_intent_schema_rejects_wildcards_duplicates_unknowns_and_bad_shapes(self):
        base = self.intent()
        cases = [
            {},
            {"version": 2, "rules": []},
            {"version": 1, "rules": []},
            base | {"extra": True},
            {"version": 1, "rules": [base["rules"][0] | {"propertyPaths": ["*"]}]},
            {"version": 1, "rules": [base["rules"][0] | {"propertyPaths": []}]},
            {
                "version": 1,
                "rules": [base["rules"][0] | {"allowNoDetails": True}],
            },
            {"version": 1, "rules": [base["rules"][0], base["rules"][0]]},
            {"version": 1, "rules": [base["rules"][0] | {"unknown": True}]},
        ]
        for document in cases:
            with self.subTest(document=document), self.assertRaises(release_guard.GateError):
                release_guard.load_release_intent(document)

    def test_tracked_intent_exactly_covers_release_code_and_alarm_routing(self):
        document = json.loads(
            (ROOT / "ops/ci/release_intent.json").read_text(encoding="utf-8")
        )
        release_guard.load_release_intent(document)
        template = (ROOT / "backend/template.yaml").read_text(encoding="utf-8")
        logical_ids = set(
            re.findall(
                r"(?m)^  ([A-Za-z0-9]+):\n    Type: AWS::Serverless::Function$",
                template,
            )
        )
        lambda_rules = [
            rule for rule in document["rules"]
            if rule["resourceType"] == "AWS::Lambda::Function"
            and rule["action"] == "Modify"
        ]
        self.assertEqual({rule["logicalId"] for rule in lambda_rules}, logical_ids)
        for rule in lambda_rules:
            self.assertEqual(rule["resourceType"], "AWS::Lambda::Function")
            self.assertEqual(rule["action"], "Modify")
            expected_paths = ["Code", "Environment"]
            if rule["logicalId"] == "GetPhotographyStatsFunction":
                expected_paths.append("ReservedConcurrentExecutions")
            self.assertEqual(rule["propertyPaths"], expected_paths)
            self.assertFalse(rule["allowNoDetails"])

        alarm_ids = set(
            re.findall(
                r"(?m)^  ([A-Za-z0-9]+):\n    Type: AWS::CloudWatch::Alarm$",
                template,
            )
        )
        alarm_rules = [
            rule for rule in document["rules"]
            if rule["resourceType"] == "AWS::CloudWatch::Alarm"
        ]
        self.assertEqual({rule["logicalId"] for rule in alarm_rules}, alarm_ids)
        for rule in alarm_rules:
            self.assertEqual(rule["action"], "Modify")
            expected_paths = (
                ["AlarmActions", "AlarmDescription", "Threshold"]
                if rule["logicalId"] == "FrontDoorDeniedAlarm"
                else ["AlarmActions"]
            )
            self.assertEqual(rule["propertyPaths"], expected_paths)
            self.assertFalse(rule["allowNoDetails"])

        role_rules = [
            rule for rule in document["rules"]
            if rule["resourceType"] == "AWS::IAM::Role"
            and rule["action"] == "Modify"
        ]
        self.assertEqual(
            {rule["logicalId"] for rule in role_rules},
            {
                "CreateAlbumFunctionRole",
                "AddImagesFunctionRole",
                "DeleteAlbumFunctionRole",
                "DeleteImagesFunctionRole",
                "UpdateAlbumFunctionRole",
                "UpdateGalleryOrderFunctionRole",
                "UpdateImageFunctionRole",
                "CreateZipFunctionRole",
                "GetAlbumsFunctionRole",
                "GetPublicAlbumFunctionRole",
                "GetPublicAlbumsFunctionRole",
                "HeroCoverFunctionRole",
                "PreviewWorkerFunctionRole",
                "PreparePrintFunctionRole",
                "RefreshGoogleDriveUsageFunctionRole",
            },
        )
        for rule in role_rules:
            self.assertEqual(rule["action"], "Modify")
            self.assertEqual(rule["propertyPaths"], ["Policies"])
            self.assertTrue(rule["allowProtectedModify"])
            self.assertFalse(rule["allowNoDetails"])

        api_rules = [
            rule for rule in document["rules"]
            if rule["logicalId"] == "Api" and rule["action"] == "Modify"
        ]
        self.assertEqual(len(api_rules), 1)
        self.assertEqual(api_rules[0]["resourceType"], "AWS::ApiGatewayV2::Api")
        self.assertEqual(api_rules[0]["propertyPaths"], ["Body"])
        self.assertTrue(api_rules[0]["allowProtectedModify"])
        self.assertFalse(api_rules[0]["allowNoDetails"])

        bucket_policy_rules = [
            rule for rule in document["rules"]
            if rule["resourceType"] == "AWS::S3::BucketPolicy"
            and rule["action"] == "Modify"
        ]
        self.assertEqual(
            {rule["logicalId"] for rule in bucket_policy_rules},
            {"ImagesBucketPolicy", "MediaAccessLogsBucketPolicy"},
        )
        for rule in bucket_policy_rules:
            self.assertEqual(rule["propertyPaths"], ["PolicyDocument"])
            self.assertTrue(rule["allowProtectedModify"])
            self.assertFalse(rule["allowNoDetails"])

        add_rules = {
            (rule["logicalId"], rule["resourceType"])
            for rule in document["rules"]
            if rule["action"] == "Add"
        }
        self.assertEqual(
            add_rules,
            {
                ("AnalyticsTable", "AWS::DynamoDB::Table"),
                ("AnalyticsIngestFunction", "AWS::Lambda::Function"),
                ("AnalyticsIngestFunctionRole", "AWS::IAM::Role"),
                ("AnalyticsIngestFunctionIngestAnalyticsPermission", "AWS::Lambda::Permission"),
                ("GetAnalyticsReportFunction", "AWS::Lambda::Function"),
                ("GetAnalyticsReportFunctionRole", "AWS::IAM::Role"),
                ("GetAnalyticsReportFunctionGetAnalyticsReportPermission", "AWS::Lambda::Permission"),
                ("GetPublicAlbumFunctionGetAlbumSocialPreviewPermission", "AWS::Lambda::Permission"),
                ("GetPublicAlbumFunctionGetRandomPhotosPermission", "AWS::Lambda::Permission"),
                ("GetPublicAlbumFunctionGetExplorePermission", "AWS::Lambda::Permission"),
                ("RandomPhotoPoolBuilderFunction", "AWS::Lambda::Function"),
                ("RandomPhotoPoolBuilderFunctionRole", "AWS::IAM::Role"),
                ("RandomPhotoPoolBuilderFunctionAlbumsChanged", "AWS::Lambda::EventSourceMapping"),
                ("CostReportCacheTable", "AWS::DynamoDB::Table"),
                ("GetCostReportFunction", "AWS::Lambda::Function"),
                ("GetCostReportFunctionRole", "AWS::IAM::Role"),
                ("GetCostReportFunctionGetCostReportPermission", "AWS::Lambda::Permission"),
                ("DriveUsageCacheTable", "AWS::DynamoDB::Table"),
                ("GetGoogleDriveUsageFunction", "AWS::Lambda::Function"),
                ("GetGoogleDriveUsageFunctionRole", "AWS::IAM::Role"),
                ("GetGoogleDriveUsageFunctionGetGoogleDriveUsagePermission", "AWS::Lambda::Permission"),
                ("GetPhotographyStatsFunction", "AWS::Lambda::Function"),
                ("GetPhotographyStatsFunctionRole", "AWS::IAM::Role"),
                ("GetPhotographyStatsFunctionGetPhotographyStatsPermission", "AWS::Lambda::Permission"),
                ("RefreshGoogleDriveUsageFunction", "AWS::Lambda::Function"),
                ("RefreshGoogleDriveUsageFunctionRole", "AWS::IAM::Role"),
                ("RefreshGoogleDriveUsageFunctionDriveUsageDailyRefresh", "AWS::Events::Rule"),
                ("RefreshGoogleDriveUsageFunctionDriveUsageDailyRefreshPermission", "AWS::Lambda::Permission"),
                ("GallerySettingsTable", "AWS::DynamoDB::Table"),
                ("UpdateGalleryOrderFunction", "AWS::Lambda::Function"),
                ("UpdateGalleryOrderFunctionRole", "AWS::IAM::Role"),
                ("UpdateGalleryOrderFunctionUpdateGalleryOrderPermission", "AWS::Lambda::Permission"),
                ("PublicPreviewCachePolicy", "AWS::CloudFront::CachePolicy"),
                ("PublicPreviewResponseHeadersPolicy", "AWS::CloudFront::ResponseHeadersPolicy"),
                ("PublicPreviewRewriteFunction", "AWS::CloudFront::Function"),
                ("PrintSessionSecret", "AWS::SecretsManager::Secret"),
                ("PreparePrintFunction", "AWS::Lambda::Function"),
                ("PreparePrintFunctionRole", "AWS::IAM::Role"),
                ("PreparePrintFunctionAlbumPrintSessionPermission", "AWS::Lambda::Permission"),
                ("PreparePrintFunctionSharedPrintSessionPermission", "AWS::Lambda::Permission"),
                ("PreparePrintFunctionRedeemPrintSessionPermission", "AWS::Lambda::Permission"),
                ("GitHubAnalyticsCacheTable", "AWS::DynamoDB::Table"),
                ("GetGitHubAnalyticsFunction", "AWS::Lambda::Function"),
                ("GetGitHubAnalyticsFunctionRole", "AWS::IAM::Role"),
                ("GetGitHubAnalyticsFunctionGetGitHubAnalyticsPermission", "AWS::Lambda::Permission"),
                ("RefreshGitHubAnalyticsFunction", "AWS::Lambda::Function"),
                ("RefreshGitHubAnalyticsFunctionRole", "AWS::IAM::Role"),
                ("RefreshGitHubAnalyticsFunctionGitHubAnalyticsHourlyRefresh", "AWS::Events::Rule"),
                ("RefreshGitHubAnalyticsFunctionGitHubAnalyticsHourlyRefreshPermission", "AWS::Lambda::Permission"),
                ("GetSiteHealthFunction", "AWS::Lambda::Function"),
                ("GetSiteHealthFunctionRole", "AWS::IAM::Role"),
                ("GetSiteHealthFunctionGetSiteHealthPermission", "AWS::Lambda::Permission"),
                ("GetAuditLogFunction", "AWS::Lambda::Function"),
                ("GetAuditLogFunctionRole", "AWS::IAM::Role"),
                ("GetAuditLogFunctionGetAuditLogPermission", "AWS::Lambda::Permission"),
            },
        )
        for rule in document["rules"]:
            if rule["action"] == "Add":
                self.assertEqual(rule["propertyPaths"], [])
                self.assertTrue(rule["allowNoDetails"])

        self.assertFalse(any(rule["action"] == "Remove" for rule in document["rules"]))

    def test_exact_add_intent_can_introduce_but_never_modify_a_protected_resource(self):
        document = {
            "version": 1,
            "rules": [{
                "logicalId": "NewRole",
                "resourceType": "AWS::IAM::Role",
                "action": "Add",
                "propertyPaths": ["Policies"],
                "allowNoDetails": True,
            }],
        }
        intent = release_guard.load_release_intent(document)
        added = change(
            action="Add",
            logical_id="NewRole",
            resource_type="AWS::IAM::Role",
            replacement=None,
        )
        added["ResourceChange"]["Details"] = []
        self.assertEqual(
            release_guard.gate_change_set(
                [{"Changes": [added]}], release_intent=intent
            ),
            {"Add": 1, "Modify": 0, "Total": 1},
        )

        modified = change(
            action="Modify",
            logical_id="NewRole",
            resource_type="AWS::IAM::Role",
            property_name="Policies",
        )
        with self.assertRaises(release_guard.GateError):
            release_guard.gate_change_set(
                [{"Changes": [modified]}], release_intent=intent
            )

    def test_exact_exception_can_modify_but_never_replace_a_protected_resource(self):
        document = {
            "version": 1,
            "rules": [{
                "logicalId": "ProtectedDistribution",
                "resourceType": "AWS::CloudFront::Distribution",
                "action": "Modify",
                "propertyPaths": ["DistributionConfig"],
                "allowNoDetails": False,
                "allowProtectedModify": True,
            }],
        }
        intent = release_guard.load_release_intent(document)
        modified = change(
            logical_id="ProtectedDistribution",
            resource_type="AWS::CloudFront::Distribution",
            property_name="DistributionConfig",
            replacement="False",
        )
        self.assertEqual(
            release_guard.gate_change_set(
                [{"Changes": [modified]}], release_intent=intent
            ),
            {"Add": 0, "Modify": 1, "Total": 1},
        )

        replaced = change(
            logical_id="ProtectedDistribution",
            resource_type="AWS::CloudFront::Distribution",
            property_name="DistributionConfig",
            replacement="True",
        )
        with self.assertRaises(release_guard.GateError):
            release_guard.gate_change_set(
                [{"Changes": [replaced]}], release_intent=intent
            )

        invalid_add = document["rules"][0] | {
            "action": "Add",
            "allowNoDetails": True,
        }
        with self.assertRaises(release_guard.GateError):
            release_guard.load_release_intent({"version": 1, "rules": [invalid_add]})

    def test_exact_exception_can_approve_retention_attributes(self):
        document = {
            "version": 1,
            "rules": [{
                "logicalId": "RateLimitTable",
                "resourceType": "AWS::DynamoDB::Table",
                "action": "Modify",
                "propertyPaths": [
                    "DeletionPolicy",
                    "DeletionProtectionEnabled",
                    "UpdateReplacePolicy",
                ],
                "allowNoDetails": False,
                "allowProtectedModify": True,
            }],
        }
        item = change(
            logical_id="RateLimitTable",
            resource_type="AWS::DynamoDB::Table",
            property_name="DeletionProtectionEnabled",
        )
        item["ResourceChange"]["Details"].extend([
            {
                "Target": {
                    "Attribute": "DeletionPolicy",
                    "RequiresRecreation": "Never",
                }
            },
            {
                "Target": {
                    "Attribute": "UpdateReplacePolicy",
                    "RequiresRecreation": "Never",
                }
            },
        ])
        intent = release_guard.load_release_intent(document)
        self.assertEqual(
            release_guard.gate_change_set(
                [{"Changes": [item]}], release_intent=intent
            )["Total"],
            1,
        )
        item["ResourceChange"]["Details"][1]["Target"]["Attribute"] = "Metadata"
        with self.assertRaises(release_guard.GateError):
            release_guard.gate_change_set(
                [{"Changes": [item]}], release_intent=intent
            )


class ReleaseDependencyTests(unittest.TestCase):
    @staticmethod
    def document():
        return {
            "version": 1,
            "rules": [
                {
                    "logicalId": "GeneratedRole",
                    "resourceType": "AWS::IAM::Role",
                    "propertyPath": "Policies",
                    "causingEntities": ["OrdinaryFunction.Arn"],
                }
            ],
        }

    @staticmethod
    def dynamic_change():
        item = change(
            logical_id="GeneratedRole",
            resource_type="AWS::IAM::Role",
            property_name="Policies",
        )
        item["ResourceChange"]["Details"][0].update(
            {
                "Evaluation": "Dynamic",
                "ChangeSource": "ResourceAttribute",
                "CausingEntity": "OrdinaryFunction.Arn",
            }
        )
        return item

    def test_exact_dynamic_dependency_allows_only_the_reviewed_cascade(self):
        dependencies = release_guard.load_release_dependencies(self.document())
        intent = release_guard.load_release_intent(ReleaseIntentTests.intent())
        self.assertEqual(
            release_guard.gate_change_set(
                [{"Changes": [self.dynamic_change()]}],
                release_intent=intent,
                release_dependencies=dependencies,
            ),
            {"Add": 0, "Modify": 1, "Total": 1},
        )

        for field, value in (
            ("Evaluation", "Static"),
            ("ChangeSource", "DirectModification"),
            ("CausingEntity", "OtherFunction.Arn"),
        ):
            item = self.dynamic_change()
            item["ResourceChange"]["Details"][0][field] = value
            with self.subTest(field=field), self.assertRaises(release_guard.GateError):
                release_guard.gate_change_set(
                    [{"Changes": [item]}],
                    release_intent=intent,
                    release_dependencies=dependencies,
                )

    def test_exact_dynamic_dependency_can_allow_conditional_recreation(self):
        dependencies = release_guard.load_release_dependencies(self.document())
        intent = release_guard.load_release_intent(ReleaseIntentTests.intent())
        item = self.dynamic_change()
        item["ResourceChange"]["Replacement"] = "Conditional"
        item["ResourceChange"]["Details"][0]["Target"][
            "RequiresRecreation"
        ] = "Always"
        self.assertEqual(
            release_guard.gate_change_set(
                [{"Changes": [item]}],
                release_intent=intent,
                release_dependencies=dependencies,
            )["Total"],
            1,
        )
        item["ResourceChange"]["Details"][0]["CausingEntity"] = (
            "OtherFunction.Arn"
        )
        with self.assertRaises(release_guard.GateError):
            release_guard.gate_change_set(
                [{"Changes": [item]}],
                release_intent=intent,
                release_dependencies=dependencies,
            )

    def test_dependency_never_authorizes_a_direct_protected_edit(self):
        dependencies = release_guard.load_release_dependencies(self.document())
        intent = release_guard.load_release_intent(ReleaseIntentTests.intent())
        with self.assertRaises(release_guard.GateError):
            release_guard.gate_change_set(
                [
                    {
                        "Changes": [
                            change(
                                logical_id="GeneratedRole",
                                resource_type="AWS::IAM::Role",
                                property_name="Policies",
                            )
                        ]
                    }
                ],
                release_intent=intent,
                release_dependencies=dependencies,
            )

    def test_dependency_schema_is_exact_and_tracked_policy_is_valid(self):
        document = json.loads(
            (ROOT / "ops/ci/release_dependencies.json").read_text(encoding="utf-8")
        )
        rules = release_guard.load_release_dependencies(document)
        self.assertEqual(len(rules), len(document["rules"]))
        for logical_id in (
            "CompleteChallengeFunctionRole",
            "CreateUserFunctionRole",
            "DeleteUserFunctionRole",
            "EditUserFunctionRole",
            "ListUsersFunctionRole",
            "LoginFunctionRole",
        ):
            self.assertIn(
                "UserPool.Arn",
                rules[(logical_id, "AWS::IAM::Role", "Policies")],
            )
        for logical_id, role_id in (
            ("CreateUserFunction", "CreateUserFunctionRole"),
            ("EditUserFunction", "EditUserFunctionRole"),
            ("ListUsersFunction", "ListUsersFunctionRole"),
            ("TagMediaObjectFunction", "TagMediaObjectFunctionRole"),
        ):
            self.assertEqual(
                rules[(logical_id, "AWS::Lambda::Function", "Role")],
                frozenset({f"{role_id}.Arn"}),
            )
        for logical_id in (
            "DeleteUserFunctionRole",
            "EditUserFunctionRole",
            "GetDownloadUrlFunctionRole",
            "GetSharedAlbumFunctionRole",
            "GoogleDriveBackupFunctionRole",
            "TagMediaObjectFunctionRole",
            "WorkerZipFunctionRole",
        ):
            self.assertIn(
                "AlbumsTable.Arn",
                rules[(logical_id, "AWS::IAM::Role", "Policies")],
            )
        base = self.document()
        cases = [
            {},
            {"version": 2, "rules": []},
            {"version": 1, "rules": []},
            base | {"unknown": True},
            {"version": 1, "rules": [base["rules"][0], base["rules"][0]]},
            {
                "version": 1,
                "rules": [base["rules"][0] | {"causingEntities": ["*"]}],
            },
            {
                "version": 1,
                "rules": [base["rules"][0] | {"unknown": True}],
            },
        ]
        for candidate in cases:
            with self.subTest(candidate=candidate), self.assertRaises(release_guard.GateError):
                release_guard.load_release_dependencies(candidate)


class StackGuardTests(unittest.TestCase):
    def test_previous_parameters_contains_keys_only(self):
        stack = {
            "Parameters": [
                {"ParameterKey": "SecretArn", "ParameterValue": "never-copy-this"},
                {"ParameterKey": "Stage", "ParameterValue": "prod"},
            ]
        }
        self.assertEqual(
            release_guard.previous_parameter_payload(stack),
            [
                {"ParameterKey": "SecretArn", "UsePreviousValue": True},
                {"ParameterKey": "Stage", "UsePreviousValue": True},
            ],
        )

    def test_release_sha_is_exact_and_new_parameter_is_added(self):
        sha = "a" * 40
        existing = release_guard.previous_parameter_payload(
            {"Parameters": [{"ParameterKey": "Stage"}, {"ParameterKey": "ReleaseSha"}]},
            release_sha=sha,
        )
        self.assertEqual(existing[-1], {"ParameterKey": "ReleaseSha", "ParameterValue": sha})
        new = release_guard.previous_parameter_payload(
            {"Parameters": [{"ParameterKey": "Stage"}]}, release_sha=sha
        )
        self.assertEqual(new[-1], {"ParameterKey": "ReleaseSha", "ParameterValue": sha})
        for invalid in ("", "abc1234", "A" * 40, "g" * 40):
            with self.subTest(invalid=invalid), self.assertRaises(release_guard.GateError):
                release_guard.previous_parameter_payload(
                    {"Parameters": []}, release_sha=invalid
                )

    def test_previous_parameters_rejects_missing_invalid_and_duplicate_keys(self):
        for stack in (
            {},
            {"Parameters": None},
            {"Parameters": [None]},
            {"Parameters": [{"ParameterKey": ""}]},
            {"Parameters": [{"ParameterKey": "A"}, {"ParameterKey": "A"}]},
        ):
            with self.subTest(stack=stack), self.assertRaises(release_guard.GateError):
                release_guard.previous_parameter_payload(stack)

    def test_stack_invariants_accept_stable_expected_outputs(self):
        for status in (
            "CREATE_COMPLETE",
            "UPDATE_COMPLETE",
            "UPDATE_ROLLBACK_COMPLETE",
        ):
            with self.subTest(status=status):
                release_guard.require_stack_invariants(
                    {
                        "StackStatus": status,
                        "EnableTerminationProtection": True,
                        "Outputs": [
                            {"OutputKey": "AlbumIndexDeploymentPhase", "OutputValue": "both"},
                            {"OutputKey": "PrivateMediaCloudFrontDenyEnforced", "OutputValue": "true"},
                            {"OutputKey": "FrontDoorEnforcementEnabled", "OutputValue": "true"},
                            {"OutputKey": "ExecuteApiEndpointDisabled", "OutputValue": "true"},
                        ],
                    }
                )

    def test_stack_invariants_fail_closed(self):
        base = {
            "StackStatus": "UPDATE_COMPLETE",
            "EnableTerminationProtection": True,
            "Outputs": [
                {"OutputKey": "AlbumIndexDeploymentPhase", "OutputValue": "both"},
                {"OutputKey": "PrivateMediaCloudFrontDenyEnforced", "OutputValue": "true"},
                {"OutputKey": "FrontDoorEnforcementEnabled", "OutputValue": "true"},
                {"OutputKey": "ExecuteApiEndpointDisabled", "OutputValue": "true"},
            ],
        }
        cases = [
            base | {"StackStatus": "UPDATE_IN_PROGRESS"},
            base | {"EnableTerminationProtection": False},
            base | {"Outputs": []},
            base | {"Outputs": [base["Outputs"][1]]},
            base | {"Outputs": [base["Outputs"][0], {"OutputKey": "PrivateMediaCloudFrontDenyEnforced", "OutputValue": "false"}]},
        ]
        for stack in cases:
            with self.subTest(stack=stack), self.assertRaises(release_guard.GateError):
                release_guard.require_stack_invariants(stack)

    def test_requested_parameters_use_previous_value_except_release_sha(self):
        sha = "b" * 40
        stack = {"Parameters": [
            {"ParameterKey": "Stage", "ParameterValue": "prod"},
            {"ParameterKey": "SecretArn", "ParameterValue": "masked-or-arn"},
            {"ParameterKey": "ReleaseSha", "ParameterValue": "a" * 40},
        ]}
        planned = [
            {"ParameterKey": "Stage", "UsePreviousValue": True},
            {"ParameterKey": "SecretArn", "UsePreviousValue": True},
            {"ParameterKey": "ReleaseSha", "ParameterValue": sha},
        ]
        release_guard.require_preserved_parameters(stack, planned, release_sha=sha)
        for invalid in (
            planned[:-1],
            [*planned[:1], {"ParameterKey": "SecretArn", "ParameterValue": "changed"}, planned[-1]],
            [*planned[:-1], {"ParameterKey": "ReleaseSha", "ParameterValue": "c" * 40}],
            [*planned[:-1], {"ParameterKey": "ReleaseSha", "UsePreviousValue": True}],
        ):
            with self.assertRaises(release_guard.GateError):
                release_guard.require_preserved_parameters(stack, invalid, release_sha=sha)

    def test_provider_resolved_parameters_equal_the_deployed_values(self):
        sha = "b" * 40
        stack = {"Parameters": [
            {"ParameterKey": "Stage", "ParameterValue": "prod"},
            {"ParameterKey": "SecretArn", "ParameterValue": "****"},
            {"ParameterKey": "ReleaseSha", "ParameterValue": "a" * 40},
        ]}
        resolved = [
            {"ParameterKey": "Stage", "ParameterValue": "prod"},
            {"ParameterKey": "SecretArn", "ParameterValue": "****"},
            {"ParameterKey": "ReleaseSha", "ParameterValue": sha},
        ]
        release_guard.require_preserved_parameters(
            stack, resolved, release_sha=sha, resolved_values=True
        )
        for invalid in (
            resolved[:-1],
            [*resolved[:1], {"ParameterKey": "SecretArn", "ParameterValue": "changed"}, resolved[-1]],
            [*resolved[:-1], {"ParameterKey": "ReleaseSha", "ParameterValue": "c" * 40}],
            [
                {"ParameterKey": "Stage", "UsePreviousValue": True},
                *resolved[1:],
            ],
        ):
            with self.assertRaises(release_guard.GateError):
                release_guard.require_preserved_parameters(
                    stack, invalid, release_sha=sha, resolved_values=True
                )

    def test_tracked_source_and_built_environment_contracts_are_exact(self):
        policy = json.loads((ROOT / "ops/ci/template_environment_policy.json").read_text())
        release_guard.require_environment_contract(
            (ROOT / "backend/template.yaml").read_text(), policy, template_kind="source"
        )
        built = ROOT / "backend/.aws-sam/build/template.yaml"
        if built.is_file():
            release_guard.require_environment_contract(
                built.read_text(), policy, template_kind="built"
            )
        changed = (ROOT / "backend/template.yaml").read_text().replace(
            "FRONT_DOOR_ENFORCEMENT_ENABLED: !Ref FrontDoorEnforcementEnabled",
            "FRONT_DOOR_ENFORCEMENT_ENABLED: 'false'",
        )
        with self.assertRaises(release_guard.GateError):
            release_guard.require_environment_contract(changed, policy, template_kind="source")


class ArtifactTests(unittest.TestCase):
    def test_sha_manifest_and_upload_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "assets").mkdir()
            (root / "assets" / "app-abc.js").write_text("asset", encoding="utf-8")
            (root / "robots.txt").write_text("robots", encoding="utf-8")
            (root / "index.html").write_text("index", encoding="utf-8")
            files = []
            for relative in ("assets/app-abc.js", "robots.txt", "index.html"):
                digest = hashlib.sha256((root / relative).read_bytes()).hexdigest()
                files.append({"path": relative, "sha256": digest})
            self.assertEqual(release_guard.validate_manifest(root, {"files": files}), 3)
            generated = release_guard.build_manifest(root)
            self.assertEqual(release_guard.validate_manifest(root, generated), 3)
            plan = release_guard.frontend_upload_plan(root)
            self.assertEqual(plan[-1]["path"], "index.html")
            self.assertIn("immutable", plan[0]["cache_control"])
            self.assertIn("max-age=300", plan[1]["cache_control"])
            self.assertIn("no-cache", plan[-1]["cache_control"])
            self.assertNotIn("delete", json.dumps(plan).lower())

    def test_packaged_code_uris_are_bound_to_exact_object_versions(self):
        source = """Resources:
  Example:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: s3://release-bucket/releases/sha/code.zip
"""
        bound, count = bind_s3_versions.bind_versions(
            source,
            expected_bucket="release-bucket",
            expected_count=1,
            resolve_version=lambda key: "version-1" if key.endswith("code.zip") else "",
        )
        self.assertEqual(count, 1)
        self.assertIn('Bucket: "release-bucket"', bound)
        self.assertIn('Key: "releases/sha/code.zip"', bound)
        self.assertIn('Version: "version-1"', bound)
        for wrong_bucket, wrong_count in (("other-bucket", 1), ("release-bucket", 2)):
            with self.assertRaises(bind_s3_versions.BindingError):
                bind_s3_versions.bind_versions(
                    source,
                    expected_bucket=wrong_bucket,
                    expected_count=wrong_count,
                    resolve_version=lambda _key: "version-1",
                )

    def test_frontend_edge_contract_redacts_secret_header_values_but_detects_drift(self):
        distribution = {
            "Distribution": {
                "ARN": "arn:aws:cloudfront::123456789012:distribution/EXAMPLE",
                "Status": "Deployed",
                "DistributionConfig": {
                    "Enabled": True,
                    "Origins": {"Items": [{
                        "Id": "api",
                        "CustomHeaders": {"Items": [{
                            "HeaderName": "X-Origin-Verify", "HeaderValue": "secret-one"
                        }]},
                    }]},
                },
            }
        }
        documents = {
            "distribution": distribution,
            "publicAccessBlock": {"safe": True},
            "encryption": {"algorithm": "AES256"},
            "ownership": {"owner": "enforced"},
            "versioning": {},
            "policyStatus": {"public": False},
        }
        digests = {
            "distributionSha256": frontend_edge_posture._digest(
                frontend_edge_posture.sanitized_distribution(distribution)
            ),
            "publicAccessBlockSha256": frontend_edge_posture._digest(documents["publicAccessBlock"]),
            "encryptionSha256": frontend_edge_posture._digest(documents["encryption"]),
            "ownershipSha256": frontend_edge_posture._digest(documents["ownership"]),
            "versioningSha256": frontend_edge_posture._digest(documents["versioning"]),
            "policyStatusSha256": frontend_edge_posture._digest(documents["policyStatus"]),
        }
        contract = {
            "version": 1, "distributionId": "EXAMPLE", "bucketName": "bucket-name",
            "region": "us-west-2", **digests,
        }
        self.assertEqual(frontend_edge_posture.verify(contract, documents)["status"], "IN_SYNC")
        rotated = json.loads(json.dumps(distribution))
        rotated["Distribution"]["DistributionConfig"]["Origins"]["Items"][0]["CustomHeaders"]["Items"][0]["HeaderValue"] = "secret-two"
        self.assertEqual(
            frontend_edge_posture._digest(frontend_edge_posture.sanitized_distribution(rotated)),
            digests["distributionSha256"],
        )
        documents["distribution"]["Distribution"]["DistributionConfig"]["Enabled"] = False
        with self.assertRaises(frontend_edge_posture.EdgePostureError):
            frontend_edge_posture.verify(contract, documents)

    def test_manifest_rejects_missing_mismatch_traversal_absolute_duplicate_and_bad_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.html").write_text("index", encoding="utf-8")
            digest = release_guard.sha256_file(root / "index.html")
            manifests = [
                {},
                {"files": []},
                {"files": [None]},
                {"files": [{"path": "missing", "sha256": digest}]},
                {"files": [{"path": "index.html", "sha256": "0" * 64}]},
                {"files": [{"path": "../index.html", "sha256": digest}]},
                {"files": [{"path": "/index.html", "sha256": digest}]},
                {"files": [{"path": "index.html", "sha256": digest}] * 2},
            ]
            for manifest in manifests:
                with self.subTest(manifest=manifest), self.assertRaises(release_guard.GateError):
                    release_guard.validate_manifest(root, manifest)
            (root / "extra.txt").write_text("extra", encoding="utf-8")
            with self.assertRaises(release_guard.GateError):
                release_guard.validate_manifest(
                    root, {"files": [{"path": "index.html", "sha256": digest}]}
                )

    def test_frontend_plan_requires_directory_and_index(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(release_guard.GateError):
                release_guard.frontend_upload_plan(root)
            with self.assertRaises(release_guard.GateError):
                release_guard.frontend_upload_plan(root / "missing")
            with self.assertRaises(release_guard.GateError):
                release_guard.build_manifest(root)
            with self.assertRaises(release_guard.GateError):
                release_guard.build_manifest(root / "missing")

    def test_tar_validation_accepts_files_and_rejects_traversal_links_and_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / "payload.txt"
            payload.write_text("safe", encoding="utf-8")
            archive = root / "safe.tar.gz"
            with tarfile.open(archive, "w:gz") as handle:
                handle.add(payload, arcname="build/payload.txt")
            self.assertEqual(release_guard.validate_tar(archive), 1)
            with self.assertRaises(release_guard.GateError):
                release_guard.validate_tar(archive, max_members=0)
            with self.assertRaises(release_guard.GateError):
                release_guard.validate_tar(archive, max_bytes=1)

            traversal = root / "traversal.tar.gz"
            with tarfile.open(traversal, "w:gz") as handle:
                handle.addfile(tarfile.TarInfo("../outside"))
            with self.assertRaises(release_guard.GateError):
                release_guard.validate_tar(traversal)

            linked = root / "linked.tar.gz"
            with tarfile.open(linked, "w:gz") as handle:
                info = tarfile.TarInfo("link")
                info.type = tarfile.SYMTYPE
                info.linkname = "/tmp/target"
                handle.addfile(info)
            with self.assertRaises(release_guard.GateError):
                release_guard.validate_tar(linked)

    def test_manifest_generation_refuses_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.write_text("safe", encoding="utf-8")
            (root / "link").symlink_to(target)
            with self.assertRaises(release_guard.GateError):
                release_guard.build_manifest(root)


class CoverageGateTests(unittest.TestCase):
    def test_percentage_and_metrics(self):
        self.assertEqual(coverage_gate.percentage(0, 0), 100.0)
        self.assertEqual(coverage_gate.percentage(8, 10), 80.0)
        self.assertEqual(
            coverage_gate.metrics(
                {"totals": {"covered_lines": 8, "num_statements": 10, "covered_branches": 4, "num_branches": 5}}
            ),
            (80.0, 80.0),
        )

    def test_cli_passes_and_fails_independent_thresholds(self):
        report = {"totals": {"covered_lines": 9, "num_statements": 10, "covered_branches": 4, "num_branches": 5}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "coverage.json"
            path.write_text(json.dumps(report), encoding="utf-8")
            self.assertEqual(coverage_gate.main([str(path)]), 0)
            self.assertEqual(coverage_gate.main([str(path), "--minimum-branches", "81"]), 1)
            self.assertEqual(coverage_gate.main([str(path), "--minimum-lines", "91"]), 1)


class CredentialArtifactScanTests(unittest.TestCase):
    def test_workflow_scans_full_history_and_generated_artifacts(self):
        workflow = (ROOT / ".github/workflows/_quality.yml").read_text(encoding="utf-8")
        self.assertIn(
            "python3 ops/ci/credential_artifact_scan.py backend/.aws-sam/build",
            workflow,
        )
        self.assertIn("python3 ops/ci/git_history_credential_scan.py .", workflow)
        self.assertIn("fetch-depth: 0", workflow)

    def test_observed_dependency_vocabulary_is_not_credential_material(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            openssh_begin = private_key_marker("OPENSSH")
            openssh_end = private_key_marker("OPENSSH", ending=True)
            rsa_begin = private_key_marker("RSA")
            rsa_end = private_key_marker("RSA", ending=True)
            ec_begin = private_key_marker("EC")
            ec_end = private_key_marker("EC", ending=True)
            documentation_id = access_key_id("AKIA", "IOSFODNN7EXAMPLE")
            fixtures = {
                "cryptography/hazmat/primitives/serialization/ssh.py": (
                    f'_START = b"{openssh_begin}"\n'
                    f'_END = b"{openssh_end}"\n'
                ),
                "google/auth/crypt/_python_rsa.py": (
                    f'markers = ("{rsa_begin}", "{rsa_end}")\n'
                ),
                "google/oauth2/gdch_credentials.py": (
                    f'example = "{ec_begin}\\n<key bytes>\\n{ec_end}\\n"\n'
                ),
                "googleapiclient/discovery_cache/documents/appengine.v1.json": (
                    json.dumps({"description": f"{rsa_begin} {rsa_end}"})
                ),
                "GoogleDriveBackupFunction/googleapiclient/discovery_cache/documents/iamcredentials.v1.json": (
                    json.dumps(iam_credentials_discovery_document())
                ),
                "node_modules/@aws-sdk/sts/AssumeRoleCommand.d.ts": (
                    f'example: "{documentation_id}"\n'
                ),
            }
            for relative, source in fixtures.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source, encoding="utf-8")

            report = credential_artifact_scan.scan(root)
            self.assertEqual(report.files_scanned, len(fixtures))
            self.assertEqual(report.findings, ())
            self.assertEqual(credential_artifact_scan.main([str(root)]), 0)

    def test_dependency_credential_url_placeholders_are_not_credentials(self):
        placeholders = (
            b"https://username:password@host.com:80/path",
            b"https://username:password@endpoint/resource",
            b"Use `https://(username:password@)domain` for the endpoint.",
        )
        for payload in placeholders:
            with self.subTest(payload=payload):
                self.assertFalse(
                    credential_artifact_scan._contains_credentialed_url(payload)
                )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "url.py").write_bytes(placeholders[0])
            (root / "container.v1.json").write_text(
                json.dumps({"description": placeholders[1].decode()}),
                encoding="utf-8",
            )
            (root / "gkeonprem.v1.json").write_text(
                json.dumps({"description": placeholders[2].decode()}),
                encoding="utf-8",
            )
            self.assertEqual(credential_artifact_scan.scan(root).findings, ())

    def test_real_credentialed_urls_are_detected_without_echoing_values(self):
        urls = (
            credentialed_url(
                "https", "alice", "correct-horse-battery", "production.example", "/api"
            ),
            credentialed_url(
                "https", "username", "password", "production.example", "/private"
            ),
            credentialed_url(
                "http", "deploy", "supersecret123", "10.0.0.5:8080", "/"
            ),
        )
        for payload in urls:
            with self.subTest(payload=payload):
                self.assertTrue(
                    credential_artifact_scan._contains_credentialed_url(payload)
                )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret = urls[0].decode()
            (root / "bundle.js").write_text(secret, encoding="utf-8")
            report = credential_artifact_scan.scan(root)
            self.assertEqual(
                [finding.kind for finding in report.findings],
                ["credentialed_url"],
            )
            with patch("sys.stdout") as stdout:
                self.assertEqual(credential_artifact_scan.main([str(root)]), 1)
            self.assertNotIn(
                secret,
                "".join(str(call) for call in stdout.write.call_args_list),
            )

    def test_real_material_and_forbidden_filename_fail_without_echoing_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key_begin = private_key_marker()
            key_end = private_key_marker(ending=True)
            key = root / "leaked.pem"
            key.write_text(
                f"{key_begin}\n"
                "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n"
                f"{key_end}\n",
                encoding="utf-8",
            )
            long_term_id = access_key_id("AKIA", "1234567890ABCDEF")
            temporary_id = access_key_id("ASIA", "1234567890ABCDEF")
            access_key = root / "handler.py"
            access_key.write_text(
                f'value = "{long_term_id}"\n'
                f'temporary = "{temporary_id}"\n',
                encoding="utf-8",
            )
            forbidden = root / "service-account-prod.json"
            forbidden.write_text("{}", encoding="utf-8")
            (root / "service_account_prod.json").write_text("{}", encoding="utf-8")
            (root / "cached_credentials.json").write_text("{}", encoding="utf-8")

            report = credential_artifact_scan.scan(root)
            self.assertEqual(
                {finding.kind for finding in report.findings},
                {
                    "aws_access_key_id",
                    "forbidden_credential_filename",
                    "private_key_block",
                },
            )
            with patch("sys.stdout") as stdout:
                self.assertEqual(credential_artifact_scan.main([str(root)]), 1)
            rendered = "".join(str(call) for call in stdout.write.call_args_list)
            self.assertNotIn(long_term_id, rendered)
            self.assertNotIn(temporary_id, rendered)
            self.assertNotIn("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", rendered)

    def test_legacy_encrypted_pem_with_metadata_is_rejected(self):
        begin = private_key_marker("RSA")
        end = private_key_marker("RSA", ending=True)
        payload = (
            f"{begin}\n"
            "Proc-Type: 4,ENCRYPTED\n"
            "DEK-Info: AES-256-CBC,0123456789ABCDEF\n\n"
            "MIIE6TAbBgkqhkiG9w0BBQMwDgQIZmFrZVNhbHQCAggA\n"
            f"{end}\n"
        ).encode()
        self.assertTrue(credential_artifact_scan._contains_private_key_block(payload))

    def test_iam_credentials_exception_requires_exact_path_and_schema_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            valid_document = json.dumps(iam_credentials_discovery_document())
            wrong_path = root / "other" / "iamcredentials.v1.json"
            wrong_path.parent.mkdir(parents=True)
            wrong_path.write_text(valid_document, encoding="utf-8")
            wrong_document = (
                root
                / "GoogleDriveBackupFunction"
                / "googleapiclient"
                / "discovery_cache"
                / "documents"
                / "iamcredentials.v1.json"
            )
            wrong_document.parent.mkdir(parents=True)
            wrong_document.write_text("{}", encoding="utf-8")
            report = credential_artifact_scan.scan(root)
            self.assertEqual(
                [finding.kind for finding in report.findings],
                ["forbidden_credential_filename", "forbidden_credential_filename"],
            )

    def test_directory_enumeration_error_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            blocked = root / "blocked"
            blocked.mkdir()
            (root / "safe.txt").write_text("safe", encoding="utf-8")
            real_scandir = credential_artifact_scan.os.scandir

            def guarded_scandir(path):
                if Path(path) == blocked:
                    raise PermissionError("blocked")
                return real_scandir(path)

            with patch.object(
                credential_artifact_scan.os, "scandir", side_effect=guarded_scandir
            ), self.assertRaises(credential_artifact_scan.ScanError):
                credential_artifact_scan.scan(root)

    def test_empty_or_unsafe_artifact_roots_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(credential_artifact_scan.ScanError):
                credential_artifact_scan.scan(root)
            with patch("sys.stderr") as stderr:
                self.assertEqual(credential_artifact_scan.main([str(root)]), 2)
            self.assertNotIn(str(root), "".join(str(call) for call in stderr.write.call_args_list))


class GitHistoryCredentialScanTests(unittest.TestCase):
    @staticmethod
    def git(repo: Path, *arguments: str) -> None:
        subprocess.run(
            ["git", *arguments],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        )

    def test_deleted_historical_credentials_are_detected_without_echoing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self.git(repo, "init", "-q")
            self.git(repo, "config", "user.name", "CI Test")
            self.git(repo, "config", "user.email", "ci@example.invalid")
            tracked = repo / "safe.txt"
            tracked.write_text("safe\n", encoding="utf-8")
            self.git(repo, "add", "safe.txt")
            self.git(repo, "commit", "-qm", "safe")
            secret = access_key_id("ASIA", "1234567890ABCDEF")
            tracked.write_text(secret + "\n", encoding="utf-8")
            self.git(repo, "commit", "-qam", "historical fixture")
            tracked.write_text("safe again\n", encoding="utf-8")
            self.git(repo, "commit", "-qam", "remove fixture")

            report = git_history_credential_scan.scan_history(repo)
            self.assertEqual(report.commits_scanned, 3)
            self.assertEqual(report.finding_kinds, ("aws_access_key_id",))
            with patch("sys.stdout") as stdout:
                self.assertEqual(git_history_credential_scan.main([str(repo)]), 1)
            self.assertNotIn(secret, "".join(str(call) for call in stdout.write.call_args_list))

    def test_clean_history_passes_and_unavailable_repository_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self.git(repo, "init", "-q")
            self.git(repo, "config", "user.name", "CI Test")
            self.git(repo, "config", "user.email", "ci@example.invalid")
            (repo / "safe.txt").write_text("safe\n", encoding="utf-8")
            self.git(repo, "add", "safe.txt")
            self.git(repo, "commit", "-qm", "safe")
            self.assertEqual(git_history_credential_scan.scan_history(repo).finding_kinds, ())
            self.assertEqual(git_history_credential_scan.main([str(repo)]), 0)
            with self.assertRaises(git_history_credential_scan.HistoryScanError):
                git_history_credential_scan.scan_history(repo / "missing")

    def test_high_confidence_token_inside_lockfile_is_not_skipped_or_echoed(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self.git(repo, "init", "-q")
            self.git(repo, "config", "user.name", "CI Test")
            self.git(repo, "config", "user.email", "ci@example.invalid")
            token = "ghp_" + "A" * 36
            (repo / "package-lock.json").write_text(
                json.dumps({"resolved": f"https://example.invalid/?token={token}"}),
                encoding="utf-8",
            )
            self.git(repo, "add", "package-lock.json")
            self.git(repo, "commit", "-qm", "lock fixture")
            report = git_history_credential_scan.scan_history(repo)
            self.assertIn("github_token", report.finding_kinds)
            with patch("sys.stdout") as stdout:
                self.assertEqual(git_history_credential_scan.main([str(repo)]), 1)
            self.assertNotIn(
                token,
                "".join(str(call) for call in stdout.write.call_args_list),
            )

    def test_only_exact_historical_scanner_url_fixture_is_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self.git(repo, "init", "-q")
            self.git(repo, "config", "user.name", "CI Test")
            self.git(repo, "config", "user.email", "ci@example.invalid")
            fixture = repo / git_history_credential_scan.SCANNER_SELF_TEST_PATH
            fixture.parent.mkdir(parents=True)
            reviewed = b"\n".join(
                (
                    credentialed_url(
                        "https",
                        "alice",
                        "correct-horse-battery",
                        "production.example",
                        "/api",
                    ),
                    credentialed_url(
                        "https",
                        "username",
                        "password",
                        "production.example",
                        "/private",
                    ),
                    credentialed_url(
                        "http", "deploy", "supersecret123", "10.0.0.5:8080", "/"
                    ),
                )
            )
            fixture.write_bytes(reviewed)
            self.git(repo, "add", git_history_credential_scan.SCANNER_SELF_TEST_PATH)
            self.git(repo, "commit", "-qm", "reviewed scanner fixture")
            self.assertEqual(
                git_history_credential_scan.scan_history(repo).finding_kinds,
                (),
            )

            fixture.write_bytes(
                reviewed
                + b"\n"
                + credentialed_url(
                    "https", "unexpected", "unreviewed-secret", "example.invalid"
                )
            )
            self.git(repo, "commit", "-qam", "unreviewed fixture")
            self.assertEqual(
                git_history_credential_scan.scan_history(repo).finding_kinds,
                ("credentialed_url",),
            )


class PublicPostureSmokeTests(unittest.TestCase):
    SHA = "a" * 40
    ALBUM_ID = "11111111-1111-4111-8111-111111111111"

    @staticmethod
    def response(status, body=b"", *, content_type="application/json", cache=""):
        headers = {"content-type": content_type}
        if cache:
            headers["cache-control"] = cache
        return public_posture_smoke.RawResponse(status, headers, body)

    def config(self):
        return public_posture_smoke.PostureConfig(
            "https://site.test",
            "https://site.test/api",
            "https://origin.site.test/api",
            "https://abc.execute-api.us-west-2.amazonaws.com/prod",
            "media.test",
            "media-bucket",
            "us-west-2",
            self.SHA,
        )

    def requester(self, *, hostile_allow_origin=False):
        html_headers = {
            "content-type": "text/html; charset=utf-8",
            "strict-transport-security": "max-age=31536000",
            "content-security-policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "referrer-policy": "strict-origin-when-cross-origin",
            "permissions-policy": "camera=(), geolocation=(), microphone=()",
        }
        public_headers = {
            "content-type": "application/json",
            "cache-control": "public,max-age=60,s-maxage=60",
        }
        summary = {
            "albumId": self.ALBUM_ID,
            "type": "photo",
            "title": "Public",
            "description": "",
            "category": "Test",
            "createdAt": "2026-01-01T00:00:00Z",
            "uploadedAt": "2026-01-01T00:00:00Z",
            "visibility": "public",
            "imageCount": 1,
            "coverImageUrl": "https://media.test/public/raw.jpg",
            "coverThumbnailUrl": "https://media.test/public/thumb.jpg",
            "coverBlurhash": "",
        }
        detail = {
            "album": {
                **{key: value for key, value in summary.items() if key != "imageCount"},
                "qrCodeUrl": "https://media.test/public/album-qr.svg",
            },
            "images": [
                {
                    "id": "public-image",
                    "url": "https://media.test/public/raw.jpg",
                    "thumbnailUrl": "https://media.test/public/thumb.jpg",
                    "downloadUrl": "https://media.test/public/raw.jpg",
                    "previewSrcSet": [
                        {"width": 640, "url": "https://media.test/public/preview.webp"}
                    ],
                }
            ],
        }

        def request(url, _timeout, headers, _max_bytes):
            if url == "https://site.test/":
                return public_posture_smoke.RawResponse(
                    200, html_headers, b'<script type="module" src="/assets/app.js"></script>'
                )
            if url == "https://site.test/assets/app.js":
                return public_posture_smoke.RawResponse(200, {"content-type": "text/javascript"}, self.SHA.encode())
            if url.startswith("https://site.test/") and not url.startswith("https://site.test/api"):
                return public_posture_smoke.RawResponse(200, html_headers, b"<main>safe</main>")
            if url.startswith("https://origin.site.test/api/public/albums"):
                return self.response(403, b'{"error":"Forbidden"}', cache="private,no-store")
            if url.startswith("https://abc.execute-api.us-west-2.amazonaws.com/prod/public/albums"):
                return self.response(404, b'{"message":"Not Found"}')
            if url == "https://site.test/api/users":
                return self.response(401, b'{"error":"Unauthorized"}', cache="private,no-store")
            if url == "https://site.test/api/public/stats":
                stats = {
                    "schemaVersion": 1,
                    "generatedAt": "2026-08-11T10:00:00Z",
                    "sourceGeneratedAt": "2026-08-11T09:15:00Z",
                    "taken": {"photos": 10, "videos": 2},
                    "kept": {"photos": 4, "videos": 1, "photoPercent": 40.0, "videoPercent": 50.0},
                    "storage": {"totalBytes": 1000},
                    "albums": {"photos": 1, "videos": 1},
                    "outputByYear": [],
                    "categories": [],
                    "mostActive": {"year": None, "category": None},
                    "gear": {"cameras": [], "lenses": [], "manualLensFallback": "Sirui Nightwalker 75mm T1.2"},
                }
                return public_posture_smoke.RawResponse(
                    200,
                    {**public_headers, "cache-control": "public, max-age=300, s-maxage=86400"},
                    json.dumps(stats).encode(),
                )
            if url.startswith("https://site.test/api/public/albums?"):
                response_headers = dict(public_headers)
                if hostile_allow_origin and headers and headers.get("Origin"):
                    response_headers["access-control-allow-origin"] = headers["Origin"]
                return public_posture_smoke.RawResponse(
                    200, response_headers, json.dumps({"items": [summary], "nextCursor": None}).encode()
                )
            if url == f"https://site.test/api/public/albums/{self.ALBUM_ID}":
                return public_posture_smoke.RawResponse(200, public_headers, json.dumps(detail).encode())
            if url.startswith("https://media.test/"):
                return public_posture_smoke.RawResponse(206, {"content-type": "image/webp"}, b"x")
            if url == "https://media-bucket.s3.us-west-2.amazonaws.com/public/thumb.jpg":
                return self.response(403, b"denied", content_type="application/xml")
            raise AssertionError(f"unexpected test URL: {url}")

        return request

    def test_complete_public_posture_contract_passes_with_aggregate_metrics(self):
        metrics = public_posture_smoke.run_posture(
            self.config(), requester=self.requester()
        )
        self.assertEqual(metrics["albumCount"], 1)
        self.assertEqual(metrics["privacyRouteChecks"], 5)
        self.assertEqual(metrics["mediaAuthorizationChecks"], 2)
        self.assertEqual(metrics["publicStatsChecks"], 1)
        self.assertTrue(metrics["publicStatsReady"])

    def test_public_stats_allows_exact_initial_bootstrap_response(self):
        response = self.response(
            503,
            b'{"error":"Photography statistics are being prepared","code":"stats_preparing"}',
            cache="private,no-store",
        )
        self.assertFalse(public_posture_smoke._require_public_stats(response))

        invalid = self.response(
            503,
            b'{"error":"Service unavailable","code":"unexpected"}',
            cache="private,no-store",
        )
        with self.assertRaises(public_posture_smoke.PostureError):
            public_posture_smoke._require_public_stats(invalid)

    def test_smoke_retry_is_bounded_and_only_for_availability_failures(self):
        calls = []
        sleeps = []

        def transient_then_safe(config):
            calls.append(config)
            if len(calls) == 1:
                raise public_posture_smoke.PostureError(
                    "public endpoint request failed"
                )
            return {"albumCount": 1}

        with patch("sys.stderr"):
            metrics = public_posture_smoke.run_with_retries(
                self.config(),
                attempts=2,
                retry_delay=5,
                runner=transient_then_safe,
                sleeper=sleeps.append,
            )
        self.assertEqual(metrics, {"albumCount": 1})
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [5])

        calls.clear()

        def security_failure(config):
            calls.append(config)
            raise public_posture_smoke.PostureError(
                "hostile origin received an allow-origin response"
            )

        with patch("sys.stderr"), self.assertRaises(public_posture_smoke.PostureError):
            public_posture_smoke.run_with_retries(
                self.config(),
                attempts=3,
                retry_delay=0,
                runner=security_failure,
                sleeper=sleeps.append,
            )
        self.assertEqual(len(calls), 1)

        for attempts, retry_delay in ((0, 0), (4, 0), (True, 0), (1, -1), (1, 11)):
            with self.subTest(attempts=attempts, retry_delay=retry_delay), self.assertRaises(
                public_posture_smoke.PostureError
            ):
                public_posture_smoke.run_with_retries(
                    self.config(), attempts=attempts, retry_delay=retry_delay
                )

    def test_hostile_cors_and_invalid_config_fail_closed(self):
        with self.assertRaises(public_posture_smoke.PostureError):
            public_posture_smoke.run_posture(
                self.config(), requester=self.requester(hostile_allow_origin=True)
            )

    def test_execute_api_denial_must_be_the_exact_disabled_endpoint_response(self):
        underlying = self.requester()

        def reachable_execute_api(url, timeout, headers, max_bytes):
            if url.startswith("https://abc.execute-api.us-west-2.amazonaws.com/prod/public/albums"):
                return self.response(403, b'{"message":"Forbidden"}')
            return underlying(url, timeout, headers, max_bytes)

        with self.assertRaises(public_posture_smoke.PostureError):
            public_posture_smoke.run_posture(
                self.config(), requester=reachable_execute_api
            )

    def test_public_posture_configuration_rejects_each_unsafe_boundary(self):
        config = self.config()
        unsafe_variants = (
            replace(config, api_base_url="https://other.test/api"),
            replace(config, api_base_url="https://site.test/not-api"),
            replace(config, api_origin_url="https://origin.site.test/not-api"),
            replace(config, execute_api_url="https://example.test/prod"),
            replace(config, execute_api_url="https://abc.execute-api.us-west-2.amazonaws.com"),
            replace(config, execute_api_url="https://abc.execute-api.us-west-2.amazonaws.com/prod/extra"),
            replace(config, media_domain="media.test/path"),
            replace(config, media_bucket_name="Invalid_Bucket"),
            replace(config, aws_region="us-west"),
            replace(config, expected_release_sha="not-a-sha"),
            replace(config, timeout=0),
        )
        for unsafe in unsafe_variants:
            with self.subTest(config=unsafe), self.assertRaises(
                public_posture_smoke.PostureError
            ):
                public_posture_smoke.validate_config(unsafe)
        with self.assertRaises(public_posture_smoke.PostureError):
            public_posture_smoke.validate_config(
                self.config().__class__(
                    "http://site.test",
                    self.config().api_base_url,
                    self.config().api_origin_url,
                    self.config().execute_api_url,
                    self.config().media_domain,
                    self.config().media_bucket_name,
                    self.config().aws_region,
                    self.config().expected_release_sha,
                )
            )


class CliTests(unittest.TestCase):
    def test_release_guard_subcommands_and_redacted_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stack = root / "stack.json"
            output = root / "parameters.json"
            stack.write_text(json.dumps({"Parameters": [{"ParameterKey": "Stage"}]}), encoding="utf-8")
            self.assertEqual(release_guard.main(["previous-parameters", str(stack), str(output)]), 0)
            self.assertEqual(json.loads(output.read_text()), [{"ParameterKey": "Stage", "UsePreviousValue": True}])

            pages = root / "pages.json"
            pages.write_text(json.dumps([{"Changes": [change()]}]), encoding="utf-8")
            intent = root / "intent.json"
            intent.write_text(
                json.dumps(ReleaseIntentTests.intent()), encoding="utf-8"
            )
            dependencies = root / "dependencies.json"
            dependencies.write_text(
                json.dumps(ReleaseDependencyTests.document()), encoding="utf-8"
            )
            self.assertEqual(
                release_guard.main(
                    [
                        "gate-change-set",
                        str(pages),
                        "--intent",
                        str(intent),
                        "--dependencies",
                        str(dependencies),
                    ]
                ),
                0,
            )

            invalid = root / "invalid.json"
            invalid.write_text("not-json", encoding="utf-8")
            with patch("sys.stderr") as stderr:
                self.assertEqual(release_guard.main(["stack-invariants", str(invalid)]), 2)
                self.assertTrue(stderr.write.called)


class WorkflowPolicyTests(unittest.TestCase):
    def test_accepts_full_sha_and_local_reusable_workflow(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workflow.yml"
            path.write_text(
                "steps:\n  - uses: actions/checkout@" + "a" * 40 + "\n  - uses: ./.github/workflows/_quality.yml\n",
                encoding="utf-8",
            )
            self.assertEqual(workflow_policy.violations(path), [])
            self.assertEqual(workflow_policy.main([str(path)]), 0)

    def test_rejects_mutable_actions_privileged_trigger_permissions_and_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workflow.yml"
            path.write_text(
                "on:\n  pull_request_target:\npermissions: write-all\nsteps:\n"
                "  - uses: actions/checkout@v4\n    with:\n      persist-credentials: true\n",
                encoding="utf-8",
            )
            problems = workflow_policy.violations(path)
            self.assertEqual(len(problems), 4)
            self.assertEqual(workflow_policy.main([str(path)]), 1)

    def test_rejects_github_environment_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workflow.yml"
            path.write_text(
                "jobs:\n  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n",
                encoding="utf-8",
            )
            self.assertEqual(
                workflow_policy.violations(path),
                [
                    "GitHub Environments are forbidden; AWS trust is bound to the exact main ref"
                ],
            )

    def test_deploy_helpers_preserve_release_safety_contract(self):
        helper_paths = [
            ROOT / "ops" / "ci" / name
            for name in (
                "backend_plan.sh",
                "backend_execute.sh",
                "collect_change_set.sh",
                "frontend_deploy.sh",
                "public_smoke.sh",
                "wait_for_drift.sh",
                "audit_stack_drift.sh",
                "assert_aws_account.sh",
            )
        ]
        for path in helper_paths:
            self.assertTrue(path.stat().st_mode & 0o111, f"{path.name} must be executable")

        plan = helper_paths[0].read_text(encoding="utf-8")
        execute = helper_paths[1].read_text(encoding="utf-8")
        collect = helper_paths[2].read_text(encoding="utf-8")
        frontend = helper_paths[3].read_text(encoding="utf-8")
        smoke = helper_paths[4].read_text(encoding="utf-8")
        drift = helper_paths[5].read_text(encoding="utf-8")
        multi_drift = helper_paths[6].read_text(encoding="utf-8")
        account_guard = helper_paths[7].read_text(encoding="utf-8")
        self.assertIn("detect-stack-drift", plan)
        self.assertNotIn("wait stack-drift-detection-complete", plan)
        self.assertIn("DETECTION_IN_PROGRESS", drift)
        self.assertIn("DETECTION_FAILED", drift)
        self.assertIn("timed out", drift)
        self.assertIn("CREATE_COMPLETE", collect)
        self.assertIn("AVAILABLE", collect)
        self.assertIn("ReleaseSha", collect)
        self.assertIn("gate-change-set", collect)
        self.assertIn("release_intent.json", collect)
        self.assertIn("release_dependencies.json", collect)
        self.assertIn("ChangeSetName", collect)
        self.assertIn("change-set-page.json", collect)
        self.assertIn("jq -s", collect)
        self.assertNotIn("--argjson page", collect)
        self.assertIn('echo "change_set_name=$change_set_name"', plan)
        self.assertNotIn('echo "change_set_id=', plan)
        self.assertIn('CHANGE_SET_NAME="$change_set_name"', plan)
        self.assertIn('CHANGE_SET_NAME:?CHANGE_SET_NAME is required', execute)
        self.assertIn("previous-parameters", plan)
        self.assertIn("EXPECTED_REQUESTED_PARAMETERS_PATH", plan)
        self.assertIn("--release-sha", plan)
        self.assertIn("ARTIFACT_KMS_KEY_ARN", plan)
        self.assertIn("release_artifact_contract.json", plan)
        self.assertNotIn(".rules | length", plan)
        artifact_contract = json.loads(
            (ROOT / "ops/ci/release_artifact_contract.json").read_text(encoding="utf-8")
        )
        self.assertEqual(set(artifact_contract), {"version", "codeUriCount"})
        self.assertEqual(artifact_contract["version"], 1)
        self.assertEqual(
            artifact_contract["codeUriCount"],
            len(re.findall(r"(?m)^\s+CodeUri:", (ROOT / "backend/template.yaml").read_text())),
        )
        self.assertIn("--kms-key-id", plan)
        self.assertIn("packaged_template_key", plan)
        self.assertIn("--template-url", plan)
        self.assertNotIn('--template-body "file://$workspace/packaged.yaml"', plan)
        self.assertIn("collect_change_set.sh", plan)
        self.assertIn("get-caller-identity", account_guard)
        self.assertIn("EXPECTED_AWS_ACCOUNT_ID", account_guard)
        self.assertNotIn("echo \"$actual_account_id\"", account_guard)
        self.assertIn("CAPABILITY_NAMED_IAM", plan)
        self.assertIn("stack-update-complete", execute)
        self.assertIn("EXPECTED_RELEASE_SHA", execute)
        self.assertIn("collect_change_set.sh", execute)
        self.assertNotIn("sync", frontend)
        self.assertNotIn("delete", frontend)
        self.assertIn("get-public-access-block", frontend)
        self.assertIn("OriginAccessControlId", frontend)
        self.assertLess(frontend.index('"$root/index.html"'), frontend.index("create-invalidation"))
        self.assertIn(
            "--paths '/' '/index.html' '/print.html' '/theme-init.js' '/dark-theme.css' '/images/heroes/*' '/favicon.svg'",
            frontend,
        )
        self.assertNotIn("--paths '/*'", frontend)
        self.assertIn('if [[ "$api" == "/api" ]]', smoke)
        self.assertIn('api="${site}${api}"', smoke)
        self.assertIn('elif [[ "$api" != https://* ]]', smoke)
        self.assertIn("public_posture_smoke.py", smoke)
        self.assertIn("PUBLIC_SMOKE_ATTEMPTS:-2", smoke)
        self.assertIn("PUBLIC_SMOKE_RETRY_DELAY_SECONDS:-5", smoke)
        self.assertNotIn("EXPECTED_PUBLIC_ALBUM_COUNT", smoke)
        self.assertNotIn("expected-public-album-count", smoke)
        self.assertIn("audit_stacks.json", multi_drift)
        self.assertIn("detect-stack-drift", multi_drift)
        self.assertIn("--resolved-values", collect)

    def test_scheduled_workflow_runs_history_posture_and_versioned_multi_stack_drift(self):
        scheduled = (ROOT / ".github/workflows/scheduled-security.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("fetch-depth: 0", scheduled)
        self.assertIn("git_history_credential_scan.py", scheduled)
        self.assertIn("public_smoke.sh", scheduled)
        self.assertIn("audit_stack_drift.sh", scheduled)
        self.assertNotIn("cloudformation execute", scheduled.lower())

    def test_quality_workflow_is_hermetic_for_frontend_and_sam_validation(self):
        quality = (ROOT / ".github/workflows/_quality.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("Run frontend tests with deterministic public configuration", quality)
        self.assertIn("VITE_CLOUDFRONT_DOMAIN: media.example.invalid", quality)
        self.assertIn("VITE_COGNITO_USER_POOL_ID: us-west-2_TESTPOOL", quality)
        self.assertIn("VITE_COGNITO_CLIENT_ID: test-client-id", quality)
        self.assertRegex(
            quality,
            r"(?s)Validate and build SAM from scratch.*?AWS_EC2_METADATA_DISABLED: 'true'.*?AWS_DEFAULT_REGION: us-west-2.*?validate_infrastructure\.sh --build",
        )

    def test_release_artifacts_preserve_manifested_hidden_public_files(self):
        quality = (ROOT / ".github/workflows/_quality.yml").read_text(
            encoding="utf-8"
        )
        release = (ROOT / ".github/workflows/release-production.yml").read_text(
            encoding="utf-8"
        )
        manual = (ROOT / ".github/workflows/manual-release.yml").read_text(
            encoding="utf-8"
        )
        for source, artifact_name in (
            (quality, "release-frontend"),
            (release, "attested-release"),
            (manual, "verified-rollback-release"),
        ):
            self.assertRegex(
                source,
                rf"(?s)name: {artifact_name}\s+path: [^\n]+\s+include-hidden-files: true",
            )

    def test_production_workflows_use_main_ref_without_github_environments(self):
        release = (ROOT / ".github/workflows/release-production.yml").read_text(
            encoding="utf-8"
        )
        manual = (ROOT / ".github/workflows/manual-release.yml").read_text(
            encoding="utf-8"
        )
        scheduled = (ROOT / ".github/workflows/scheduled-security.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("branches: [main]", release)
        self.assertIn("./.github/workflows/_quality.yml", release)
        self.assertIn("frontend_deploy.sh", release)
        self.assertIn("backend_execute.sh", release)
        self.assertNotIn("Detect backend artifact changes", release)
        self.assertNotIn("backend_changed", release)
        self.assertIn("noop: ${{ steps.plan.outputs.noop }}", release)
        self.assertRegex(
            release,
            r"(?s)frontend-deploy:\s+name: Deploy exact frontend artifact\s+needs: \[attest, backend-smoke\]\s+if: always\(\) && needs\.attest\.result == 'success' && needs\.backend-smoke\.result == 'success'",
        )
        self.assertRegex(release, r"(?s)Create non-executing guarded change set\s+id: plan")
        for source in (release, manual):
            self.assertIn("change_set_name", source)
            self.assertNotIn("change_set_id", source)
        for source in (release, manual, scheduled):
            self.assertNotRegex(source, r"(?m)^\s+environment:\s*")
            self.assertNotIn("EXPECTED_PUBLIC_ALBUM_COUNT", source)
        quality = (ROOT / ".github/workflows/_quality.yml").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("EXPECTED_PUBLIC_ALBUM_COUNT", quality)
        self.assertIn("refs/heads/main", manual)
        self.assertIn("refs/heads/main", scheduled)


if __name__ == "__main__":
    unittest.main()
