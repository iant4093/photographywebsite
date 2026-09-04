import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
if str(OPS) not in sys.path:
    sys.path.insert(0, str(OPS))

import cloudfront_frontend
import migrate_frontend_origin


class CloudFrontHelperTests(unittest.TestCase):
    def test_aws_wrappers_success_redacted_failure_and_temp_payload(self):
        with patch.object(
            cloudfront_frontend.subprocess, "run", return_value=Mock(stdout='{"ok":true}')
        ) as run:
            self.assertEqual(cloudfront_frontend.aws_json(["s", "o"], profile="p"), {"ok": True})
        self.assertIn("--profile", run.call_args.args[0])
        failure = subprocess.CalledProcessError(1, ["aws"], output="private config", stderr="safe failure")
        with patch.object(cloudfront_frontend.subprocess, "run", side_effect=failure), self.assertRaisesRegex(
            RuntimeError, "safe failure"
        ) as raised:
            cloudfront_frontend.aws_json(["s", "o"])
        self.assertNotIn("private config", str(raised.exception))

        handle = Mock()
        handle.name = "/tmp/payload.json"
        handle.__enter__ = Mock(return_value=handle)
        handle.__exit__ = Mock(return_value=False)
        with patch.object(cloudfront_frontend.tempfile, "NamedTemporaryFile", return_value=handle), patch.object(
            cloudfront_frontend.json, "dump"
        ) as dump, patch.object(cloudfront_frontend, "aws_json", return_value={"done": True}) as aws:
            self.assertEqual(
                cloudfront_frontend.aws_with_json_file(["cmd", "file://{json_file}"], {"x": 1}),
                {"done": True},
            )
        dump.assert_called_once()
        handle.flush.assert_called_once()
        self.assertEqual(aws.call_args.args[0][-1], "file:///tmp/payload.json")

    def test_normalize_certificate_cache_policy_and_associations(self):
        self.assertEqual(
            list(cloudfront_frontend.normalize({"b": [{"z": 1}], "a": 2})), ["a", "b"]
        )
        provider_policy = {
            "SecurityHeadersConfig": {
                "ContentTypeOptions": {"Override": True},
                "ContentSecurityPolicy": {},
                "XSSProtection": {},
            },
            "HeadersConfig": {
                "HeadersBehavior": "whitelist",
                "Headers": {"Quantity": 2, "Items": ["Zeta", "Alpha"]},
            },
        }
        source_policy = {
            "SecurityHeadersConfig": {"ContentTypeOptions": {"Override": True}},
            "HeadersConfig": {
                "HeadersBehavior": "whitelist",
                "Headers": {"Quantity": 2, "Items": ["Alpha", "Zeta"]},
            },
        }
        self.assertEqual(
            cloudfront_frontend.normalize_policy(provider_policy),
            cloudfront_frontend.normalize_policy(source_policy),
        )
        self.assertEqual(
            cloudfront_frontend.normalize_policy(
                {"Headers": {"Items": ["Alpha", {"not": "a header name"}]}}
            ),
            {"Headers": {"Items": ["Alpha", {"not": "a header name"}]}},
        )
        self.assertTrue(cloudfront_frontend.certificate_covers("WWW.Example.test.", ["www.example.test"]))
        self.assertTrue(cloudfront_frontend.certificate_covers("www.example.test", ["*.example.test"]))
        self.assertFalse(cloudfront_frontend.certificate_covers("deep.www.example.test", ["*.example.test"]))
        self.assertFalse(cloudfront_frontend.certificate_covers("other.test", ["example.test"]))

        baseline = {"cache_policies": {"html": "id", "static": "other"}}
        with patch.object(cloudfront_frontend, "aws_json", return_value={}):
            cloudfront_frontend.validate_cache_policy_ids(baseline, None)
        with patch.object(cloudfront_frontend, "aws_json", side_effect=RuntimeError("missing")), self.assertRaises(
            SystemExit
        ):
            cloudfront_frontend.validate_cache_policy_ids(baseline, None)

        behavior = {
            "FunctionAssociations": {
                "Items": [
                    {"EventType": "viewer-response", "FunctionARN": "keep"},
                    {"EventType": "viewer-request", "FunctionARN": "old"},
                ]
            }
        }
        cloudfront_frontend.associate_viewer_request(behavior, "new")
        self.assertEqual(behavior["FunctionAssociations"]["Quantity"], 2)
        self.assertEqual(behavior["FunctionAssociations"]["Items"][-1]["FunctionARN"], "new")

    def test_legacy_spa_errors_are_removed_without_touching_other_errors(self):
        config = {
            "CustomErrorResponses": {
                "Quantity": 3,
                "Items": [
                    {
                        "ErrorCode": 403,
                        "ResponsePagePath": "/index.html",
                        "ResponseCode": "200",
                        "ErrorCachingMinTTL": 0,
                    },
                    {
                        "ErrorCode": 404,
                        "ResponsePagePath": "/index.html",
                        "ResponseCode": "200",
                        "ErrorCachingMinTTL": 0,
                    },
                    {"ErrorCode": 503, "ErrorCachingMinTTL": 1},
                ],
            }
        }
        cloudfront_frontend.remove_legacy_spa_error_responses(config)
        self.assertEqual(
            config["CustomErrorResponses"],
            {"Quantity": 1, "Items": [{"ErrorCode": 503, "ErrorCachingMinTTL": 1}]},
        )
        cloudfront_frontend.remove_legacy_spa_error_responses(
            {"CustomErrorResponses": {"Quantity": 0}}
        )

    def test_dependency_refresh_accepts_etag_rotation_but_rejects_config_drift(self):
        expected = {"Enabled": True, "Comment": "stable"}
        refreshed = {"ETag": "new-etag", "DistributionConfig": expected}
        with patch.object(cloudfront_frontend, "aws_json", return_value=refreshed):
            self.assertEqual(
                cloudfront_frontend.refresh_distribution_after_dependencies(
                    "distribution", expected, profile=None
                ),
                ("new-etag", expected),
            )
        changed = {
            "ETag": "foreign-etag",
            "DistributionConfig": {**expected, "Comment": "changed"},
        }
        with patch.object(cloudfront_frontend, "aws_json", return_value=changed), self.assertRaisesRegex(
            SystemExit, "configuration changed"
        ):
            cloudfront_frontend.refresh_distribution_after_dependencies(
                "distribution", expected, profile=None
            )

    def test_redirect_function_dry_run_duplicate_create_and_update(self):
        existing = {
            "Name": "managed",
            "FunctionMetadata": {"FunctionARN": "arn:function/managed"},
        }
        with patch.object(
            cloudfront_frontend, "aws_json", return_value={"FunctionList": {"Items": [existing]}}
        ):
            self.assertEqual(
                cloudfront_frontend.ensure_www_redirect_function(
                    name="managed", apex="example.test", www="www.example.test", apply=False, profile=None
                ),
                ("arn:function/managed", "update-and-publish"),
            )
        with patch.object(
            cloudfront_frontend, "aws_json", return_value={"FunctionList": {"Items": []}}
        ):
            self.assertEqual(
                cloudfront_frontend.ensure_www_redirect_function(
                    name="managed", apex="example.test", www="www.example.test", apply=False, profile=None
                ),
                (None, "create-and-publish"),
            )
        with patch.object(
            cloudfront_frontend,
            "aws_json",
            return_value={"FunctionList": {"Items": [existing, existing]}},
        ), self.assertRaises(RuntimeError):
            cloudfront_frontend.ensure_www_redirect_function(
                name="managed", apex="a", www="w", apply=False, profile=None
            )

        temp = Mock()
        temp.name = "/tmp/function.js"
        temp.__enter__ = Mock(return_value=temp)
        temp.__exit__ = Mock(return_value=False)

        def apply_create(arguments, *, profile=None):
            if arguments[:2] == ["cloudfront", "list-functions"]:
                return {"FunctionList": {"Items": []}}
            if arguments[:2] == ["cloudfront", "create-function"]:
                return {"ETag": "created-etag"}
            if arguments[:2] == ["cloudfront", "publish-function"]:
                return {"FunctionSummary": {"FunctionMetadata": {"FunctionARN": "arn:published"}}}
            raise AssertionError(arguments)

        with patch.object(cloudfront_frontend.tempfile, "NamedTemporaryFile", return_value=temp), patch.object(
            cloudfront_frontend, "aws_json", side_effect=apply_create
        ):
            self.assertEqual(
                cloudfront_frontend.ensure_www_redirect_function(
                    name="managed", apex="a", www="w", apply=True, profile=None
                ),
                ("arn:published", "published"),
            )
        self.assertIn("a", temp.write.call_args.args[0])

        def apply_update(arguments, *, profile=None):
            if arguments[:2] == ["cloudfront", "list-functions"]:
                return {"FunctionList": {"Items": [existing]}}
            if arguments[:2] == ["cloudfront", "describe-function"]:
                return {"ETag": "old"}
            if arguments[:2] == ["cloudfront", "update-function"]:
                return {"ETag": "new"}
            if arguments[:2] == ["cloudfront", "publish-function"]:
                return {"FunctionSummary": {"FunctionMetadata": {"FunctionARN": "arn:updated"}}}
            raise AssertionError(arguments)

        with patch.object(cloudfront_frontend.tempfile, "NamedTemporaryFile", return_value=temp), patch.object(
            cloudfront_frontend, "aws_json", side_effect=apply_update
        ):
            self.assertEqual(
                cloudfront_frontend.ensure_www_redirect_function(
                    name="managed", apex="a", www="w", apply=True, profile=None
                )[0],
                "arn:updated",
            )

    def test_policy_crud_and_cache_behavior(self):
        baseline = {
            "content_security_policy": "default-src 'self'",
            "permissions_policy": "camera=()",
            "cache_policies": {"immutable": "immutable", "static": "static"},
        }
        desired = cloudfront_frontend.policy_config("policy", baseline, "max-age=1")
        self.assertEqual(desired["CustomHeadersConfig"]["Quantity"], 3)
        self.assertIn(
            {
                "Header": "Cross-Origin-Opener-Policy",
                "Value": "same-origin",
                "Override": True,
            },
            desired["CustomHeadersConfig"]["Items"],
        )
        hsts = desired["SecurityHeadersConfig"]["StrictTransportSecurity"]
        self.assertTrue(hsts["IncludeSubdomains"])
        self.assertTrue(hsts["Preload"])
        listing = {
            "ResponseHeadersPolicyList": {
                "Items": [
                    {
                        "ResponseHeadersPolicy": {
                            "Id": "policy-id",
                            "ResponseHeadersPolicyConfig": {"Name": "policy"},
                        }
                    }
                ]
            }
        }
        with patch.object(cloudfront_frontend, "aws_json", return_value=listing):
            self.assertEqual(cloudfront_frontend.list_custom_response_policies(None), {"policy": {"Id": "policy-id"}})

        with patch.object(cloudfront_frontend, "list_custom_response_policies", return_value={}):
            self.assertEqual(
                cloudfront_frontend.ensure_response_policy(desired, apply=False, profile=None),
                (None, "create"),
            )
        with patch.object(cloudfront_frontend, "list_custom_response_policies", return_value={}), patch.object(
            cloudfront_frontend,
            "aws_with_json_file",
            return_value={"ResponseHeadersPolicy": {"Id": "new"}},
        ):
            self.assertEqual(
                cloudfront_frontend.ensure_response_policy(desired, apply=True, profile=None),
                ("new", "created"),
            )
        current = {"ResponseHeadersPolicyConfig": desired, "ETag": "etag"}
        with patch.object(
            cloudfront_frontend, "list_custom_response_policies", return_value={"policy": {"Id": "id"}}
        ), patch.object(cloudfront_frontend, "aws_json", return_value=current):
            self.assertEqual(
                cloudfront_frontend.ensure_response_policy(desired, apply=True, profile=None),
                ("id", "unchanged"),
            )
        changed = {**desired, "Comment": "changed"}
        with patch.object(
            cloudfront_frontend, "list_custom_response_policies", return_value={"policy": {"Id": "id"}}
        ), patch.object(cloudfront_frontend, "aws_json", return_value=current):
            self.assertEqual(
                cloudfront_frontend.ensure_response_policy(changed, apply=False, profile=None),
                ("id", "update"),
            )
        with patch.object(
            cloudfront_frontend, "list_custom_response_policies", return_value={"policy": {"Id": "id"}}
        ), patch.object(cloudfront_frontend, "aws_json", return_value=current), patch.object(
            cloudfront_frontend, "aws_with_json_file"
        ) as update:
            self.assertEqual(
                cloudfront_frontend.ensure_response_policy(changed, apply=True, profile=None),
                ("id", "updated"),
            )
        update.assert_called_once()
        behavior = cloudfront_frontend.cache_behavior(
            {"TargetOriginId": "origin", "ForwardedValues": {}, "MinTTL": 0},
            "assets/*",
            "headers",
            baseline,
        )
        self.assertNotIn("ForwardedValues", behavior)
        self.assertEqual(behavior["CachePolicyId"], "immutable")

        print_baseline = {
            "fotomoto_print": {
                "content_security_policy_template": "default-src 'none'; img-src {media_origin}",
                "response_policy_name": "print-policy",
                "content_security_policy": "default-src 'none'",
                "permissions_policy": "camera=()",
            }
        }
        self.assertEqual(
            cloudfront_frontend.render_print_csp(print_baseline, media_domain="media.example"),
            "default-src 'none'; img-src https://media.example",
        )
        for invalid_print_baseline in (
            {},
            {"fotomoto_print": {"content_security_policy_template": 42}},
            {"fotomoto_print": {"content_security_policy_template": "default-src 'none'"}},
        ):
            with self.subTest(invalid_print_baseline=invalid_print_baseline), self.assertRaises(
                SystemExit
            ):
                cloudfront_frontend.render_print_csp(
                    invalid_print_baseline,
                    media_domain="media.example",
                )
        print_policy = cloudfront_frontend.print_policy_config(print_baseline)
        self.assertEqual(print_policy["Name"], "print-policy")
        self.assertEqual(print_policy["CustomHeadersConfig"]["Quantity"], 4)
        self.assertNotIn("FrameOptions", print_policy["SecurityHeadersConfig"])


