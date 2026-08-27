import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from test_support import claims, gateway_event, response_body

import get_github_analytics
import github_analytics
import refresh_github_analytics


CONTEXT = SimpleNamespace(aws_request_id="github-report-request")
ADMIN_EVENT = gateway_event(claims(groups=["Admins"]))


def sample_report():
    return {
        "schemaVersion": 1,
        "generatedAt": "2026-08-26T12:00:00Z",
        "repository": {"headSha": "a" * 40},
        "totalCommits": 10,
        "commits30d": 2,
        "recentCommits": [],
        "languages": [],
        "loc": {"total": 1, "files": 1, "areas": [], "languages": []},
        "workflow": {},
        "recentRuns": [],
        "activity": {"status": "ready", "weeks": []},
    }


class GitHubAnalyticsApiTests(unittest.TestCase):
    def test_front_door_and_admin_guards_run_before_cache(self):
        denied = {"statusCode": 403, "body": "denied"}
        with patch.object(get_github_analytics, "verify_front_door_request", return_value=denied), patch.object(
            get_github_analytics, "load_cached_report"
        ) as cache:
            self.assertIs(get_github_analytics.handler({}, CONTEXT), denied)
            cache.assert_not_called()
        with patch.object(get_github_analytics, "verify_front_door_request", return_value=None), patch.object(
            get_github_analytics, "require_admin", return_value=denied
        ), patch.object(get_github_analytics, "load_cached_report") as cache:
            self.assertIs(get_github_analytics.handler({}, CONTEXT), denied)
            cache.assert_not_called()

    def test_cached_snapshot_is_returned_without_provider_access_and_audited(self):
        with patch.object(get_github_analytics, "verify_front_door_request", return_value=None), patch.object(
            get_github_analytics, "require_admin", return_value=None
        ), patch.object(get_github_analytics, "load_cached_report", return_value=sample_report()), patch.object(
            get_github_analytics, "_cache_status", return_value="fresh"
        ), patch.object(get_github_analytics, "emit_audit_event") as audit:
            response = get_github_analytics.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["cacheStatus"], "fresh")
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        self.assertEqual(audit.call_args.kwargs["reason_code"], "fresh_report")

    def test_missing_and_failed_cache_are_safe(self):
        common = (
            patch.object(get_github_analytics, "verify_front_door_request", return_value=None),
            patch.object(get_github_analytics, "require_admin", return_value=None),
        )
        with common[0], common[1], patch.object(get_github_analytics, "load_cached_report", return_value=None):
            response = get_github_analytics.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response_body(response)["code"], "github_analytics_preparing")
        with patch.object(get_github_analytics, "verify_front_door_request", return_value=None), patch.object(
            get_github_analytics, "require_admin", return_value=None
        ), patch.object(get_github_analytics, "load_cached_report", side_effect=RuntimeError("secret")), self.assertLogs(
            "photography_api.github_analytics_api", level="ERROR"
        ) as logs:
            response = get_github_analytics.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response_body(response)["code"], "github_analytics_unavailable")
        self.assertNotIn("secret", response["body"] + " ".join(logs.output))


class GitHubAnalyticsCollectorTests(unittest.TestCase):
    def test_refresh_requires_the_exact_trusted_event(self):
        with patch.object(refresh_github_analytics, "load_cached_report", return_value=sample_report()), patch.object(
            refresh_github_analytics, "build_report", return_value=sample_report()
        ) as build, patch.object(refresh_github_analytics, "store_report") as store:
            result = refresh_github_analytics.handler(github_analytics.SCHEDULED_REFRESH_EVENT, CONTEXT)
        self.assertTrue(result["refreshed"])
        build.assert_called_once()
        store.assert_called_once()
        with self.assertRaises(ValueError):
            refresh_github_analytics.handler({"source": "untrusted"}, CONTEXT)

    def test_archive_count_excludes_dependencies_locks_generated_and_blank_lines(self):
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, "w") as archive:
            archive.writestr("repo/src/App.jsx", "const one = 1\n\nconst two = 2\n")
            archive.writestr("repo/src/App.test.jsx", "test('one', () => {})\n")
            archive.writestr("repo/backend/functions/run.py", "def run():\n    return True\n")
            archive.writestr("repo/backend/template.yaml", "Resources:\n  One: {}\n")
            archive.writestr("repo/node_modules/vendor.js", "ignored\n")
            archive.writestr("repo/package-lock.json", "{\"ignored\": true}\n")

        class Response:
            status = 200
            headers = {"Content-Length": str(len(raw.getvalue()))}
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def read(self, *_args): return raw.getvalue()
            def geturl(self): return f"{github_analytics.ARCHIVE_BASE}/{github_analytics.OWNER}/{github_analytics.REPOSITORY}/zip/{'a' * 40}"

        with patch.object(github_analytics.urllib.request, "urlopen", return_value=Response()):
            result = github_analytics._count_archive("a" * 40)
        self.assertEqual(result["total"], 7)
        self.assertEqual(result["files"], 4)
        areas = {item["name"]: item["lines"] for item in result["areas"]}
        self.assertEqual(areas["Frontend"], 2)
        self.assertEqual(areas["Tests"], 1)
        self.assertEqual(areas["Backend"], 2)
        self.assertEqual(areas["Infrastructure & Ops"], 2)

    def test_cached_payload_validation_and_size_limit(self):
        with patch.object(github_analytics.cache_table, "get_item", return_value={"Item": {"payload": "not-json"}}):
            self.assertIsNone(github_analytics.load_cached_report())
        with patch.object(github_analytics.cache_table, "put_item") as put:
            github_analytics.store_report(sample_report())
        stored = put.call_args.kwargs["Item"]
        self.assertEqual(json.loads(stored["payload"])["schemaVersion"], 1)
