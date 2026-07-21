import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
if str(OPS) not in sys.path:
    sys.path.insert(0, str(OPS))

import aws_stack
import check_album_indexes
import dns_hardening
import enable_inspector_lambda_scanning as inspector
import invalidate_media_cache
import security_preflight
import set_lambda_log_retention
from ops.ci import coverage_gate


class MainMixin:
    def run_main(self, module, *arguments):
        with patch.object(sys, "argv", [module.__file__, *arguments]), patch(
            "sys.stdout", new_callable=io.StringIO
        ) as output:
            result = module.main()
        return result, output.getvalue()


class AwsStackTests(unittest.TestCase):
    def test_aws_json_builds_profile_region_and_parses_empty(self):
        completed = Mock(stdout='{"ok":true}')
        with patch.object(aws_stack.subprocess, "run", return_value=completed) as run:
            self.assertEqual(
                aws_stack.aws_json(["service", "operation"], "profile", "us-west-2"),
                {"ok": True},
            )
        self.assertEqual(
            run.call_args.args[0],
            [
                "aws",
                "--profile",
                "profile",
                "--region",
                "us-west-2",
                "service",
                "operation",
                "--output",
                "json",
            ],
        )
        with patch.object(aws_stack.subprocess, "run", return_value=Mock(stdout="")):
            self.assertEqual(aws_stack.aws_json(["s", "o"]), {})

    def test_stack_resource_validates_exact_physical_id(self):
        with patch.object(
            aws_stack,
            "aws_json",
            return_value={"StackResourceDetail": {"PhysicalResourceId": "physical"}},
        ) as call:
            self.assertEqual(aws_stack.stack_resource("stack", "Logical", None, "region"), "physical")
        self.assertIn("describe-stack-resource", call.call_args.args[0])
        for value in (None, "", 7):
            with self.subTest(value=value), patch.object(
                aws_stack,
                "aws_json",
                return_value={"StackResourceDetail": {"PhysicalResourceId": value}},
            ), self.assertRaises(RuntimeError):
                aws_stack.stack_resource("stack", "Logical", None, None)

    def test_distribution_discovery_paginates_and_rejects_incomplete_or_ambiguous(self):
        pages = [
            {
                "DistributionList": {
                    "Items": [{"Id": "other", "Aliases": {"Items": ["other.test"]}}],
                    "IsTruncated": True,
                    "NextMarker": "next",
                }
            },
            {
                "DistributionList": {
                    "Items": [{"Id": "match", "Aliases": {"Items": ["example.test"]}}],
                    "IsTruncated": False,
                }
            },
        ]
        with patch.object(aws_stack, "aws_json", side_effect=pages) as call:
            self.assertEqual(
                aws_stack.discover_distribution_by_alias("example.test", "profile", "region")["Id"],
                "match",
            )
        self.assertIn("--marker", call.call_args_list[1].args[0])
        for response in (
            {"DistributionList": {"IsTruncated": True}},
            {"DistributionList": {"Items": []}},
            {
                "DistributionList": {
                    "Items": [
                        {"Aliases": {"Items": ["example.test"]}},
                        {"Aliases": {"Items": ["example.test"]}},
                    ]
                }
            },
        ):
            with self.subTest(response=response), patch.object(
                aws_stack, "aws_json", return_value=response
            ), self.assertRaises(RuntimeError):
                aws_stack.discover_distribution_by_alias("example.test", None)

    def test_hosted_zone_discovery_requires_one_public_exact_match(self):
        response = {
            "HostedZones": [
                {"Name": "example.test.", "Id": "/hostedzone/Z1", "Config": {"PrivateZone": False}},
                {"Name": "example.test.", "Id": "/hostedzone/private", "Config": {"PrivateZone": True}},
                {"Name": "other.test.", "Id": "/hostedzone/other"},
            ]
        }
        with patch.object(aws_stack, "aws_json", return_value=response):
            self.assertEqual(aws_stack.discover_public_hosted_zone("example.test", None), "Z1")
        with patch.object(aws_stack, "aws_json", return_value={"HostedZones": []}), self.assertRaises(
            RuntimeError
        ):
            aws_stack.discover_public_hosted_zone("example.test", None)


