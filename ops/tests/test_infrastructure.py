"""Source-level regression tests for the infrastructure security baseline."""

from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops"))
import tag_existing_media  # noqa: E402
import backfill_album_owner_sub  # noqa: E402
import backfill_legacy_media_prefix  # noqa: E402
import cloudfront_frontend  # noqa: E402
TEMPLATE = (ROOT / "backend" / "template.yaml").read_text(encoding="utf-8")
MAKEFILE = (ROOT / "backend" / "Makefile").read_text(encoding="utf-8")
BASELINE = json.loads((ROOT / "ops" / "frontend_cloudfront_baseline.json").read_text(encoding="utf-8"))


def resource_block(logical_id: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(logical_id)}:\n(?P<body>.*?)(?=^  [A-Za-z][A-Za-z0-9]+:\n|^Outputs:)",
        TEMPLATE,
    )
    if not match:
        raise AssertionError(f"Missing resource {logical_id}")
    return match.group("body")


class TemplateValidationTests(unittest.TestCase):
    def test_sam_lint(self) -> None:
        subprocess.run(
            ["sam", "validate", "--lint", "--template-file", str(ROOT / "backend" / "template.yaml")],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )

    def test_http_api_processed_openapi_has_valid_server_contract(self) -> None:
        """Exercise SAM's real translator, not only the source YAML shape."""
        translator_assertion = r"""
import sys
from pathlib import Path

from samtranslator.parser.parser import Parser
from samtranslator.translator.translator import Translator
from samtranslator.yaml_helper import yaml_parse

template = yaml_parse(Path(sys.argv[1]).read_text(encoding="utf-8"))

# The translator expects deployable S3 locations. Artifact packaging is a
# separate concern from this OpenAPI contract test, so replace local build
# inputs in memory without changing the template under test.
for logical_id, resource in template["Resources"].items():
    if resource.get("Type") not in {
        "AWS::Serverless::Function",
        "AWS::Serverless::LayerVersion",
    }:
        continue
    properties = resource.setdefault("Properties", {})
    if "CodeUri" in properties:
        properties["CodeUri"] = f"s3://sam-contract-test/{logical_id}.zip"
    if "ContentUri" in properties:
        properties["ContentUri"] = f"s3://sam-contract-test/{logical_id}.zip"

processed = Translator({}, Parser()).translate(template, {})
api = processed["Resources"]["Api"]
assert api["Type"] == "AWS::ApiGatewayV2::Api"
assert api["Properties"]["FailOnWarnings"] is True

body = api["Properties"]["Body"]
servers = body["servers"]
assert len(servers) == 1
assert servers[0]["url"] == "/"
assert servers[0]["x-amazon-apigateway-endpoint-configuration"][
    "disableExecuteApiEndpoint"
] == {"Fn::If": ["DisableDefaultApiEndpoint", True, False]}
actual_routes = {
    (method.upper(), path)
    for path, operations in body["paths"].items()
    for method in operations
    if method.lower() in {"delete", "get", "patch", "post", "put"}
}
expected_routes = {
    ("GET", "/public/albums"),
    ("GET", "/public/albums/{albumId}"),
    ("GET", "/albums"),
    ("GET", "/albums/{albumId}"),
    ("GET", "/shared/{shareCode}"),
    ("POST", "/login"),
    ("POST", "/login/challenge"),
    ("POST", "/contact"),
    ("POST", "/albums"),
    ("PUT", "/albums/{albumId}"),
    ("DELETE", "/albums/{albumId}"),
    ("POST", "/albums/{albumId}/images"),
    ("POST", "/albums/{albumId}/zip"),
    ("POST", "/shared/{shareCode}/zip"),
    ("POST", "/albums/{albumId}/delete-images"),
    ("POST", "/albums/{albumId}/download-url"),
    ("POST", "/shared/{shareCode}/download-url"),
    ("PATCH", "/albums/{albumId}/images"),
    ("POST", "/upload-url"),
    ("POST", "/admin/hero/{operation}"),
    ("POST", "/users"),
    ("GET", "/users"),
    ("GET", "/admin/costs"),
    ("GET", "/admin/drive-usage"),
    ("POST", "/admin/gallery-order"),
    ("DELETE", "/users/{email}"),
    ("PUT", "/users/{email}"),
}
assert actual_routes == expected_routes
"""
        candidates = [sys.executable]
        sam_executable = shutil.which("sam")
        if sam_executable:
            resolved_sam = Path(sam_executable).resolve()
            try:
                with resolved_sam.open("rb") as sam_entrypoint:
                    shebang = sam_entrypoint.readline().decode("utf-8").strip()
            except (OSError, UnicodeDecodeError):
                shebang = ""
            if shebang.startswith("#!"):
                sam_python = shebang[2:]
                if Path(sam_python).is_file() and sam_python not in candidates:
                    candidates.append(sam_python)

        import_errors = []
        for python in candidates:
            result = subprocess.run(
                [python, "-c", translator_assertion, str(ROOT / "backend" / "template.yaml")],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                return
            if "No module named 'samtranslator'" in result.stderr:
                import_errors.append(f"{python}: {result.stderr.strip()}")
                continue
            self.fail(result.stderr or result.stdout)

        self.fail(
            "AWS SAM Translator is unavailable to verify the processed OpenAPI contract:\n"
            + "\n".join(import_errors)
        )

    def test_dnssec_template_lint(self) -> None:
        subprocess.run(
            ["sam", "validate", "--lint", "--template-file", str(ROOT / "ops" / "dnssec-key-template.yaml")],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )

    def test_handlers_exist(self) -> None:
        handlers = re.findall(r"^\s+Handler:\s+([a-zA-Z0-9_]+)\.handler\s*$", TEMPLATE, re.MULTILINE)
        self.assertGreaterEqual(len(handlers), 20)
        missing = [
            name
            for name in handlers
            if not (
                (name == "index" and (ROOT / "backend" / "preview_worker" / "index.mjs").is_file())
                or (ROOT / "backend" / "functions" / f"{name}.py").is_file()
            )
        ]
        self.assertEqual(missing, [])


class DataProtectionTests(unittest.TestCase):
    def test_album_handler_iam_matches_runtime_data_operations(self) -> None:
        create_album = resource_block("CreateAlbumFunction")
        for action in ("dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"):
            self.assertIn(action, create_album)

        update_album = resource_block("UpdateAlbumFunction")
        self.assertIn("dynamodb:GetItem", update_album)
        self.assertIn("dynamodb:PutItem", update_album)
        self.assertNotIn("dynamodb:UpdateItem", update_album)

        create_zip = resource_block("CreateZipFunction")
        self.assertIn("Action: s3:ListBucket", create_zip)
        self.assertIn("s3:prefix: temp-zips/*", create_zip)
        self.assertIn("${ImagesBucket.Arn}/temp-zips/*", create_zip)
        self.assertIn("s3:PutObjectTagging", create_zip)

    def test_new_fixed_name_log_resources_do_not_orphan_on_initial_rollback(self) -> None:
        for logical_id in ("MediaAccessLogsBucket", "ApiAccessLogGroup", "ApplicationLogGroup"):
            block = resource_block(logical_id)
            self.assertIn("DeletionPolicy: RetainExceptOnCreate", block)
            self.assertIn("UpdateReplacePolicy: Retain", block)

    def test_application_audit_logs_are_centralized_retained_and_alarmable(self) -> None:
        group = resource_block("ApplicationLogGroup")
        self.assertIn("RetentionInDays: !Ref ApplicationLogRetentionDays", group)
        self.assertIn("DataClassification", group)
        globals_block = TEMPLATE.split("Globals:", 1)[1].split("Resources:", 1)[0]
        self.assertIn("LogGroup: !Ref ApplicationLogGroup", globals_block)
        self.assertIn("APPLICATION_STAGE: !Ref Stage", globals_block)
        self.assertIn("RELEASE_SHA: !Ref ReleaseSha", globals_block)
        for logical_id in (
            "AuditDeniedMetricFilter",
            "AuditFailureMetricFilter",
            "LoginDeniedMetricFilter",
            "ApiAuthorizationDeniedMetricFilter",
        ):
            self.assertIn("AWS::Logs::MetricFilter", resource_block(logical_id))
        for logical_id in ("AuditFailureAlarm", "LoginDeniedAlarm", "ApiAuthorizationDeniedAlarm"):
            block = resource_block(logical_id)
            self.assertIn("IanTruongPhotography/Security", block)
        self.assertIn(
            "ian-photography-security-${Stage}",
            resource_block("AuditFailureAlarm"),
        )
        self.assertNotIn("AlarmActions:", resource_block("LoginDeniedAlarm"))
        self.assertNotIn("AlarmActions:", resource_block("ApiAuthorizationDeniedAlarm"))

    def test_api_access_log_destination_uses_exact_log_group_arn(self) -> None:
        api = resource_block("Api")
        expected = (
            "DestinationArn: !Sub "
            "'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:"
            "log-group:${ApiAccessLogGroup}'"
        )
        self.assertIn(expected, api)
        self.assertNotIn("DestinationArn: !GetAtt ApiAccessLogGroup.Arn", api)
        self.assertNotRegex(api, r"DestinationArn:.*:\*['\"]?$")

    def test_album_table_is_recoverable_and_protected(self) -> None:
        block = resource_block("AlbumsTable")
        for expected in (
            "DeletionPolicy: Retain",
            "UpdateReplacePolicy: Retain",
            "DeletionProtectionEnabled: true",
            "PointInTimeRecoveryEnabled: true",
        ):
            self.assertIn(expected, block)
        self.assertNotRegex(block, r"(?m)^\s+SSESpecification:")

    def test_gallery_order_is_retained_recoverable_and_least_privilege(self) -> None:
        table = resource_block("GallerySettingsTable")
        update = resource_block("UpdateGalleryOrderFunction")
        for expected in (
            "DeletionPolicy: Retain",
            "UpdateReplacePolicy: Retain",
            "DeletionProtectionEnabled: true",
            "PointInTimeRecoveryEnabled: true",
            "DataClassification",
            "PortfolioConfiguration",
        ):
            self.assertIn(expected, table)
        self.assertNotRegex(table, r"(?m)^\s+SSESpecification:")
        self.assertIn("Path: /admin/gallery-order", update)
        self.assertIn("Method: POST", update)
        self.assertIn("Action: dynamodb:BatchGetItem", update)
        self.assertIn("Action: dynamodb:PutItem", update)
        for forbidden in ("dynamodb:Scan", "dynamodb:Query", "dynamodb:DeleteItem", "dynamodb:*"):
            self.assertNotIn(forbidden, update)
        self.assertIn("Resource: !GetAtt AlbumsTable.Arn", update)
        self.assertIn("Resource: !GetAtt GallerySettingsTable.Arn", update)
        self.assertIn("SOURCES_UpdateGalleryOrderFunction :=", MAKEFILE)

        for logical_id in ("GetPublicAlbumsFunction", "GetAlbumsFunction"):
            block = resource_block(logical_id)
            self.assertIn("GALLERY_SETTINGS_TABLE: !Ref GallerySettingsTable", block)
            self.assertIn("TableName: !Ref GallerySettingsTable", block)

    def test_rate_limit_security_telemetry_has_point_in_time_recovery(self) -> None:
        block = resource_block("RateLimitTable")
        self.assertIn("DeletionPolicy: Retain", block)
        self.assertIn("UpdateReplacePolicy: Retain", block)
        self.assertIn("DeletionProtectionEnabled: true", block)
        self.assertIn("PointInTimeRecoverySpecification:", block)
        self.assertIn("PointInTimeRecoveryEnabled: true", block)
        self.assertIn("TimeToLiveSpecification:", block)
        self.assertIn("DataClassification", block)

    def test_cost_report_is_daily_cached_admin_only_and_least_privilege(self) -> None:
        table = resource_block("CostReportCacheTable")
        function = resource_block("GetCostReportFunction")
        for expected in (
            "DeletionPolicy: Retain",
            "UpdateReplacePolicy: Retain",
            "DeletionProtectionEnabled: true",
            "PointInTimeRecoveryEnabled: true",
            "DataClassification",
            "AccountBillingMetadata",
        ):
            self.assertIn(expected, table)
        self.assertIn("Path: /admin/costs", function)
        self.assertIn("Method: GET", function)
        self.assertIn("ce:GetCostAndUsage", function)
        self.assertNotIn("ce:GetCostForecast", function)
        self.assertNotIn("ce:*", function)
        for action in ("dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"):
            self.assertIn(action, function)
        for forbidden in ("dynamodb:Scan", "dynamodb:Query", "budgets:", "aws-portal:", "billing:"):
            self.assertNotIn(forbidden, function)
        self.assertIn("Resource: !GetAtt CostReportCacheTable.Arn", function)
        self.assertIn("SOURCES_GetCostReportFunction :=", MAKEFILE)

    def test_drive_usage_is_daily_cached_admin_only_and_least_privilege(self) -> None:
        table = resource_block("DriveUsageCacheTable")
        function = resource_block("GetGoogleDriveUsageFunction")
        refresh = resource_block("RefreshGoogleDriveUsageFunction")
        for expected in (
            "DeletionPolicy: Retain",
            "UpdateReplacePolicy: Retain",
            "DeletionProtectionEnabled: true",
            "PointInTimeRecoveryEnabled: true",
            "DataClassification",
            "AccountStorageMetadata",
        ):
            self.assertIn(expected, table)
        self.assertIn("Path: /admin/drive-usage", function)
        self.assertIn("Method: GET", function)
        self.assertIn("Timeout: 300", refresh)
        self.assertIn("MemorySize: 512", refresh)
        self.assertIn("Type: Schedule", refresh)
        self.assertIn("Schedule: cron(15 9 * * ? *)", refresh)
        self.assertIn("MaximumRetryAttempts: 2", refresh)
        self.assertIn("GOOGLE_DRIVE_FOLDER_ID: !Ref GoogleDriveFolderId", function)
        self.assertIn("GOOGLE_OAUTH_PARAMETER: !Ref GoogleOAuthSecretArn", function)
        for action in ("dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"):
            self.assertIn(action, function)
        for forbidden in ("dynamodb:Scan", "dynamodb:Query", "secretsmanager:", "kms:*"):
            self.assertNotIn(forbidden, function)
        self.assertIn("Resource: !GetAtt DriveUsageCacheTable.Arn", function)
        self.assertIn("Action: ssm:GetParameter", function)
        self.assertIn("SOURCES_GetGoogleDriveUsageFunction :=", MAKEFILE)
        self.assertIn("DEPS_GetGoogleDriveUsageFunction := google-auth==", MAKEFILE)
        self.assertIn("SOURCES_RefreshGoogleDriveUsageFunction :=", MAKEFILE)
        self.assertIn("DEPS_RefreshGoogleDriveUsageFunction := google-auth==", MAKEFILE)

    def test_existing_tables_do_not_toggle_dynamodb_encryption_mode(self) -> None:
        # DynamoDB always encrypts tables at rest. Explicitly adding/removing an
        # AWS-owned-key SSESpecification on these existing resources needlessly
        # consumes the service's guarded encryption-mode update quota.
        for logical_id in ("AlbumsTable", "GallerySettingsTable", "RateLimitTable", "CostReportCacheTable", "DriveUsageCacheTable"):
            self.assertNotRegex(resource_block(logical_id), r"(?m)^\s+SSESpecification:")

    def test_media_bucket_is_private_versioned_and_tls_only(self) -> None:
        bucket = resource_block("ImagesBucket")
        policy = resource_block("ImagesBucketPolicy")
        self.assertIn("Status: Enabled", bucket)
        self.assertIn("BucketOwnerEnforced", bucket)
        self.assertEqual(bucket.count("BlockPublic"), 2)
        self.assertIn("RestrictPublicBuckets: true", bucket)
        self.assertIn("DenyInsecureTransport", policy)
        self.assertIn("aws:SecureTransport: false", policy)
        self.assertIn("AWS:SourceArn", policy)

    def test_media_boundary_can_deny_private_and_temporary_objects(self) -> None:
        policy = resource_block("ImagesBucketPolicy")
        self.assertIn("DenyCloudFrontTemporaryZipReads", policy)
        self.assertIn("DenyCloudFrontNonPublicTaggedObjects", policy)
        self.assertIn("s3:ExistingObjectTag/visibility", policy)
        self.assertIn("StringNotEquals:", policy)
        self.assertIn("s3:ExistingObjectTag/visibility: public", policy)
        self.assertIn("EnforcePrivateMediaDeny", policy)

    def test_destructive_handlers_can_remove_noncurrent_versions(self) -> None:
        for logical_id in ("DeleteAlbumFunction", "DeleteImagesFunction", "DeleteUserFunction"):
            block = resource_block(logical_id)
            self.assertIn("s3:ListBucketVersions", block)
            self.assertIn("s3:DeleteObjectVersion", block)

    def test_protected_media_signers_have_get_object_and_exact_range_cors(self) -> None:
        for logical_id in (
            "GetAlbumsFunction", "GetAlbumFunction", "GetSharedAlbumFunction", "UpdateAlbumFunction"
        ):
            self.assertIn("s3:GetObject", resource_block(logical_id))
        bucket = resource_block("ImagesBucket")
        self.assertIn("AllowedOrigins:\n              - !Ref FrontendUrl", bucket)
        self.assertIn(
            "AllowedHeaders:\n              - Content-Type\n              - Range\n              - x-amz-tagging",
            bucket,
        )

    def test_admin_hero_upload_queues_responsive_publication_with_least_privilege(self) -> None:
        function = resource_block("HeroCoverFunction")
        worker = resource_block("PreviewWorkerFunction")
        distribution = resource_block("ImagesCloudFront")
        policy = resource_block("ImagesBucketPolicy")
        cache = resource_block("HeroMediaCachePolicy")
        headers = resource_block("HeroMediaResponseHeadersPolicy")
        self.assertIn("Path: /admin/hero/{operation}", function)
        self.assertIn("ReservedConcurrentExecutions: 2", function)
        self.assertIn("${ImagesBucket.Arn}/temp-zips/hero-pending", function)
        self.assertIn("Action: sqs:SendMessage", function)
        self.assertNotIn("${ImagesBucket.Arn}/site/hero/home", function)
        self.assertNotIn("GoogleDriveBackupFunction", function)
        self.assertNotIn("albums/*", function)
        self.assertNotIn("cloudfront:CreateInvalidation", function)
        self.assertIn("${ImagesBucket.Arn}/site/hero/original", worker)
        self.assertIn("${ImagesBucket.Arn}/site/hero/versions/v1/*", worker)
        self.assertIn("${ImagesBucket.Arn}/site/hero/current/*", worker)
        self.assertIn("cloudfront:CreateInvalidation", worker)
        self.assertIn("DenyCloudFrontTemporaryZipReads", policy)
        self.assertIn("PathPattern: 'site/hero/*'", distribution)
        self.assertIn("PathPattern: 'site/hero/versions/*'", distribution)
        self.assertIn("Compress: false", distribution)
        self.assertIn("DefaultTTL: 86400", cache)
        self.assertIn("Value: public, max-age=0, must-revalidate", headers)

    def test_abandoned_pending_uploads_expire_after_recovery_window(self) -> None:
        bucket = resource_block("ImagesBucket")
        self.assertIn("Id: ExpireAbandonedPendingUploads", bucket)
        self.assertIn("Value: pending", bucket)
        self.assertIn("ExpirationInDays: 7", bucket)
        pending_rule = bucket.split("Id: ExpireAbandonedPendingUploads", 1)[1].split(
            "Id: AbortAbandonedAlbumMultipartUploads", 1
        )[0]
        self.assertNotIn("\n            AbortIncompleteMultipartUpload:", pending_rule)
        self.assertIn("Id: AbortAbandonedAlbumMultipartUploads", bucket)
        self.assertIn("DaysAfterInitiation: 1", bucket)


class BrowserBoundaryTests(unittest.TestCase):
    def test_immutable_behavior_preserves_required_cloudfront_fields(self) -> None:
        default = {
            "TargetOriginId": "origin",
            "FieldLevelEncryptionId": "",
            "TrustedSigners": {"Enabled": False, "Quantity": 0},
            "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
            "FunctionAssociations": {"Quantity": 0},
            "LambdaFunctionAssociations": {"Quantity": 0},
            "ForwardedValues": {"QueryString": False},
        }
        behavior = cloudfront_frontend.cache_behavior(
            default, "assets/*", "headers-policy", BASELINE
        )
        self.assertEqual(behavior["FieldLevelEncryptionId"], "")
        self.assertIn("TrustedSigners", behavior)
        self.assertIn("TrustedKeyGroups", behavior)
        self.assertIn("FunctionAssociations", behavior)
        self.assertIn("LambdaFunctionAssociations", behavior)
        self.assertNotIn("ForwardedValues", behavior)

    def test_cors_is_exact_and_not_wildcarded(self) -> None:
        self.assertNotRegex(TEMPLATE, r"Allow(?:ed)?Origins?:\s*\[?['\"]?\*")
        self.assertNotIn("AllowedHeaders: ['*']", TEMPLATE)
        self.assertGreaterEqual(TEMPLATE.count("- !Ref FrontendUrl"), 2)
        api = resource_block("Api")
        self.assertIn("AllowOrigins:\n          - !Ref FrontendUrl", api)

    def test_frontend_security_policy_has_strict_script_sources(self) -> None:
        csp = BASELINE["content_security_policy_template"]
        script_directive = next(part for part in csp.split(";") if part.strip().startswith("script-src"))
        self.assertNotIn("'unsafe-inline'", script_directive)
        self.assertNotIn("'unsafe-eval'", script_directive)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertIn("object-src 'none'", csp)
        self.assertEqual(BASELINE["html_cache_control"], "no-cache, max-age=0, must-revalidate")
        self.assertIn("immutable", BASELINE["immutable_cache_control"])
        self.assertEqual(
            BASELINE["cache_policies"]["html"],
            "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        )

    def test_frontend_policy_renders_exact_s3_presigned_origins(self) -> None:
        csp = cloudfront_frontend.render_csp(
            BASELINE,
            media_domain="media.example.test",
            api_id="api-id",
            region="region-1",
            bucket="private-media",
        )
        self.assertIn("https://private-media.s3.amazonaws.com", csp)
        self.assertIn("https://private-media.s3.region-1.amazonaws.com", csp)
        self.assertNotIn("https://*.s3", csp)
        self.assertNotIn("{s3_origins}", csp)

    def test_cloudfront_apply_is_guarded(self) -> None:
        script = (ROOT / "ops" / "cloudfront_frontend.py").read_text(encoding="utf-8")
        for guard in ("--expected-etag", "--expected-account-id", "--apply"):
            self.assertIn(guard, script)
        self.assertIn('"ViewerProtocolPolicy": "redirect-to-https"', script)
        self.assertIn('"Compress": True', script)
        self.assertIn('desired_distribution["HttpVersion"] = "http2and3"', script)
        self.assertIn('desired_distribution["IsIPV6Enabled"] = True', script)
        main_source = script.split("def main() -> int:", 1)[1]
        self.assertLess(
            main_source.index("validate_apply_guards("),
            main_source.index("redirect_arn, redirect_action = ensure_www_redirect_function("),
        )

    def test_cloudfront_mutations_reject_stale_or_wrong_account_guards(self) -> None:
        with self.assertRaises(SystemExit):
            cloudfront_frontend.validate_apply_guards(
                apply=True,
                expected_etag="stale",
                current_etag="current",
                expected_account="account",
                account="account",
            )
        with self.assertRaises(SystemExit):
            cloudfront_frontend.validate_apply_guards(
                apply=True,
                expected_etag="current",
                current_etag="current",
                expected_account="wrong",
                account="account",
            )

    def test_www_redirect_source_and_association_guards(self) -> None:
        source = (ROOT / "ops" / "cloudfront_www_redirect.js").read_text(encoding="utf-8")
        self.assertIn("host === '__WWW_HOST__'", source)
        self.assertIn("https://__APEX_HOST__", source)
        self.assertIn("request.uri + suffix", source)
        self.assertIn("request.uri === '/api'", source)
        self.assertIn("request.uri.indexOf('/api/') === 0", source)
        self.assertIn("request.uri = '/index.html'", source)
        self.assertIn(
            ':function/{redirect_name}',
            (ROOT / "ops" / "dns_hardening.py").read_text(encoding="utf-8"),
        )
        self.assertTrue(cloudfront_frontend.certificate_covers("www.example.test", ["*.example.test"]))
        cloudfront_frontend.assert_no_foreign_viewer_request_function(
            {
                "DefaultCacheBehavior": {
                    "FunctionAssociations": {
                        "Items": [{
                            "EventType": "viewer-request",
                            "FunctionARN": "arn:aws:cloudfront::123:function/managed",
                        }]
                    }
                }
            },
            "managed",
        )
        with self.assertRaises(RuntimeError):
            cloudfront_frontend.assert_no_foreign_viewer_request_function(
                {
                    "DefaultCacheBehavior": {
                        "FunctionAssociations": {
                            "Items": [
                                {
                                    "EventType": "viewer-request",
                                    "FunctionARN": "arn:function/foreign",
                                }
                            ]
                        }
                    }
                },
                "managed",
            )

    def test_edge_request_router_preserves_api_and_rewrites_only_spa_navigation(self) -> None:
        node = shutil.which("node")
        if not node:
            self.skipTest("node is required to execute the CloudFront Function regression")
        source = (ROOT / "ops" / "cloudfront_www_redirect.js").read_text(encoding="utf-8")
        source = source.replace("__APEX_HOST__", "example.test").replace(
            "__WWW_HOST__", "www.example.test"
        )
        requests = [
            {
                "method": "GET",
                "uri": "/album/public-id",
                "headers": {"host": {"value": "example.test"}},
                "querystring": {},
            },
            {
                "method": "GET",
                "uri": "/api/definitely-not-a-route",
                "headers": {"host": {"value": "example.test"}},
                "querystring": {},
            },
            {
                "method": "GET",
                "uri": "/api",
                "headers": {"host": {"value": "example.test"}},
                "querystring": {},
            },
            {
                "method": "GET",
                "uri": "/assets/app.js",
                "headers": {"host": {"value": "example.test"}},
                "querystring": {},
            },
            {
                "method": "POST",
                "uri": "/contact",
                "headers": {"host": {"value": "example.test"}},
                "querystring": {},
            },
            {
                "method": "GET",
                "uri": "/album/public-id",
                "headers": {"host": {"value": "www.example.test"}},
                "querystring": {
                    "view": {"value": "grid"},
                    "label": {"value": "golden%20hour"},
                },
            },
        ]
        runner = source + "\nprocess.stdout.write(JSON.stringify(" + json.dumps(requests) + ".map(function(request) { return handler({request: request}); })));"
        completed = subprocess.run(
            [node, "-e", runner], check=True, text=True, capture_output=True
        )
        results = json.loads(completed.stdout)
        self.assertEqual(results[0]["uri"], "/index.html")
        self.assertEqual(results[1]["uri"], "/api/definitely-not-a-route")
        self.assertEqual(results[2]["uri"], "/api")
        self.assertEqual(results[3]["uri"], "/assets/app.js")
        self.assertEqual(results[4]["uri"], "/contact")
        self.assertEqual(results[5]["statusCode"], 301)
        self.assertEqual(
            results[5]["headers"]["location"]["value"],
            "https://example.test/album/public-id?view=grid&label=golden%20hour",
        )
    def test_private_frontend_origin_migration_is_staged_and_guarded(self) -> None:
        script = (ROOT / "ops" / "migrate_frontend_origin.py").read_text(encoding="utf-8")
        for expected in (
            "--expected-etag",
            "--expected-account-id",
            "--expected-bucket",
            "--rollback-file",
            "create-origin-access-control",
            "OriginAccessControlId",
            "put-public-access-block",
            "BlockPublicPolicy",
            "wait_deployed",
            "smoke_check",
        ):
            self.assertIn(expected, script)


class IdentityAndSecretTests(unittest.TestCase):
    def test_global_environment_contains_only_identifiers_and_rollout_controls(self) -> None:
        globals_section = TEMPLATE.split("Globals:", 1)[1].split("Resources:", 1)[0]
        self.assertIn("COGNITO_USER_POOL_ID: !Ref UserPool", globals_section)
        self.assertIn("COGNITO_CLIENT_ID: !Ref UserPoolClient", globals_section)
        self.assertIn(
            "FRONT_DOOR_CONFIG_PARAMETER: !Sub '/ian-website/${Stage}/front-door-config'",
            globals_section,
        )
        self.assertIn(
            "FRONT_DOOR_ENFORCEMENT_ENABLED: !Ref FrontDoorEnforcementEnabled",
            globals_section,
        )
        self.assertIn(
            "FRONT_DOOR_SECRET_CACHE_TTL_SECONDS: !Ref FrontDoorSecretCacheTtlSeconds",
            globals_section,
        )
        for forbidden in (
            "API_KEY",
            "IMAGES_BUCKET",
            "ALBUMS_TABLE",
            "RATE_LIMIT_HASH_SECRET",
            "RESEND_API_KEY",
            "TURNSTILE_SECRET",
            "GOOGLE_OAUTH_SECRET",
            "FRONT_DOOR_ORIGIN_VALUE",
        ):
            self.assertNotIn(forbidden, globals_section)

    def test_legacy_secret_parameters_are_hidden(self) -> None:
        for parameter in ("ResendApiKey", "TurnstileSecretKey"):
            match = re.search(rf"(?ms)^  {parameter}:\n(?P<body>.*?)(?=^  [A-Za-z][A-Za-z0-9]+:\n|^Conditions:)", TEMPLATE)
            self.assertIsNotNone(match)
            self.assertIn("NoEcho: true", match.group("body"))

    def test_rate_limit_identifiers_use_one_exact_secure_parameter(self) -> None:
        self.assertNotIn("AWS::SecretsManager::Secret", TEMPLATE)
        self.assertEqual(
            TEMPLATE.count("RATE_LIMIT_HASH_PARAMETER: !Sub '/ian-website/${Stage}/rate-limit-hash'"),
            6,
        )
        self.assertEqual(TEMPLATE.count("Action: ssm:GetParameter"), 16)

    def test_cognito_client_has_no_public_password_or_srp_flow(self) -> None:
        client = resource_block("UserPoolClient")
        self.assertIn("ALLOW_ADMIN_USER_PASSWORD_AUTH", client)
        self.assertIn("EnableTokenRevocation: true", client)
        self.assertIn("PreventUserExistenceErrors: ENABLED", client)
        self.assertNotIn("ALLOW_USER_PASSWORD_AUTH", client)
        self.assertNotIn("ALLOW_USER_SRP_AUTH", client)

    def test_login_permissions_are_split_by_operation(self) -> None:
        login = resource_block("LoginFunction")
        challenge = resource_block("CompleteChallengeFunction")
        self.assertIn("AdminInitiateAuth", login)
        self.assertNotIn("AdminRespondToAuthChallenge", login)
        self.assertIn("AdminRespondToAuthChallenge", challenge)
        self.assertNotIn("AdminInitiateAuth", challenge)


class MigrationAndPackagingTests(unittest.TestCase):
    def test_legacy_prefix_backfill_accepts_valid_single_segment_record(self) -> None:
        album_id = "22222222-2222-4222-8222-222222222222"
        prefix = "albums/summer-portraits-a1b2c3d4/"
        albums = [{
            "albumId": {"S": album_id},
            "s3Prefix": {"S": prefix},
            "coverImageUrl": {"S": prefix + "original/cover.jpg"},
            "coverThumbKey": {"S": prefix + "thumbnail/cover.jpg"},
            "images": {"L": [{"M": {
                "rawKey": {"S": prefix + "original/photo.jpg"},
                "thumbKey": {"S": prefix + "thumbnail/photo.jpg"},
                "hlsUrl": {"S": prefix + "original/photo_hls/photo.m3u8"},
            }}]},
        }]
        candidates, counts = backfill_legacy_media_prefix.build_backfill_plan(albums)
        self.assertEqual(candidates, [(album_id, prefix)])
        self.assertEqual(sum(counts.values()), 0)

    def test_legacy_prefix_backfill_refuses_duplicates_and_cross_prefix_keys(self) -> None:
        prefix = "albums/shared-prefix/"
        albums = [
            {"albumId": {"S": "11111111-1111-4111-8111-111111111111"}, "s3Prefix": {"S": prefix}},
            {"albumId": {"S": "22222222-2222-4222-8222-222222222222"}, "s3Prefix": {"S": prefix}},
            {
                "albumId": {"S": "33333333-3333-4333-8333-333333333333"},
                "s3Prefix": {"S": "albums/third/"},
                "images": {"L": [{"M": {"rawKey": {"S": "albums/foreign/photo.jpg"}}}]},
            },
        ]
        candidates, counts = backfill_legacy_media_prefix.build_backfill_plan(albums)
        self.assertEqual(candidates, [])
        self.assertEqual(counts["duplicatePrefixCount"], 2)
        self.assertEqual(counts["crossPrefixMediaKeyCount"], 1)

    def test_legacy_prefix_backfill_paginates_scan(self) -> None:
        pages = [
            {"Items": [{"albumId": {"S": "one"}}], "LastEvaluatedKey": {"albumId": {"S": "one"}}},
            {"Items": [{"albumId": {"S": "two"}}]},
        ]
        with patch.object(backfill_legacy_media_prefix, "aws_json", side_effect=pages) as mocked:
            items = backfill_legacy_media_prefix.scan_all("table", None, "region")
        self.assertEqual([item["albumId"]["S"] for item in items], ["one", "two"])
        self.assertIn("--exclusive-start-key", mocked.call_args_list[1].args[0])

    def test_legacy_prefix_plan_digest_is_stable_and_plan_bound(self) -> None:
        first = [
            ("22222222-2222-4222-8222-222222222222", "albums/two/"),
            ("11111111-1111-4111-8111-111111111111", "albums/one/"),
        ]
        self.assertEqual(
            backfill_legacy_media_prefix.plan_digest(first),
            backfill_legacy_media_prefix.plan_digest(list(reversed(first))),
        )
        changed = [*first[:-1], (first[-1][0], "albums/changed/")]
        self.assertNotEqual(
            backfill_legacy_media_prefix.plan_digest(first),
            backfill_legacy_media_prefix.plan_digest(changed),
        )

    def test_owner_backfill_uuid_validation(self) -> None:
        value = "11111111-1111-4111-8111-111111111111"
        self.assertEqual(backfill_album_owner_sub.valid_uuid(value), value)
        self.assertIsNone(backfill_album_owner_sub.valid_uuid("not-a-uuid"))
        self.assertIsNone(backfill_album_owner_sub.valid_uuid(""))
        self.assertIsNone(backfill_album_owner_sub.valid_uuid(None))

    def test_owner_backfill_builds_safe_private_candidate(self) -> None:
        album_id = "22222222-2222-4222-8222-222222222222"
        subject = "11111111-1111-4111-8111-111111111111"
        email = "person\u0040example.test"
        albums = [{
            "albumId": {"S": album_id},
            "ownerEmail": {"S": email},
            "visibility": {"S": "private"},
            "status": {"S": "active"},
        }]
        users = [{"Attributes": [{"Name": "email", "Value": email}, {"Name": "sub", "Value": subject}]}]
        candidates, counts = backfill_album_owner_sub.build_backfill_plan(albums, users)
        self.assertEqual(candidates, [(album_id, subject)])
        self.assertEqual(sum(counts.values()), 0)

    def test_tag_migration_paginates_dynamodb_scan(self) -> None:
        pages = [
            {"Items": [{"albumId": {"S": "one"}}], "LastEvaluatedKey": {"albumId": {"S": "one"}}},
            {"Items": [{"albumId": {"S": "two"}}]},
        ]
        with patch.object(tag_existing_media, "aws_json", side_effect=pages) as mocked:
            items = tag_existing_media.scan_all("table", None, "region")
        self.assertEqual([item["albumId"]["S"] for item in items], ["one", "two"])
        self.assertIn("--exclusive-start-key", mocked.call_args_list[1].args[0])

    def test_tag_migration_quarantines_every_orphan(self) -> None:
        assignments = {"albums/one/raw.jpg": "public", "albums/missing.jpg": "private"}
        universe = {"albums/one/raw.jpg", "albums/orphan.bin"}
        plan, orphans, missing = tag_existing_media.classify_existing_objects(
            assignments, universe
        )
        self.assertEqual(plan["albums/one/raw.jpg"], "public")
        self.assertEqual(plan["albums/orphan.bin"], "quarantined")
        self.assertEqual(orphans, {"albums/orphan.bin"})
        self.assertEqual(missing, {"albums/missing.jpg"})
        self.assertEqual(set(plan), universe)

    def test_tag_migration_uses_pooled_sdk_with_cli_fallback(self) -> None:
        source = (ROOT / "ops" / "tag_existing_media.py").read_text(encoding="utf-8")
        self.assertIn("max_pool_connections=max(16, workers * 2)", source)
        self.assertIn("tag_client.get_object_tagging", source)
        self.assertIn("tag_client.put_object_tagging", source)
        self.assertIn('"aws-cli"', source)
        self.assertIn("legacyS3Prefix", source)
        self.assertNotIn('album.get("s3Prefix")', source)

    def test_tag_migration_paginates_s3_listing(self) -> None:
        pages = [
            {"Contents": [{"Key": "one"}], "IsTruncated": True, "NextContinuationToken": "next"},
            {"Contents": [{"Key": "two"}], "IsTruncated": False},
        ]
        with patch.object(tag_existing_media, "aws_json", side_effect=pages) as mocked:
            keys = tag_existing_media.list_objects_all("bucket", "prefix", None, "region")
        self.assertEqual(keys, ["one", "two"])
        self.assertIn("--continuation-token", mocked.call_args_list[1].args[0])

    def test_tag_migration_refuses_truncated_s3_page_without_token(self) -> None:
        with patch.object(
            tag_existing_media,
            "aws_json",
            return_value={"Contents": [], "IsTruncated": True},
        ):
            with self.assertRaises(RuntimeError):
                tag_existing_media.list_objects_all("bucket", "prefix", None, "region")

    def test_gsi_rollout_is_explicit_and_sequential(self) -> None:
        self.assertIn("AlbumIndexDeploymentPhase", TEMPLATE)
        self.assertIn("AllowedValues:\n      - none\n      - visibility\n      - summary\n      - both", TEMPLATE)
        self.assertIn("VisibilityCreatedAtIndex", resource_block("AlbumsTable"))
        self.assertIn("VisibilityCreatedAtSummaryIndex", resource_block("AlbumsTable"))
        self.assertIn("OwnerSubCreatedAtIndex", resource_block("AlbumsTable"))

    def test_public_summary_index_excludes_manifests_and_private_fields(self) -> None:
        table = resource_block("AlbumsTable")
        summary = table.split("IndexName: VisibilityCreatedAtSummaryIndex", 1)[1].split(
            "- HasOwnerIndex", 1
        )[0]
        self.assertIn("ProjectionType: INCLUDE", summary)
        for required in (
            "status",
            "type",
            "title",
            "description",
            "category",
            "imageCount",
            "coverImageUrl",
            "coverThumbKey",
            "coverBlurhash",
            "legacyS3Prefix",
        ):
            self.assertRegex(summary, rf"(?m)^\s+- {required}$")
        for forbidden in (
            "images",
            "ownerEmail",
            "ownerSub",
            "shareCode",
            "isShared",
            "backupToGoogleDrive",
            "s3Prefix",
        ):
            self.assertNotRegex(summary, rf"(?m)^\s+- {forbidden}$")

    def test_build_uses_explicit_python_allowlists_and_pins_runtime_dependencies(self) -> None:
        self.assertNotIn("cp functions/*.py", MAKEFILE)
        self.assertIn("SOURCES_GetAlbumsFunction :=", MAKEFILE)
        self.assertIn("SOURCES_EditUserFunction :=", MAKEFILE)
        self.assertIn("no explicit Python source allowlist exists", MAKEFILE)
        self.assertIn('cp "functions/$$source" "$(ARTIFACTS_DIR)/"', MAKEFILE)
        self.assertNotIn("cp functions/*.json", MAKEFILE)
        for dependency in (
            "PyJWT==2.13.0",
            "cryptography==50.0.0",
            "resend==2.34.0",
            "ExifRead==3.5.1",
            "google-api-python-client==2.198.0",
            "google-auth==2.56.0",
            "google-auth-httplib2==0.4.0",
        ):
            self.assertIn(dependency, MAKEFILE)
        self.assertIn("credential-like JSON entered a Lambda artifact", MAKEFILE)

    def test_operational_mutations_are_dry_run_by_default(self) -> None:
        for name in (
            "backfill_album_owner_sub.py",
            "backfill_legacy_media_prefix.py",
            "cloudfront_frontend.py",
            "dns_hardening.py",
            "invalidate_media_cache.py",
            "migrate_frontend_origin.py",
            "set_lambda_log_retention.py",
            "tag_existing_media.py",
        ):
            script = (ROOT / "ops" / name).read_text(encoding="utf-8")
            self.assertIn('parser.add_argument("--apply", action="store_true")', script)
            self.assertRegex(script, r"if not args\.apply:\n\s+return 0|if not args\.apply:\n\s+print")


if __name__ == "__main__":
    unittest.main()