class CloudFrontMainTests(unittest.TestCase):
    def setUp(self):
        self.baseline = {
            "canonical_alias": "example.test",
            "optional_www_alias": "www.example.test",
            "content_security_policy_template": "default-src 'self'; connect-src {media_origin} {api_origin} {cognito_origin} {s3_origins}",
            "permissions_policy": "camera=()",
            "html_cache_control": "no-cache",
            "static_cache_control": "max-age=1",
            "immutable_cache_control": "max-age=2, immutable",
            "response_policy_names": {"html": "html", "static": "static", "immutable": "immutable"},
            "cache_policies": {"html": "html-cache", "static": "static-cache", "immutable": "immutable-cache"},
            "immutable_path_patterns": ["assets/*"],
            "static_path_patterns": ["images/*"],
        }
        self.baseline_file = Mock()
        self.baseline_file.read_text.return_value = json.dumps(self.baseline)
        self.config = {
            "Origins": {
                "Items": [
                    {
                        "Id": "origin",
                        "DomainName": "bucket.s3-website-us-west-2.amazonaws.com",
                        "CustomOriginConfig": {},
                    }
                ]
            },
            "DefaultCacheBehavior": {
                "TargetOriginId": "origin",
                "ForwardedValues": {},
                "MinTTL": 0,
                "FunctionAssociations": {"Items": []},
            },
            "CacheBehaviors": {
                "Items": [
                    {"PathPattern": "preserve/*", "FunctionAssociations": {"Items": []}},
                    {"PathPattern": "assets/*"},
                ]
            },
            "ViewerCertificate": {"ACMCertificateArn": "arn:aws:acm:us-east-1:123:certificate/id"},
        }

    def fake_aws(self, arguments, *, profile=None, config=None, certificate_good=True):
        if arguments[:2] == ["cloudfront", "get-distribution"]:
            return {"Distribution": {"DomainName": "media.example"}}
        if arguments[:2] == ["cloudfront", "get-distribution-config"]:
            return {"ETag": "etag", "DistributionConfig": config or self.config}
        if arguments[:2] == ["sts", "get-caller-identity"]:
            return {"Account": "123"}
        if arguments[:2] == ["acm", "describe-certificate"]:
            return {
                "Certificate": {
                    "Status": "ISSUED" if certificate_good else "PENDING_VALIDATION",
                    "DomainName": "example.test",
                    "SubjectAlternativeNames": ["www.example.test"],
                }
            }
        raise AssertionError(arguments)

    def run_main(self, *arguments, config=None, certificate_good=True, apply_update=None):
        stack_values = {
            "ImagesCloudFront": "MEDIA",
            "Api": "API",
            "ImagesBucket": "BUCKET",
            "OriginalPreviewBucket": "ORIGINAL-BUCKET",
        }
        fake_aws = lambda args, profile=None: self.fake_aws(
            args, profile=profile, config=config, certificate_good=certificate_good
        )
        with patch.object(sys, "argv", [cloudfront_frontend.__file__, "--stack-name", "stack", *arguments]), patch.object(
            cloudfront_frontend.argparse.ArgumentParser, "parse_args", wraps=None
        ) if False else patch.object(
            cloudfront_frontend, "discover_distribution_by_alias", return_value={"Id": "FRONT"}
        ), patch.object(cloudfront_frontend, "stack_resource", side_effect=lambda stack, logical_id, *unused: stack_values[logical_id]), patch.object(
            cloudfront_frontend, "aws_json", side_effect=fake_aws
        ), patch.object(cloudfront_frontend, "validate_cache_policy_ids"), patch.object(
            cloudfront_frontend,
            "ensure_response_policy",
            side_effect=[("html-id", "unchanged"), ("static-id", "unchanged"), ("immutable-id", "unchanged")],
        ), patch.object(cloudfront_frontend, "ensure_www_redirect_function", return_value=("arn:function/redirect", "published")), patch.object(
            cloudfront_frontend, "aws_with_json_file", side_effect=apply_update
        ) as update, patch.object(
            cloudfront_frontend.Path, "read_text", return_value=json.dumps(self.baseline)
        ), patch("sys.stdout", new_callable=io.StringIO) as output:
            result = cloudfront_frontend.main()
        return result, output.getvalue(), update

    def test_main_dry_run_invalid_origin_and_certificate_guards(self):
        result, output, update = self.run_main()
        self.assertEqual(result, 0)
        self.assertIn("Dry run only", output)
        update.assert_not_called()
        invalid = {
            **self.config,
            "Origins": {"Items": [{"Id": "origin", "DomainName": "custom.example"}]},
        }
        with self.assertRaisesRegex(SystemExit, "frontend origin"):
            self.run_main(config=invalid)
        missing_cert = {**self.config, "ViewerCertificate": {}}
        with self.assertRaisesRegex(SystemExit, "ACM certificate"):
            self.run_main("--include-www", config=missing_cert)
        with self.assertRaisesRegex(SystemExit, "does not cover www"):
            self.run_main("--include-www", certificate_good=False)

    def test_main_apply_updates_exact_distribution_and_optional_logging(self):
        result, output, update = self.run_main(
            "--apply",
            "--expected-etag",
            "etag",
            "--expected-account-id",
            "123",
            "--include-www",
            "--logging-bucket-domain",
            "logs.example.",
        )
        self.assertEqual(result, 0)
        desired = update.call_args.args[1]
        self.assertEqual(desired["Aliases"]["Items"], ["example.test", "www.example.test"])
        self.assertEqual(desired["Logging"]["Bucket"], "logs.example")
        self.assertEqual(desired["HttpVersion"], "http2and3")
        self.assertEqual(desired["CacheBehaviors"]["Quantity"], 3)
        self.assertIn("update submitted", output)