class IndexAndRetentionTests(MainMixin, unittest.TestCase):
    def index(self, name, hash_name, range_name=None, *, status="ACTIVE", backfilling=False):
        schema = [{"KeyType": "HASH", "AttributeName": hash_name}]
        if range_name:
            schema.append({"KeyType": "RANGE", "AttributeName": range_name})
        return {
            "IndexName": name,
            "KeySchema": schema,
            "IndexStatus": status,
            "Backfilling": backfilling,
        }

    def test_key_names_and_every_suggested_phase(self):
        self.assertEqual(check_album_indexes.key_names({}), (None, None))
        phase_cases = (
            ([], "none", 0),
            ([self.index("VisibilityCreatedAtIndex", "visibility", "createdAt")], "visibility", 0),
            ([self.index("VisibilityCreatedAtSummaryIndex", "visibility", "createdAt")], "summary", 0),
            ([self.index("OwnerSubCreatedAtIndex", "ownerSub", "createdAt")], "both", 0),
            ([self.index("OwnerSubCreatedAtIndex", "wrong", "createdAt")], "none", 1),
        )
        for indexes, expected_phase, exit_code in phase_cases:
            with self.subTest(phase=expected_phase), patch.object(
                check_album_indexes, "stack_resource", return_value="table"
            ), patch.object(
                check_album_indexes,
                "aws_json",
                side_effect=[{"Account": "123"}, {"Table": {"TableStatus": "ACTIVE", "GlobalSecondaryIndexes": indexes}}],
            ):
                result, output = self.run_main(check_album_indexes, "--stack-name", "stack")
            self.assertEqual(result, exit_code)
            self.assertEqual(json.loads(output)["suggestedTemplatePhase"], expected_phase)

    def retention_aws(self, arguments, profile, region):
        if arguments[:2] == ["sts", "get-caller-identity"]:
            return {"Account": "123"}
        if arguments[:2] == ["cloudformation", "list-stack-resources"]:
            return {
                "StackResourceSummaries": [
                    {"ResourceType": "AWS::Lambda::Function", "PhysicalResourceId": "b"},
                    {"ResourceType": "AWS::Lambda::Function", "PhysicalResourceId": "a"},
                    {"ResourceType": "AWS::S3::Bucket", "PhysicalResourceId": "ignored"},
                    {"ResourceType": "AWS::Lambda::Function"},
                ]
            }
        if arguments[:2] == ["logs", "describe-log-groups"]:
            name = arguments[-1]
            if name.endswith("a"):
                return {"logGroups": [{"logGroupName": name, "retentionInDays": 7}]}
            return {"logGroups": []}
        if arguments[:2] == ["logs", "put-retention-policy"]:
            return {}
        raise AssertionError(arguments)

    def test_log_retention_dry_run_guards_and_apply(self):
        with patch.object(set_lambda_log_retention, "aws_json", side_effect=self.retention_aws):
            result, output = self.run_main(
                set_lambda_log_retention, "--stack-name", "stack", "--days", "30"
            )
        self.assertEqual(result, 0)
        report = json.loads(output)
        self.assertEqual(report["existingLogGroupCount"], 1)
        self.assertEqual(report["missingLogGroupCount"], 1)

        with patch.object(set_lambda_log_retention, "aws_json", side_effect=self.retention_aws):
            with self.assertRaises(SystemExit):
                self.run_main(set_lambda_log_retention, "--stack-name", "stack", "--days", "2")
        for args in (
            ("--expected-account-id", "wrong", "--confirm-stack-name", "stack"),
            ("--expected-account-id", "123", "--confirm-stack-name", "wrong"),
        ):
            with self.subTest(args=args), patch.object(
                set_lambda_log_retention, "aws_json", side_effect=self.retention_aws
            ), self.assertRaises(SystemExit):
                self.run_main(
                    set_lambda_log_retention,
                    "--stack-name",
                    "stack",
                    "--days",
                    "30",
                    "--apply",
                    *args,
                )
        calls = []

        def recording(arguments, profile, region):
            calls.append(arguments)
            return self.retention_aws(arguments, profile, region)

        with patch.object(set_lambda_log_retention, "aws_json", side_effect=recording):
            result, output = self.run_main(
                set_lambda_log_retention,
                "--stack-name",
                "stack",
                "--days",
                "30",
                "--apply",
                "--expected-account-id",
                "123",
                "--confirm-stack-name",
                "stack",
            )
        self.assertEqual(result, 0)
        self.assertEqual(sum(call[:2] == ["logs", "put-retention-policy"] for call in calls), 1)

