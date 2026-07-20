"""Source-level regression tests for the infrastructure security baseline."""

from __future__ import annotations

import json
from pathlib import Path
import re
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
        missing = [name for name in handlers if not (ROOT / "backend" / "functions" / f"{name}.py").is_file()]
        self.assertEqual(missing, [])


class DataProtectionTests(unittest.TestCase):
    def test_new_fixed_name_log_resources_do_not_orphan_on_initial_rollback(self) -> None:
        for logical_id in ("MediaAccessLogsBucket", "ApiAccessLogGroup"):
            block = resource_block(logical_id)
            self.assertIn("DeletionPolicy: RetainExceptOnCreate", block)
            self.assertIn("UpdateReplacePolicy: Retain", block)

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

    def test_existing_tables_do_not_toggle_dynamodb_encryption_mode(self) -> None:
        # DynamoDB always encrypts tables at rest. Explicitly adding/removing an
        # AWS-owned-key SSESpecification on these existing resources needlessly
        # consumes the service's guarded encryption-mode update quota.
        for logical_id in ("AlbumsTable", "RateLimitTable"):
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
        self.assertIn("host !== '__WWW_HOST__'", source)
        self.assertIn("https://__APEX_HOST__", source)
        self.assertIn("request.uri + suffix", source)
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
                            "Items": [{"EventType": "viewer-request", "FunctionARN": "arn:function/foreign"}]
                        }
                    }
                },
                "managed",
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
    def test_global_environment_contains_only_public_cognito_ids(self) -> None:
        globals_section = TEMPLATE.split("Globals:", 1)[1].split("Resources:", 1)[0]
        self.assertIn("COGNITO_USER_POOL_ID: !Ref UserPool", globals_section)
        self.assertIn("COGNITO_CLIENT_ID: !Ref UserPoolClient", globals_section)
        for forbidden in ("SECRET", "API_KEY", "IMAGES_BUCKET", "ALBUMS_TABLE"):
            self.assertNotIn(forbidden, globals_section)

    def test_legacy_secret_parameters_are_hidden(self) -> None:
        for parameter in ("ResendApiKey", "TurnstileSecretKey"):
            match = re.search(rf"(?ms)^  {parameter}:\n(?P<body>.*?)(?=^  [A-Za-z][A-Za-z0-9]+:\n|^Conditions:)", TEMPLATE)
            self.assertIsNotNone(match)
            self.assertIn("NoEcho: true", match.group("body"))

    def test_rate_limit_identifiers_use_a_stack_generated_hmac_key(self) -> None:
        secret = resource_block("RateLimitHashSecret")
        self.assertIn("AWS::SecretsManager::Secret", secret)
        self.assertIn("PasswordLength: 64", secret)
        self.assertIn("DeletionPolicy: Retain", secret)
        self.assertEqual(TEMPLATE.count("RATE_LIMIT_HASH_SECRET_ARN: !Ref RateLimitHashSecret"), 6)

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
        self.assertIn("AllowedValues:\n      - none\n      - visibility\n      - both", TEMPLATE)
        self.assertIn("VisibilityCreatedAtIndex", resource_block("AlbumsTable"))
        self.assertIn("OwnerSubCreatedAtIndex", resource_block("AlbumsTable"))

    def test_build_only_copies_python_and_pins_runtime_dependencies(self) -> None:
        self.assertIn('cp functions/*.py "$(ARTIFACTS_DIR)/"', MAKEFILE)
        self.assertNotIn("cp functions/*.json", MAKEFILE)
        for dependency in (
            "PyJWT==2.13.0",
            "cryptography==49.0.0",
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