class MigrationHelperTests(unittest.TestCase):
    def test_json_file_optional_calls_and_origin_parsing(self):
        handle = Mock()
        handle.name = "/tmp/file.json"
        handle.__enter__ = Mock(return_value=handle)
        handle.__exit__ = Mock(return_value=False)
        with patch.object(migrate_frontend_origin.tempfile, "NamedTemporaryFile", return_value=handle), patch.object(
            migrate_frontend_origin, "aws_json", return_value={"ok": True}
        ) as aws:
            self.assertEqual(
                migrate_frontend_origin.aws_json_file(["cmd", "file://{file}"], {"x": 1}, None, "region"),
                {"ok": True},
            )
        self.assertEqual(aws.call_args.args[0][-1], "file:///tmp/file.json")

        missing = subprocess.CalledProcessError(1, ["aws"], stderr="NoSuchBucketPolicy")
        with patch.object(migrate_frontend_origin, "aws_json", side_effect=missing):
            self.assertIsNone(
                migrate_frontend_origin.optional_aws_json(["s", "o"], None, "r", ("NoSuchBucketPolicy",))
            )
        failure = subprocess.CalledProcessError(1, ["aws"], stderr="AccessDenied")
        with patch.object(migrate_frontend_origin, "aws_json", side_effect=failure), self.assertRaises(
            subprocess.CalledProcessError
        ):
            migrate_frontend_origin.optional_aws_json(["s", "o"], None, "r", ("Missing",))
        for domain, expected in (
            ("bucket.s3-website-us-west-2.amazonaws.com", "bucket"),
            ("bucket.s3.us-west-2.amazonaws.com", "bucket"),
            ("bucket.s3-us-west-2.amazonaws.com", "bucket"),
            ("bucket.s3.amazonaws.com", "bucket"),
            ("custom.example", None),
        ):
            self.assertEqual(migrate_frontend_origin.origin_bucket(domain), expected)

    def test_public_policy_detection_and_desired_policy(self):
        bucket_arn = "arn:aws:s3:::bucket"
        valid = {"Effect": "Allow", "Principal": "*", "Action": "s3:GetObject", "Resource": bucket_arn + "/*"}
        self.assertTrue(migrate_frontend_origin.public_get_statement(valid, bucket_arn))
        self.assertTrue(
            migrate_frontend_origin.public_get_statement(
                {**valid, "Principal": {"AWS": "*"}, "Action": ["s3:GetObject"], "Resource": [bucket_arn + "/x"]},
                bucket_arn,
            )
        )
        for change in (
            {"Effect": "Deny"},
            {"Principal": {"Service": "cloudfront.amazonaws.com"}},
            {"Action": "s3:ListBucket"},
            {"Resource": "arn:aws:s3:::other/*"},
        ):
            self.assertFalse(migrate_frontend_origin.public_get_statement({**valid, **change}, bucket_arn))
        desired = migrate_frontend_origin.desired_bucket_policy(
            {"Statement": [{"Sid": "Keep"}, {"Sid": migrate_frontend_origin.TLS_POLICY_SID}]},
            bucket="bucket",
            distribution_id="DIST",
            partition="aws",
        )
        self.assertEqual([item["Sid"] for item in desired["Statement"]], ["Keep", "DenyInsecureTransport", "AllowFrontendCloudFrontOacRead"])
        replaced = migrate_frontend_origin.replace_account_token(desired, "123")
        self.assertIn("123", json.dumps(replaced))

    def test_oac_crud_snapshot_wait_and_smoke(self):
        compatible = {"Name": "name", "Id": "id", "OriginAccessControlOriginType": "s3", "SigningBehavior": "always"}
        with patch.object(migrate_frontend_origin, "list_oacs", return_value=[compatible]):
            self.assertEqual(migrate_frontend_origin.ensure_oac("name", apply=False, profile=None, region="r"), ("id", "reuse"))
        with patch.object(migrate_frontend_origin, "list_oacs", return_value=[compatible, compatible]), self.assertRaises(
            RuntimeError
        ):
            migrate_frontend_origin.ensure_oac("name", apply=False, profile=None, region="r")
        with patch.object(migrate_frontend_origin, "list_oacs", return_value=[{**compatible, "SigningBehavior": "never"}]), self.assertRaises(
            RuntimeError
        ):
            migrate_frontend_origin.ensure_oac("name", apply=False, profile=None, region="r")
        with patch.object(migrate_frontend_origin, "list_oacs", return_value=[]):
            self.assertEqual(migrate_frontend_origin.ensure_oac("name", apply=False, profile=None, region="r"), (None, "create"))
        with patch.object(migrate_frontend_origin, "list_oacs", return_value=[]), patch.object(
            migrate_frontend_origin,
            "aws_json_file",
            return_value={"OriginAccessControl": {"Id": "new"}},
        ):
            self.assertEqual(migrate_frontend_origin.ensure_oac("name", apply=True, profile=None, region="r"), ("new", "created"))

        with patch.object(migrate_frontend_origin.time, "monotonic", side_effect=[0, 1]), patch.object(
            migrate_frontend_origin, "aws_json", return_value={"Distribution": {"Status": "Deployed"}}
        ):
            migrate_frontend_origin.wait_deployed("D", None, "r", 10)
        with patch.object(migrate_frontend_origin.time, "monotonic", side_effect=[0, 11]), self.assertRaises(
            TimeoutError
        ):
            migrate_frontend_origin.wait_deployed("D", None, "r", 10)

        response = Mock(status=200)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(migrate_frontend_origin.urllib.request, "urlopen", return_value=response) as open_url:
            migrate_frontend_origin.smoke_check("example.test")
        self.assertEqual(open_url.call_count, 2)
        bad = Mock(status=500)
        bad.__enter__ = Mock(return_value=bad)
        bad.__exit__ = Mock(return_value=False)
        with patch.object(migrate_frontend_origin.urllib.request, "urlopen", return_value=bad), self.assertRaises(
            RuntimeError
        ):
            migrate_frontend_origin.smoke_check("example.test")