class InvalidationTests(MainMixin, unittest.TestCase):
    def fake_aws(self, arguments, profile, region):
        if arguments[:2] == ["sts", "get-caller-identity"]:
            return {"Account": "123"}
        if arguments[:2] == ["cloudfront", "get-distribution"]:
            return {"Distribution": {"DomainName": "media.example"}}
        if arguments[:2] == ["cloudfront", "create-invalidation"]:
            return {"Invalidation": {"Id": "INV", "Status": "InProgress"}}
        raise AssertionError(arguments)

    def test_dry_run_apply_guards_and_exact_invalidation(self):
        with patch.object(invalidate_media_cache, "stack_resource", return_value="DIST"), patch.object(
            invalidate_media_cache, "aws_json", side_effect=self.fake_aws
        ):
            result, output = self.run_main(invalidate_media_cache, "--stack-name", "stack")
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(output)["paths"], ["/*"])
        guard_values = (("wrong", "DIST"), ("123", "wrong"))
        for account, distribution in guard_values:
            with self.subTest(account=account), patch.object(
                invalidate_media_cache, "stack_resource", return_value="DIST"
            ), patch.object(invalidate_media_cache, "aws_json", side_effect=self.fake_aws), self.assertRaises(
                SystemExit
            ):
                self.run_main(
                    invalidate_media_cache,
                    "--stack-name",
                    "stack",
                    "--apply",
                    "--expected-account-id",
                    account,
                    "--confirm-distribution-id",
                    distribution,
                )
        calls = []

        def recording(arguments, profile, region):
            calls.append(arguments)
            return self.fake_aws(arguments, profile, region)

        with patch.object(invalidate_media_cache, "stack_resource", return_value="DIST"), patch.object(
            invalidate_media_cache, "aws_json", side_effect=recording
        ):
            result, output = self.run_main(
                invalidate_media_cache,
                "--stack-name",
                "stack",
                "--apply",
                "--expected-account-id",
                "123",
                "--confirm-distribution-id",
                "DIST",
            )
        self.assertEqual(result, 0)
        create = next(call for call in calls if call[:2] == ["cloudfront", "create-invalidation"])
        batch = json.loads(create[-1])
        self.assertEqual(batch["Paths"], {"Quantity": 1, "Items": ["/*"]})


