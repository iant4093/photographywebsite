"""Regression tests for the guarded CloudFront/WAF/API front-door rollout."""

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import re
import secrets
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops"))

import cloudfront_frontend  # noqa: E402
import front_door_preflight  # noqa: E402


BASELINE = json.loads(
    (ROOT / "ops" / "frontend_cloudfront_baseline.json").read_text(encoding="utf-8")
)
SETTINGS = BASELINE["api_front_door"]
WAF_TEMPLATE = (ROOT / "ops" / "waf_front_door_template.yaml").read_text(encoding="utf-8")


class CloudFrontFrontDoorTests(unittest.TestCase):
    def test_production_csp_allows_api_calls_only_through_same_origin(self) -> None:
        csp = cloudfront_frontend.render_csp(
            BASELINE,
            media_domain="media.example.test",
            api_id="legacy-api-id",
            region="us-west-2",
            bucket="private-media",
        )
        self.assertIn("connect-src 'self'", csp)
        self.assertNotIn("execute-api", csp)
        self.assertNotIn("legacy-api-id", csp)

    def test_frontend_and_api_policies_apply_cross_origin_and_hsts_hardening(self) -> None:
        rendered_baseline = {
            **BASELINE,
            "content_security_policy": cloudfront_frontend.render_csp(
                BASELINE,
                media_domain="media.example.test",
                api_id="legacy-api-id",
                region="us-west-2",
                bucket="private-media",
            ),
        }
        frontend = cloudfront_frontend.policy_config(
            "frontend", rendered_baseline, BASELINE["html_cache_control"]
        )
        api = cloudfront_frontend.api_response_policy_config(SETTINGS)
        for policy in (frontend, api):
            hsts = policy["SecurityHeadersConfig"]["StrictTransportSecurity"]
            self.assertTrue(hsts["IncludeSubdomains"])
            self.assertTrue(hsts["Preload"])
            self.assertIn(
                {
                    "Header": "Cross-Origin-Opener-Policy",
                    "Value": "same-origin",
                    "Override": True,
                },
                policy["CustomHeadersConfig"]["Items"],
            )

    def test_public_cache_key_and_forwarding_are_narrow_and_anonymous(self) -> None:
        cache = cloudfront_frontend.public_api_cache_policy_config(SETTINGS)
        parameters = cache["ParametersInCacheKeyAndForwardedToOrigin"]
        self.assertEqual(parameters["CookiesConfig"], {"CookieBehavior": "none"})
        self.assertEqual(parameters["HeadersConfig"], {"HeaderBehavior": "none"})
        self.assertEqual(
            parameters["QueryStringsConfig"]["QueryStrings"]["Items"],
            ["cursor", "limit", "mode", "type", "value"],
        )
        self.assertEqual(cache["MinTTL"], 0)
        self.assertEqual(cache["MaxTTL"], 300)

        public = cloudfront_frontend.api_origin_request_policy_config(SETTINGS, public=True)
        private = cloudfront_frontend.api_origin_request_policy_config(SETTINGS, public=False)
        self.assertEqual(public["CookiesConfig"], {"CookieBehavior": "none"})
        self.assertEqual(private["CookiesConfig"], {"CookieBehavior": "none"})
        public_headers = public["HeadersConfig"]["Headers"]["Items"]
        private_headers = private["HeadersConfig"]["Headers"]["Items"]
        for forbidden in ("Authorization", "Cookie", "Host", "X-Origin-Verify"):
            self.assertNotIn(forbidden, public_headers)
        self.assertIn("Authorization", private_headers)
        self.assertIn("CloudFront-Viewer-Country", private_headers)
        self.assertNotIn("CloudFront-Viewer-Country", public_headers)
        self.assertNotIn("Cookie", private_headers)
        self.assertNotIn("Host", private_headers)

    def test_api_origin_uses_tls_and_managed_nonviewer_header(self) -> None:
        runtime_value = secrets.token_urlsafe(48)
        origin = cloudfront_frontend.api_origin(SETTINGS, runtime_value)
        self.assertEqual(origin["DomainName"], "origin-api.iantruongphotography.com")
        self.assertEqual(origin["CustomOriginConfig"]["OriginProtocolPolicy"], "https-only")
        self.assertEqual(
            origin["CustomOriginConfig"]["OriginSslProtocols"]["Items"], ["TLSv1.2"]
        )
        header = origin["CustomHeaders"]["Items"][0]
        self.assertEqual(header["HeaderName"], "X-Origin-Verify")
        self.assertEqual(header["HeaderValue"], runtime_value)

    def test_api_behaviors_are_https_only_and_public_is_narrower(self) -> None:
        default = {
            "TargetOriginId": "frontend",
            "AllowedMethods": {
                "Quantity": 2,
                "Items": ["GET", "HEAD"],
                "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
            },
            "ViewerProtocolPolicy": "redirect-to-https",
            "Compress": True,
            "CachePolicyId": "frontend-cache",
            "ResponseHeadersPolicyId": "frontend-response",
            "FunctionAssociations": {"Quantity": 0},
        }
        public = cloudfront_frontend.api_cache_behavior(
            default,
            settings=SETTINGS,
            path_pattern=SETTINGS["public_path_pattern"],
            cache_policy_id="public-cache",
            origin_request_policy_id="public-origin",
            response_policy_id="api-response",
            public=True,
        )
        private = cloudfront_frontend.api_cache_behavior(
            default,
            settings=SETTINGS,
            path_pattern=SETTINGS["private_path_pattern"],
            cache_policy_id=BASELINE["cache_policies"]["html"],
            origin_request_policy_id="private-origin",
            response_policy_id="api-response",
            public=False,
        )
        self.assertEqual(public["PathPattern"], "/api/public/*")
        self.assertEqual(private["PathPattern"], "/api/*")
        self.assertEqual(public["ViewerProtocolPolicy"], "https-only")
        self.assertEqual(private["ViewerProtocolPolicy"], "https-only")
        self.assertEqual(public["AllowedMethods"]["Items"], ["GET", "HEAD", "OPTIONS"])
        self.assertIn("POST", private["AllowedMethods"]["Items"])
        self.assertEqual(private["CachePolicyId"], "4135ea2d-6df8-44a3-9df3-4b5a84be39ad")

    def test_origin_upsert_is_exact_and_rejects_id_reuse(self) -> None:
        runtime_value = secrets.token_urlsafe(48)
        config = {
            "Origins": {
                "Quantity": 1,
                "Items": [{"Id": "frontend", "DomainName": "frontend.example.test"}],
            }
        }
        cloudfront_frontend.upsert_exact_api_origin(config, SETTINGS, runtime_value)
        self.assertEqual(config["Origins"]["Quantity"], 2)
        cloudfront_frontend.upsert_exact_api_origin(config, SETTINGS, runtime_value)
        self.assertEqual(config["Origins"]["Quantity"], 2)

        conflict = {
            "Origins": {
                "Quantity": 1,
                "Items": [{"Id": SETTINGS["origin_id"], "DomainName": "other.example.test"}],
            }
        }
        with self.assertRaises(RuntimeError):
            cloudfront_frontend.upsert_exact_api_origin(conflict, SETTINGS, runtime_value)

    def test_global_spa_errors_are_removed_before_api_routing(self) -> None:
        config = {
            "CustomErrorResponses": {
                "Quantity": 2,
                "Items": [
                    {
                        "ErrorCode": 404,
                        "ResponseCode": "200",
                        "ResponsePagePath": "/index.html",
                        "ErrorCachingMinTTL": 30,
                    },
                    {"ErrorCode": 500, "ErrorCachingMinTTL": 1},
                ],
            }
        }
        cloudfront_frontend.remove_legacy_spa_error_responses(config)
        self.assertEqual(
            config["CustomErrorResponses"],
            {"Quantity": 1, "Items": [{"ErrorCode": 500, "ErrorCachingMinTTL": 1}]},
        )

    def test_apply_requires_all_exact_guards_and_confirmation(self) -> None:
        common = {
            "apply": True,
            "confirmation": cloudfront_frontend.FRONT_DOOR_CONFIRMATION,
            "expected_frontend_origin_id": "frontend",
            "frontend_origin_id": "frontend",
            "expected_frontend_origin_domain": "frontend.example.test",
            "frontend_origin_domain": "frontend.example.test",
            "expected_api_domain": SETTINGS["origin_domain"],
            "api_domain": SETTINGS["origin_domain"],
            "expected_certificate_arn": "certificate",
            "certificate_arn": "certificate",
            "expected_parameter_name": "/ian-website/prod/front-door-config",
            "parameter_name": "/ian-website/prod/front-door-config",
            "expected_web_acl_arn": "waf",
            "web_acl_arn": "waf",
        }
        cloudfront_frontend.validate_front_door_apply_guards(**common)
        with self.assertRaises(SystemExit):
            cloudfront_frontend.validate_front_door_apply_guards(
                **{**common, "expected_api_domain": "wrong.example.test"}
            )
        with self.assertRaises(SystemExit):
            cloudfront_frontend.validate_front_door_apply_guards(
                **{**common, "confirmation": "wrong"}
            )
        cloudfront_frontend.validate_front_door_apply_guards(
            **{key: value for key, value in common.items() if key != "apply"}, apply=False
        )

    def test_resource_validation_reads_only_metadata_and_requires_exact_block_contract(self) -> None:
        account = "000000000000"
        certificate_arn = f"arn:aws:acm:us-west-2:{account}:certificate/certificate-id"
        parameter_name = "/ian-website/prod/front-door-config"
        web_acl_arn = f"arn:aws:wafv2:us-east-1:{account}:global/webacl/front-door/web-acl-id"
        responses = [
            {
                "Certificate": {
                    "Status": "ISSUED",
                    "DomainName": SETTINGS["origin_domain"],
                    "SubjectAlternativeNames": [SETTINGS["origin_domain"]],
                }
            },
            {"Parameters": [{"Name": parameter_name, "Type": "SecureString"}]},
            {
                "WebACL": {
                    "ARN": web_acl_arn,
                    "DefaultAction": {"Allow": {}},
                    "Rules": [
                        {
                            "Name": "ExplorePerIpRateLimit",
                            "Action": {"Block": {}},
                            "Statement": {
                                "RateBasedStatement": {
                                    "Limit": 30,
                                    "EvaluationWindowSec": 300,
                                    "AggregateKeyType": "IP",
                                    "ScopeDownStatement": {
                                        "ByteMatchStatement": {
                                            "SearchString": "/api/public/explore",
                                            "FieldToMatch": {"UriPath": {}},
                                            "PositionalConstraint": "EXACTLY",
                                        }
                                    },
                                }
                            },
                        },
                        {
                            "Name": "ExploreGlobalCircuitBreaker",
                            "Action": {"Block": {}},
                            "Statement": {
                                "RateBasedStatement": {
                                    "Limit": 120,
                                    "EvaluationWindowSec": 300,
                                    "AggregateKeyType": "CONSTANT",
                                    "ScopeDownStatement": {
                                        "ByteMatchStatement": {
                                            "SearchString": "/api/public/explore",
                                            "FieldToMatch": {"UriPath": {}},
                                            "PositionalConstraint": "EXACTLY",
                                        }
                                    },
                                }
                            },
                        },
                        {
                            "Name": "ApiPerIpRateLimit",
                            "Action": {"Block": {}},
                            "Statement": {
                                "RateBasedStatement": {
                                    "Limit": 1200,
                                    "EvaluationWindowSec": 300,
                                    "AggregateKeyType": "IP",
                                    "ScopeDownStatement": {
                                        "ByteMatchStatement": {
                                            "SearchString": "/api/",
                                            "FieldToMatch": {"UriPath": {}},
                                            "PositionalConstraint": "STARTS_WITH",
                                        }
                                    },
                                }
                            },
                        },
                        {
                            "Name": "ApiGlobalCircuitBreaker",
                            "Action": {"Block": {}},
                            "Statement": {
                                "RateBasedStatement": {
                                    "Limit": 3000,
                                    "EvaluationWindowSec": 300,
                                    "AggregateKeyType": "CONSTANT",
                                    "ScopeDownStatement": {
                                        "ByteMatchStatement": {
                                            "SearchString": "/api/",
                                            "FieldToMatch": {"UriPath": {}},
                                            "PositionalConstraint": "STARTS_WITH",
                                        }
                                    },
                                }
                            },
                        },
                        {"Name": "AWSManagedKnownBadInputs", "OverrideAction": {"None": {}}},
                        {"Name": "AWSManagedAmazonIpReputation", "OverrideAction": {"None": {}}},
                    ],
                }
            },
            {
                "DomainName": SETTINGS["origin_domain"],
                "DomainNameConfigurations": [
                    {
                        "CertificateArn": certificate_arn,
                        "EndpointType": "REGIONAL",
                        "SecurityPolicy": "TLS_1_2",
                    }
                ],
            },
        ]
        calls = []

        def fake_aws(arguments, *, profile=None):
            calls.append(arguments)
            return responses.pop(0)

        with patch.object(cloudfront_frontend, "aws_json", side_effect=fake_aws):
            cloudfront_frontend.validate_front_door_resources(
                domain=SETTINGS["origin_domain"],
                certificate_arn=certificate_arn,
                parameter_name=parameter_name,
                web_acl_arn=web_acl_arn,
                account=account,
                region="us-west-2",
                profile=None,
            )
        serialized_calls = json.dumps(calls)
        self.assertIn("describe-parameters", serialized_calls)
        self.assertNotIn("get-parameter", serialized_calls)

    def test_waf_search_string_guard_accepts_cli_blob_encoding_only_for_exact_path(self) -> None:
        self.assertTrue(cloudfront_frontend.waf_search_string_matches("L2FwaS8=", "/api/"))
        self.assertTrue(cloudfront_frontend.waf_search_string_matches("/api/", "/api/"))
        self.assertFalse(cloudfront_frontend.waf_search_string_matches("L2FwaS9vdGhlci8=", "/api/"))
        self.assertFalse(cloudfront_frontend.waf_search_string_matches("not base64!", "/api/"))
        self.assertFalse(cloudfront_frontend.waf_search_string_matches(None, "/api/"))
        self.assertFalse(cloudfront_frontend.waf_search_string_matches("/w==", "/api/"))

    def test_secret_value_loader_never_prints_the_value(self) -> None:
        runtime_value = secrets.token_urlsafe(48)
        output = io.StringIO()
        with patch.object(
            cloudfront_frontend,
            "aws_json",
            return_value={
                "Parameter": {"Value": json.dumps({"current": runtime_value, "previous": ""})}
            },
        ), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            loaded = cloudfront_frontend.load_origin_verification_value(
                "/ian-website/prod/front-door-config",
                region="us-west-2",
                profile=None,
            )
        self.assertEqual(loaded, runtime_value)
        self.assertNotIn(runtime_value, output.getvalue())