class MigrationMainTests(unittest.TestCase):
    def setUp(self):
        self.public_statement = {
            "Sid": "PublicRead",
            "Effect": "Allow",
            "Principal": "*",
            "Action": "s3:GetObject",
            "Resource": "arn:aws:s3:::frontend/*",
        }
        self.config = {
            "Origins": {
                "Items": [
                    {
                        "Id": "origin",
                        "DomainName": "frontend.s3-website-us-west-2.amazonaws.com",
                        "CustomOriginConfig": {},
                    }
                ]
            }
        }

    def fake_aws(self, arguments, profile, region):
        if arguments[:2] == ["sts", "get-caller-identity"]:
            return {"Account": "123", "Arn": "arn:aws:iam::123:user/test"}
        if arguments[:2] == ["cloudfront", "get-distribution-config"]:
            return {"ETag": "etag", "DistributionConfig": self.config}
        if arguments[:2] == ["s3api", "get-bucket-location"]:
            return {"LocationConstraint": "us-west-2"}
        raise AssertionError(arguments)

    def optional(self, arguments, profile, region, missing):
        if arguments[:2] == ["s3api", "get-bucket-policy"]:
            return {"Policy": json.dumps({"Version": "2012-10-17", "Statement": [self.public_statement]})}
        return {"PublicAccessBlockConfiguration": {"BlockPublicAcls": False}}

    def run_main(self, *arguments, aws_json_file=None, config=None):
        if config is not None:
            self.config = config
        with patch.object(sys, "argv", [migrate_frontend_origin.__file__, "--domain", "example.test", *arguments]), patch.object(
            migrate_frontend_origin, "aws_json", side_effect=self.fake_aws
        ), patch.object(migrate_frontend_origin, "optional_aws_json", side_effect=self.optional), patch.object(
            migrate_frontend_origin, "discover_distribution_by_alias", return_value={"Id": "DIST"}
        ), patch.object(migrate_frontend_origin, "ensure_oac", side_effect=[(None, "create"), ("OAC", "created")]), patch.object(
            migrate_frontend_origin, "write_snapshot"
        ) as snapshot, patch.object(
            migrate_frontend_origin, "aws_json_file", side_effect=aws_json_file
        ) as write_aws, patch.object(migrate_frontend_origin, "wait_deployed"), patch.object(
            migrate_frontend_origin, "smoke_check"
        ), patch("sys.stdout", new_callable=io.StringIO) as output:
            result = migrate_frontend_origin.main()
        return result, output.getvalue(), snapshot, write_aws

    def test_dry_run_origin_guards_and_all_apply_guards(self):
        result, output, snapshot, write_aws = self.run_main()
        self.assertEqual(result, 0)
        self.assertIn("Dry run only", output)
        snapshot.assert_not_called()
        invalid = {"Origins": {"Items": []}}
        with self.assertRaisesRegex(SystemExit, "exactly one"):
            self.run_main(config=invalid)
        self.config = {
            "Origins": {"Items": [{"Id": "origin", "DomainName": "frontend.s3-website-us-west-2.amazonaws.com", "CustomOriginConfig": {}}]}
        }
        guard_sets = (
            ("--expected-account-id", "wrong"),
            ("--expected-account-id", "123", "--expected-etag", "wrong"),
            ("--expected-account-id", "123", "--expected-etag", "etag", "--expected-bucket", "wrong"),
            ("--expected-account-id", "123", "--expected-etag", "etag", "--expected-bucket", "frontend", "--expected-public-allow-count", "0"),
            ("--expected-account-id", "123", "--expected-etag", "etag", "--expected-bucket", "frontend", "--expected-public-allow-count", "1", "--confirm-domain", "wrong"),
            ("--expected-account-id", "123", "--expected-etag", "etag", "--expected-bucket", "frontend", "--expected-public-allow-count", "1", "--confirm-domain", "example.test"),
        )
        for guards in guard_sets:
            with self.subTest(guards=guards), self.assertRaises(SystemExit):
                self.run_main("--apply", *guards)

    def test_apply_stages_private_policy_distribution_and_access_block(self):
        result, output, snapshot, writes = self.run_main(
            "--apply",
            "--expected-account-id",
            "123",
            "--expected-etag",
            "etag",
            "--expected-bucket",
            "frontend",
            "--expected-public-allow-count",
            "1",
            "--confirm-domain",
            "example.test",
            "--rollback-file",
            "/tmp/rollback.json",
            "--wait-timeout-seconds",
            "60",
        )
        self.assertEqual(result, 0)
        snapshot.assert_called_once()
        self.assertEqual(writes.call_count, 4)
        transition = writes.call_args_list[0].args[1]
        self.assertIn("123", json.dumps(transition))
        desired_distribution = writes.call_args_list[1].args[1]
        origin = desired_distribution["Origins"]["Items"][0]
        self.assertNotIn("CustomOriginConfig", origin)
        self.assertEqual(origin["OriginAccessControlId"], "OAC")
        private = writes.call_args_list[2].args[1]
        self.assertFalse(any(item.get("Sid") == "PublicRead" for item in private["Statement"]))
        public_block = writes.call_args_list[3].args[1]
        self.assertTrue(all(public_block.values()))
        self.assertIn("completed", output)


if __name__ == "__main__":
    unittest.main()