class DnsHardeningTests(MainMixin, unittest.TestCase):
    def distribution(self, *, www=True, redirect=True, deployed=True):
        function_items = (
            [{"EventType": "viewer-request", "FunctionARN": "arn:function/example-test-www-redirect-v1"}]
            if redirect
            else []
        )
        return {
            "DomainName": "distribution.cloudfront.net",
            "Status": "Deployed" if deployed else "InProgress",
            "DistributionConfig": {
                "Aliases": {"Items": ["www.example.test"] if www else []},
                "DefaultCacheBehavior": {"FunctionAssociations": {"Items": function_items}},
                "CacheBehaviors": {"Items": []},
            },
        }

    def fake_aws(self, arguments, profile, *, distribution=None, private=False, apex=True, zone_id="CFZONE"):
        if arguments[:2] == ["route53", "get-hosted-zone"]:
            return {"HostedZone": {"Name": "example.test.", "Config": {"PrivateZone": private}}}
        if arguments[:2] == ["cloudfront", "get-distribution"]:
            return {"Distribution": distribution or self.distribution()}
        if arguments[:2] == ["route53", "list-resource-record-sets"]:
            records = []
            if apex:
                records = [
                    {
                        "Name": "example.test.",
                        "Type": "A",
                        "AliasTarget": {
                            "DNSName": "distribution.cloudfront.net.",
                            "HostedZoneId": zone_id,
                        },
                    }
                ]
            return {"ResourceRecordSets": records}
        if arguments[:2] == ["sts", "get-caller-identity"]:
            return {"Account": "123"}
        if arguments[:2] == ["route53", "change-resource-record-sets"]:
            return {"ChangeInfo": {"Id": "change", "Status": "PENDING"}}
        raise AssertionError(arguments)

    def run_dns(self, *arguments, distribution=None, private=False, apex=True, zone_id="CFZONE"):
        side_effect = lambda args, profile: self.fake_aws(
            args,
            profile,
            distribution=distribution,
            private=private,
            apex=apex,
            zone_id=zone_id,
        )
        with patch.object(dns_hardening, "discover_public_hosted_zone", return_value="ZONE"), patch.object(
            dns_hardening, "discover_distribution_by_alias", return_value={"Id": "DIST"}
        ), patch.object(dns_hardening, "aws_json", side_effect=side_effect):
            return self.run_main(dns_hardening, "--domain", "example.test", *arguments)

    def test_aws_json_wrapper_and_dry_run_plan(self):
        with patch.object(
            dns_hardening.subprocess,
            "run",
            return_value=Mock(stdout='{"ok":true}'),
        ) as run:
            self.assertEqual(dns_hardening.aws_json(["sts", "x"], "profile"), {"ok": True})
        self.assertIn("--profile", run.call_args.args[0])
        result, output = self.run_dns("--caa-provider", "letsencrypt.org", "--caa-provider", "amazon.com")
        self.assertEqual(result, 0)
        report = json.loads(output.split("\nDry run", 1)[0])
        self.assertTrue(report["canonicalRedirectReady"])
        self.assertEqual(report["caaProviders"], ["amazon.com", "letsencrypt.org"])

    def test_preflight_guards_fail_closed(self):
        cases = (
            ({"private": True}, "hosted-zone"),
            ({"apex": False}, "apex DNS"),
            ({"zone_id": ""}, "hosted-zone ID"),
        )
        for options, message in cases:
            with self.subTest(options=options), self.assertRaisesRegex(SystemExit, message):
                self.run_dns(**options)
        wrong = self.distribution()
        wrong["DomainName"] = "wrong.cloudfront.net"
        with self.assertRaisesRegex(SystemExit, "apex DNS"):
            self.run_dns(distribution=wrong)

    def test_apply_requires_all_exact_guards_and_writes_temp_batch(self):
        arg_cases = (
            ("--expected-account-id", "wrong", "--confirm-domain", "example.test"),
            ("--expected-account-id", "123", "--confirm-domain", "wrong"),
        )
        for arguments in arg_cases:
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit):
                self.run_dns("--apply", *arguments)
        with self.assertRaisesRegex(SystemExit, "alternate domain"):
            self.run_dns(
                "--apply",
                "--expected-account-id",
                "123",
                "--confirm-domain",
                "example.test",
                distribution=self.distribution(www=False),
            )
        for distribution in (self.distribution(redirect=False), self.distribution(deployed=False)):
            with self.subTest(status=distribution["Status"]), self.assertRaisesRegex(SystemExit, "canonical redirect"):
                self.run_dns(
                    "--apply",
                    "--expected-account-id",
                    "123",
                    "--confirm-domain",
                    "example.test",
                    distribution=distribution,
                )

        handle = Mock(name="temp-handle")
        handle.name = "/tmp/change.json"
        handle.__enter__ = Mock(return_value=handle)
        handle.__exit__ = Mock(return_value=False)
        with patch.object(dns_hardening.tempfile, "NamedTemporaryFile", return_value=handle), patch.object(
            dns_hardening.json, "dump"
        ) as dump:
            result, output = self.run_dns(
                "--apply",
                "--expected-account-id",
                "123",
                "--confirm-domain",
                "example.test",
            )
        self.assertEqual(result, 0)
        dump.assert_called_once()
        handle.flush.assert_called_once()
        self.assertIn('"changeId": "change"', output)