class WafAndPreflightTests(unittest.TestCase):
    def test_waf_is_retained_selectively_blocking_and_privacy_safe(self) -> None:
        self.assertIn("Scope: CLOUDFRONT", WAF_TEMPLATE)
        self.assertIn("DefaultAction:\n        Allow: {}", WAF_TEMPLATE)
        self.assertEqual(WAF_TEMPLATE.count("SampledRequestsEnabled: false"), 7)
        self.assertEqual(WAF_TEMPLATE.count("Count: {}"), 0)
        self.assertEqual(WAF_TEMPLATE.count("None: {}"), 2)
        for rate_rule, aggregate_key, limit_parameter in (
            ("ExplorePerIpRateLimit", "IP", "ExplorePerIpRequestLimit"),
            ("ExploreGlobalCircuitBreaker", "CONSTANT", "ExploreGlobalRequestLimit"),
            ("ApiPerIpRateLimit", "IP", "ApiPerIpRequestLimit"),
            ("ApiGlobalCircuitBreaker", "CONSTANT", "ApiGlobalRequestLimit"),
        ):
            self.assertIn(rate_rule, WAF_TEMPLATE)
            self.assertIn(f"AggregateKeyType: {aggregate_key}", WAF_TEMPLATE)
            self.assertIn(f"Limit: !Ref {limit_parameter}", WAF_TEMPLATE)
        self.assertEqual(WAF_TEMPLATE.count("EvaluationWindowSec: 300"), 4)
        self.assertEqual(len(re.findall(r"(?m)^\s+SearchString: /api/$", WAF_TEMPLATE)), 2)
        self.assertEqual(
            len(re.findall(r"(?m)^\s+SearchString: /api/public/explore$", WAF_TEMPLATE)),
            2,
        )
        self.assertEqual(WAF_TEMPLATE.count("PositionalConstraint: STARTS_WITH"), 2)
        self.assertEqual(WAF_TEMPLATE.count("PositionalConstraint: EXACTLY"), 2)
        for managed_group in (
            "AWSManagedRulesKnownBadInputsRuleSet",
            "AWSManagedRulesAmazonIpReputationList",
        ):
            self.assertIn(managed_group, WAF_TEMPLATE)
        for redacted in ("authorization", "cookie", "x-origin-verify", "QueryString"):
            self.assertIn(redacted, WAF_TEMPLATE)
        self.assertIn("DefaultBehavior: DROP", WAF_TEMPLATE)
        self.assertIn("Action: BLOCK", WAF_TEMPLATE)
        self.assertIn("DeletionPolicy: Retain", WAF_TEMPLATE)
        self.assertIn("WafAlarmCrossRegionRule", WAF_TEMPLATE)
        self.assertIn("events:PutEvents", WAF_TEMPLATE)
        self.assertNotIn("AlarmTopicArn", WAF_TEMPLATE)
        self.assertNotIn("AlarmActions:", WAF_TEMPLATE)
        blocked_alarm = WAF_TEMPLATE.split("  WafBlockedRequestAlarm:", 1)[1].split(
            "  WafAlarmForwardRole:", 1
        )[0]
        forward_rule = WAF_TEMPLATE.split("  WafAlarmCrossRegionRule:", 1)[1]
        self.assertIn("EvaluationPeriods: 3", blocked_alarm)
        self.assertIn("DatapointsToAlarm: 2", blocked_alarm)
        self.assertIn("Threshold: 25", blocked_alarm)
        self.assertIn("ian-photography-waf-blocked-${Stage}", forward_rule)
        self.assertNotIn("ian-photography-waf-rate-${Stage}", forward_rule)

    def test_preflight_never_reads_or_returns_secret_value(self) -> None:
        account = "000000000000"
        certificate_arn = f"arn:aws:acm:us-west-2:{account}:certificate/certificate-id"
        parameter_name = "/ian-website/prod/front-door-config"
        web_acl_arn = f"arn:aws:wafv2:us-east-1:{account}:global/webacl/front-door/web-acl-id"
        runtime_value = secrets.token_urlsafe(48)
        calls = []

        def fake_aws(arguments, profile=None, region=None):
            calls.append(arguments)
            service, operation = arguments[:2]
            if (service, operation) == ("sts", "get-caller-identity"):
                return {"Account": account}
            if (service, operation) == ("cloudfront", "get-distribution"):
                return {
                    "Distribution": {
                        "Status": "Deployed",
                        "DistributionConfig": {
                            "WebACLId": web_acl_arn,
                            "Origins": {
                                "Items": [
                                    {
                                        "DomainName": SETTINGS["origin_domain"],
                                        "CustomHeaders": {
                                            "Items": [
                                                {
                                                    "HeaderName": "X-Origin-Verify",
                                                    "HeaderValue": runtime_value,
                                                }
                                            ]
                                        },
                                    }
                                ]
                            },
                            "CacheBehaviors": {
                                "Items": [
                                    {"PathPattern": "/api/public/*"},
                                    {"PathPattern": "/api/*"},
                                ]
                            },
                        },
                    }
                }
            if (service, operation) == ("apigatewayv2", "get-api"):
                return {"DisableExecuteApiEndpoint": True}
            if (service, operation) == ("apigatewayv2", "get-api-mappings"):
                return {"Items": [{"ApiId": "api-id", "ApiMappingKey": "api"}]}
            if (service, operation) == ("ssm", "describe-parameters"):
                return {"Parameters": [{"Name": parameter_name, "Type": "SecureString"}]}
            if (service, operation) == ("cloudformation", "describe-stacks"):
                return {
                    "Stacks": [
                        {
                            "Parameters": [
                                {
                                    "ParameterKey": "FrontDoorEnforcementEnabled",
                                    "ParameterValue": "true",
                                }
                            ],
                            "Outputs": [
                                {
                                    "OutputKey": "FrontDoorConfigParameterName",
                                    "OutputValue": parameter_name,
                                }
                            ],
                        }
                    ]
                }
            raise AssertionError(arguments)

        resources = {
            "Api": "api-id",
            "ApiFrontDoorCertificate": certificate_arn,
        }
        arguments = type(
            "Args",
            (),
            {
                "expected_account_id": account,
                "profile": None,
                "region": "us-west-2",
                "canonical_domain": "iantruongphotography.com",
                "api_origin_domain": SETTINGS["origin_domain"],
                "expected_web_acl_arn": web_acl_arn,
                "stack_name": "stack",
                "expected_certificate_arn": certificate_arn,
                "expected_parameter_name": parameter_name,
            },
        )()
        with patch.object(front_door_preflight, "aws_json", side_effect=fake_aws), patch.object(
            front_door_preflight,
            "discover_distribution_by_alias",
            return_value={"Id": "distribution-id"},
        ), patch.object(
            front_door_preflight,
            "stack_resource",
            side_effect=lambda stack, logical, profile, region: resources[logical],
        ):
            report = front_door_preflight.inspect(arguments)
        self.assertTrue(report["originHeaderPresent"])
        self.assertFalse(report["originParameterValueRead"])
        self.assertNotIn(runtime_value, json.dumps(report))
        self.assertNotIn("get-parameter", json.dumps(calls))

    def test_validation_entrypoints_include_waf_template(self) -> None:
        for path in (
            ROOT / "ops" / "validate_infrastructure.sh",
            ROOT / ".github" / "workflows" / "_quality.yml",
        ):
            with self.subTest(path=path.name):
                self.assertIn("ops/waf_front_door_template.yaml", path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