class InspectorAndPreflightTests(MainMixin, unittest.TestCase):
    def test_inspector_status_validation(self):
        with patch.object(
            inspector,
            "aws_json",
            return_value={
                "accounts": [{"accountId": "123", "resourceState": {"lambda": {"status": "enabled"}}}],
                "failedAccounts": [],
            },
        ):
            status = inspector.get_account_status("123", None, "region")
        self.assertEqual(inspector.resource_status(status, "lambda"), "ENABLED")
        self.assertEqual(inspector.resource_status({}, "lambda"), "UNKNOWN")
        self.assertEqual(
            inspector.resource_status({"resourceState": {"lambda": {"status": ""}}}, "lambda"),
            "UNKNOWN",
        )
        for response in (
            {"failedAccounts": [{}], "accounts": []},
            {"failedAccounts": [], "accounts": []},
            {"failedAccounts": [], "accounts": [{"accountId": "other"}]},
        ):
            with self.subTest(response=response), patch.object(inspector, "aws_json", return_value=response), self.assertRaises(
                RuntimeError
            ):
                inspector.get_account_status("123", None, "region")

    def test_inspector_every_apply_guard_and_failed_postcondition(self):
        guards = {
            "apply": True,
            "account_id": "123456789012",
            "region": "us-west-2",
            "expected_account_id": "123456789012",
            "expected_region": "us-west-2",
            "current_lambda_state": "DISABLED",
            "current_lambda_code_state": "DISABLED",
            "expected_lambda_state": "DISABLED",
            "expected_lambda_code_state": "DISABLED",
            "confirmation": inspector.CONFIRMATION,
        }
        inspector.validate_apply_guards(**guards)
        inspector.validate_apply_guards(**{**guards, "apply": False, "expected_account_id": None})
        variants = (
            {"expected_account_id": "wrong"},
            {"expected_region": "us-east-1"},
            {"current_lambda_state": "ENABLED"},
            {"current_lambda_code_state": "ENABLED"},
            {"confirmation": "wrong"},
        )
        for changes in variants:
            with self.subTest(changes=changes), self.assertRaises(SystemExit):
                inspector.validate_apply_guards(**{**guards, **changes})

        status_calls = 0

        def rejected(arguments, profile, region):
            nonlocal status_calls
            if arguments[:2] == ["sts", "get-caller-identity"]:
                return {"Account": "123456789012"}
            if arguments[:2] == ["inspector2", "enable"]:
                return {}
            status_calls += 1
            state = "DISABLED" if status_calls == 1 else "FAILED"
            return {
                "accounts": [{
                    "accountId": "123456789012",
                    "resourceState": {
                        "lambda": {"status": state},
                        "lambdaCode": {"status": state},
                    },
                }],
                "failedAccounts": [],
            }

        with patch.object(inspector, "aws_json", side_effect=rejected), self.assertRaisesRegex(
            RuntimeError, "unexpected state"
        ):
            self.run_main(
                inspector,
                "--region", "us-west-2",
                "--apply",
                "--expected-account-id", "123456789012",
                "--expected-region", "us-west-2",
                "--expected-lambda-state", "DISABLED",
                "--expected-lambda-code-state", "DISABLED",
                "--confirm", inspector.CONFIRMATION,
            )

    def test_inspector_main_dry_run_invalid_and_apply(self):
        statuses = [
            {
                "accounts": [
                    {
                        "accountId": "123456789012",
                        "resourceState": {
                            "lambda": {"status": "DISABLED"},
                            "lambdaCode": {"status": "DISABLED"},
                        },
                    }
                ],
                "failedAccounts": [],
            }
        ]

        def dry(arguments, profile, region):
            if arguments[:2] == ["sts", "get-caller-identity"]:
                return {"Account": "123456789012"}
            return statuses[0]

        with patch.object(inspector, "aws_json", side_effect=dry):
            result, output = self.run_main(inspector, "--region", "us-west-2")
        self.assertEqual(result, 0)
        self.assertTrue(json.loads(output)["readyForGuardedApply"])
        with patch.object(sys, "argv", [inspector.__file__, "--region", "invalid"]), self.assertRaises(SystemExit):
            inspector.main()
        with patch.object(inspector, "aws_json", return_value={"Account": "bad"}), self.assertRaises(RuntimeError):
            self.run_main(inspector)

        calls = []
        account_status_calls = 0

        def apply(arguments, profile, region):
            nonlocal account_status_calls
            calls.append(arguments)
            if arguments[:2] == ["sts", "get-caller-identity"]:
                return {"Account": "123456789012"}
            if arguments[:2] == ["inspector2", "enable"]:
                return {}
            account_status_calls += 1
            state = "DISABLED" if account_status_calls == 1 else "ENABLED"
            return {
                "accounts": [
                    {
                        "accountId": "123456789012",
                        "resourceState": {
                            "lambda": {"status": state},
                            "lambdaCode": {"status": state},
                        },
                    }
                ],
                "failedAccounts": [],
            }

        with patch.object(inspector, "aws_json", side_effect=apply):
            result, output = self.run_main(
                inspector,
                "--region",
                "us-west-2",
                "--apply",
                "--expected-account-id",
                "123456789012",
                "--expected-region",
                "us-west-2",
                "--expected-lambda-state",
                "DISABLED",
                "--expected-lambda-code-state",
                "DISABLED",
                "--confirm",
                inspector.CONFIRMATION,
            )
        self.assertEqual(result, 0)
        self.assertTrue(any(call[:2] == ["inspector2", "enable"] for call in calls))
        self.assertIn('"result": "enabled"', output)

        for arguments in (
            ("--wait-timeout-seconds", "29"),
            ("--wait-timeout-seconds", "901"),
            ("--poll-interval-seconds", "0"),
            ("--poll-interval-seconds", "31"),
            ("--wait-timeout-seconds", "30", "--poll-interval-seconds", "30"),
        ):
            with self.subTest(arguments=arguments), patch.object(
                sys, "argv", [inspector.__file__, *arguments]
            ), self.assertRaises(SystemExit):
                inspector.main()

    def test_preflight_aws_call_errors_names_and_main(self):
        completed = Mock(returncode=0, stdout='{"ok":true}', stderr="")
        with patch.object(security_preflight.subprocess, "run", return_value=completed) as run:
            self.assertEqual(security_preflight.aws_call(["s", "o"], "p", "r"), {"ok": True})
        self.assertIn("--profile", run.call_args.args[0])
        for completed in (
            Mock(returncode=1, stderr="Access denied secret detail", stdout=""),
            Mock(returncode=0, stderr="", stdout="[]"),
            Mock(returncode=0, stderr="", stdout="not-json"),
        ):
            with self.subTest(stdout=completed.stdout), patch.object(
                security_preflight.subprocess, "run", return_value=completed
            ), self.assertRaises(security_preflight.AwsCallError):
                security_preflight.aws_call(["s", "o"], None, "r")
        self.assertEqual(
            security_preflight._names([{"name": "b"}, {"name": "a"}, {"name": 1}], "name", True),
            ["a", "b"],
        )
        self.assertEqual(security_preflight._names([{"name": "a"}], "name", False), [])
        with patch.object(sys, "argv", [security_preflight.__file__, "--stage", "BAD"]), self.assertRaises(
            SystemExit
        ):
            security_preflight.main()
        with patch.object(
            security_preflight, "inventory", return_value=({"ok": True}, True)
        ):
            result, output = self.run_main(security_preflight)
        self.assertEqual(result, 2)
        self.assertEqual(json.loads(output), {"ok": True})

    def test_preflight_absent_service_metric_filters_and_foundation_decisions(self):
        target_trail = "ian-photography-security-prod"
        expected_filter = "ian-photography-root-activity-prod"

        def caller_for(mode):
            def caller(arguments, profile, region):
                service, operation = arguments[:2]
                if service == "sts":
                    return {"Account": "123456789012"}
                if service == "securityhub":
                    raise security_preflight.AwsCallError(service, operation, "Security Hub is not enabled")
                if service == "cloudtrail":
                    if mode == "unknown":
                        raise security_preflight.AwsCallError(service, operation, "Access denied")
                    if mode == "existing":
                        return {"trailList": [{"Name": target_trail}]}
                    return {"trailList": [{"Name": "central", "IsMultiRegionTrail": True}]}
                if service == "logs" and operation == "describe-log-groups":
                    return {"logGroups": []}
                if service == "logs" and operation == "describe-metric-filters":
                    return {"metricFilters": [{"filterName": expected_filter}]}
                return {}

            return caller

        expected = {
            "unknown": "skip-inventory-incomplete",
            "existing": "skip-and-review-existing-for-import-or-existing-stack",
            "multi": "review-existing-multi-region-trail-before-creating-another",
        }
        for mode, decision in expected.items():
            with self.subTest(mode=mode):
                report, incomplete = security_preflight.inventory(
                    stage="prod",
                    region="us-west-2",
                    profile=None,
                    audit_log_group_name="/aws/security/audit",
                    details=True,
                    caller=caller_for(mode),
                )
                self.assertEqual(report["recommendedParameters"]["auditFoundation"], decision)
                self.assertEqual(
                    report["inventory"]["notifications"]["metricFilterNames"],
                    [expected_filter],
                )
                self.assertEqual(report["inventory"]["securityHub"]["hubCount"], 0)
                self.assertEqual(incomplete, mode == "unknown")


class CoverageGateEntrypointTests(unittest.TestCase):
    def test_script_entrypoint_enforces_report(self):
        report = {
            "totals": {
                "covered_lines": 9,
                "num_statements": 10,
                "covered_branches": 8,
                "num_branches": 10,
            }
        }
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / "coverage.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            with patch.object(
                sys, "argv", [coverage_gate.__file__, str(report_path)]
            ), patch("sys.stdout", new_callable=io.StringIO), self.assertRaises(SystemExit) as exit_status:
                runpy.run_path(coverage_gate.__file__, run_name="__main__")
        self.assertEqual(exit_status.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
