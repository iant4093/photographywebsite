import datetime as dt
import hashlib
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch
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

    def test_repository_selection_is_allowlisted_and_scopes_cache_reads(self):
        self.assertEqual(set(github_analytics.REPOSITORIES), {"photographywebsite", "TruongCam", "TruongNoiser", "TruongScaler", "TruongFlix", "TruongCleaner"})
        for repository in github_analytics.REPOSITORIES:
            event = {**ADMIN_EVENT, "queryStringParameters": {"repo": repository}}
            with patch.object(get_github_analytics, "verify_front_door_request", return_value=None), patch.object(
                get_github_analytics, "require_admin", return_value=None
            ), patch.object(get_github_analytics, "load_cached_report", return_value=sample_report()) as cache, patch.object(
                get_github_analytics, "emit_audit_event"
            ):
                response = get_github_analytics.handler(event, CONTEXT)
            self.assertEqual(response["statusCode"], 200)
            cache.assert_called_once_with(repository)
        for repository in ("other", "../TruongCam", "https://example.com", ""):
            with patch.object(get_github_analytics, "verify_front_door_request", return_value=None), patch.object(
                get_github_analytics, "require_admin", return_value=None
            ), patch.object(get_github_analytics, "load_cached_report") as cache:
                response = get_github_analytics.handler({**ADMIN_EVENT, "queryStringParameters": {"repo": repository}}, CONTEXT)
            self.assertEqual(response["statusCode"], 400)
            cache.assert_not_called()

    def test_all_repositories_returns_available_snapshots_with_individual_freshness(self):
        snapshots = {
            "photographywebsite": {**sample_report(), "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat()},
            "TruongFlix": {**sample_report(), "generatedAt": "2000-01-01T00:00:00Z"},
        }
        event = {**ADMIN_EVENT, "queryStringParameters": {"repo": "all"}}
        with patch.object(get_github_analytics, "verify_front_door_request", return_value=None), patch.object(
            get_github_analytics, "require_admin", return_value=None
        ), patch.object(get_github_analytics, "load_cached_report", side_effect=snapshots.get) as cache, patch.object(
            get_github_analytics, "emit_audit_event"
        ) as audit:
            response = get_github_analytics.handler(event, CONTEXT)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        body = response_body(response)
        self.assertEqual([repo["name"] for repo in body["repositories"]], list(github_analytics.REPOSITORIES))
        self.assertEqual(body["cacheStatus"], "partial")
        self.assertEqual({name: report["cacheStatus"] for name, report in body["reports"].items()}, {
            "photographywebsite": "fresh", "TruongFlix": "stale",
        })
        self.assertNotIn("cacheStatus", snapshots["TruongFlix"])
        self.assertEqual(cache.call_args_list, [call(repo) for repo in github_analytics.REPOSITORIES])
        audit.assert_called_once()
        self.assertEqual(audit.call_args.kwargs["reason_code"], "partial_report")

    def test_missing_and_failed_cache_are_safe(self):
        common = (
            patch.object(get_github_analytics, "verify_front_door_request", return_value=None),
            patch.object(get_github_analytics, "require_admin", return_value=None),
        )
        with common[0], common[1], patch.object(get_github_analytics, "load_cached_report", return_value=None):
            response = get_github_analytics.handler(ADMIN_EVENT, CONTEXT)
            all_response = get_github_analytics.handler({**ADMIN_EVENT, "queryStringParameters": {"repo": "all"}}, CONTEXT)
        self.assertEqual(response_body(response)["code"], "github_analytics_preparing")
        self.assertEqual(response_body(all_response)["code"], "github_analytics_preparing")
        with patch.object(get_github_analytics, "verify_front_door_request", return_value=None), patch.object(
            get_github_analytics, "require_admin", return_value=None
        ), patch.object(get_github_analytics, "load_cached_report", side_effect=RuntimeError("secret")), self.assertLogs(
            "photography_api.github_analytics_api", level="ERROR"
        ) as logs:
            response = get_github_analytics.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response_body(response)["code"], "github_analytics_unavailable")
        self.assertNotIn("secret", response["body"] + " ".join(logs.output))


class GitHubAnalyticsCollectorTests(unittest.TestCase):
    def test_large_model_repo_fetches_only_counted_sources_at_the_requested_revision(self):
        sha = "b" * 40
        contents = {"Sources/Engine.swift": b"let one = 1\n\nlet two = 2\n", "Tests/EngineTests/Engine Tests.swift": b"func testEngine() {}\n"}
        tree = [
            {"path": path, "type": "blob", "mode": "100644", "size": len(content), "sha": hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()}
            for path, content in contents.items()
        ]
        tree.extend([
            {"path": "Models/weights.bin", "type": "blob", "mode": "100644", "size": 100_000_000},
            {"path": "node_modules/ignored.swift", "type": "blob", "mode": "100644", "size": 100},
            {"path": "package-lock.json", "type": "blob", "mode": "100644", "size": 100},
            {"path": "linked.swift", "type": "blob", "mode": "120000", "size": 100},
        ])

        class Response(io.BytesIO):
            def __init__(self, url, content):
                super().__init__(content)
                self.url = url
                self.headers = {"Content-Length": str(len(content))}
            def geturl(self): return self.url

        def open_source(request, **_kwargs):
            prefix = f"https://raw.githubusercontent.com/iant4093/TruongScaler/{sha}/"
            self.assertTrue(request.full_url.startswith(prefix))
            path = github_analytics.urllib.parse.unquote(request.full_url[len(prefix):])
            return Response(request.full_url, contents[path])

        with patch.object(github_analytics, "_request", return_value=(200, {"truncated": False, "tree": tree}, {})) as api, patch.object(
            github_analytics.urllib.request, "urlopen", side_effect=open_source
        ) as raw:
            result = github_analytics._count_archive(sha, "TruongScaler")
        api.assert_called_once_with(f"/repos/iant4093/TruongScaler/git/trees/{sha}?recursive=1")
        self.assertEqual(raw.call_count, 2)
        self.assertEqual(result["revision"], sha)
        self.assertEqual(result["total"], 3)
        self.assertEqual(result["files"], 2)
        areas = {item["name"]: item["lines"] for item in result["areas"]}
        self.assertEqual(areas["iPhone App"], 2)
        self.assertEqual(areas["Tests"], 1)

    def test_source_tree_refuses_incomplete_unsafe_or_oversized_inventories_before_download(self):
        valid = {"path": "App.swift", "type": "blob", "mode": "100644", "size": 10, "sha": "a" * 40}
        cases = [
            {"truncated": True, "tree": []},
            {"tree": []},
            {"truncated": False, "tree": [{**valid, "path": "../App.swift"}]},
            {"truncated": False, "tree": [{**valid, "path": "/App.swift"}]},
            {"truncated": False, "tree": [{**valid, "path": "App\n.swift"}]},
            {"truncated": False, "tree": [{**valid, "sha": "invalid"}]},
            {"truncated": False, "tree": [{**valid, "size": -1}]},
            {"truncated": False, "tree": [{**valid, "size": True}]},
            {"truncated": False, "tree": [valid, valid]},
        ]
        for payload in cases:
            with self.subTest(payload=payload), patch.object(github_analytics, "_request", return_value=(200, payload, {})), patch.object(
                github_analytics.urllib.request, "urlopen"
            ) as raw, self.assertRaises(github_analytics.ProviderContractError):
                github_analytics._count_archive("b" * 40, "TruongScaler")
            raw.assert_not_called()
        payload = {"truncated": False, "tree": [valid]}
        for limit in ("MAX_ARCHIVE_FILES", "MAX_ARCHIVE_EXPANDED_BYTES"):
            with self.subTest(limit=limit), patch.object(github_analytics, limit, 0), patch.object(
                github_analytics, "_request", return_value=(200, payload, {})
            ), self.assertRaises(github_analytics.ProviderContractError):
                github_analytics._count_archive("b" * 40, "TruongScaler")

    def test_source_tree_refuses_changed_bytes_redirects_and_oversized_responses(self):
        sha = "b" * 40
        url = f"https://raw.githubusercontent.com/iant4093/TruongScaler/{sha}/App.swift"
        payload = {"truncated": False, "tree": [{"path": "App.swift", "type": "blob", "mode": "100644", "size": 3, "sha": "a" * 40}]}
        for content, final_url, length in ((b"bad", url, "3"), (b"x", url, "1"), (b"bad", "https://example.com/file", "3"), (b"bad!", url, "4")):
            response = io.BytesIO(content)
            response.headers = {"Content-Length": length}
            response.geturl = lambda: final_url
            with self.subTest(content=content, url=final_url), patch.object(github_analytics, "_request", return_value=(200, payload, {})), patch.object(
                github_analytics.urllib.request, "urlopen", return_value=response
            ), self.assertRaises(github_analytics.ProviderContractError):
                github_analytics._count_archive(sha, "TruongScaler")

    def test_refresh_requires_the_exact_trusted_event(self):
        with patch.object(refresh_github_analytics, "load_cached_report", return_value=sample_report()), patch.object(
            refresh_github_analytics, "build_report", return_value=sample_report()
        ) as build, patch.object(refresh_github_analytics, "store_report") as store:
            result = refresh_github_analytics.handler(github_analytics.SCHEDULED_REFRESH_EVENT, CONTEXT)
        self.assertTrue(result["refreshed"])
        self.assertEqual(build.call_count, len(github_analytics.REPOSITORIES))
        self.assertEqual(store.call_count, len(github_analytics.REPOSITORIES))
        self.assertEqual(result["repositories"], list(github_analytics.REPOSITORIES))
        with self.assertRaises(ValueError):
            refresh_github_analytics.handler({"source": "untrusted"}, CONTEXT)

    def test_failed_repository_preserves_cache_and_does_not_block_other_refreshes(self):
        remaining = list(github_analytics.REPOSITORIES)[1:]
        with patch.object(refresh_github_analytics, "load_cached_report", return_value=sample_report()), patch.object(
            refresh_github_analytics, "build_report", side_effect=[RuntimeError("provider down")] + [sample_report()] * len(remaining)
        ) as build, patch.object(refresh_github_analytics, "store_report") as store, self.assertLogs(level="ERROR"):
            with self.assertRaises(RuntimeError):
                refresh_github_analytics.handler(github_analytics.SCHEDULED_REFRESH_EVENT, CONTEXT)
        self.assertEqual(build.call_count, len(github_analytics.REPOSITORIES))
        self.assertEqual(store.call_args_list, [call(sample_report(), repository) for repository in remaining])

    def test_cache_entries_are_independent_and_website_key_is_preserved(self):
        with patch.object(github_analytics.cache_table, "put_item") as put, patch.object(
            github_analytics.cache_table, "get_item", return_value={}
        ) as get:
            for repository in github_analytics.REPOSITORIES:
                github_analytics.store_report(sample_report(), repository)
                github_analytics.load_cached_report(repository)
        keys = [call.kwargs["Item"]["cacheKey"] for call in put.call_args_list]
        self.assertEqual(keys, [github_analytics.CACHE_KEY] + [github_analytics.CACHE_KEY + f":iant4093/{repository}" for repository in list(github_analytics.REPOSITORIES)[1:]])
        self.assertEqual([call.kwargs["Key"]["cacheKey"] for call in get.call_args_list], keys)
        self.assertEqual(github_analytics.validate_repository(), "photographywebsite")

    def test_swift_app_and_native_tests_are_counted_for_truongcam(self):
        self.assertEqual(github_analytics._source_extension("src/TruongCam/Camera.swift"), (".swift", "Swift"))
        self.assertEqual(github_analytics._source_area("src/TruongCam/Camera.swift"), "iPhone App")
        self.assertEqual(github_analytics._source_area("src/TruongCamTests/CameraTests.swift"), "Tests")
        for app in ("TruongNoiser", "TruongScaler"):
            self.assertEqual(github_analytics._source_area(f"Targets/{app}App/App.swift"), "iPhone App")
            self.assertEqual(github_analytics._source_area("Sources/TiledInferenceEngine/Engine.swift"), "iPhone App")
            self.assertEqual(github_analytics._source_area("Tests/TiledInferenceEngineTests/EngineTests.swift"), "Tests")

    def test_counts_rust_and_swift_for_the_desktop_apps(self):
        flix = github_analytics._summarize_sources("a" * 40, [
            ("src-tauri/src/main.rs", b"fn main() {}\n"),
            ("src/App.tsx", b"export default App;\n"),
            ("tests/player.test.ts", b"test('player', play);\n"),
        ], "TruongFlix")
        self.assertEqual(flix["total"], 3)
        self.assertIn({"name": "Rust", "lines": 1}, flix["languages"])
        self.assertIn({"name": "Desktop App", "lines": 1}, flix["areas"])
        self.assertIn({"name": "Tests", "lines": 1}, flix["areas"])
        cleaner = github_analytics._summarize_sources("b" * 40, [
            ("src/TruongCleaner/App.swift", b"struct CleanerApp {}\n"),
            ("Packages/CleanerKit/Tests/CoreTests/ScanTests.swift", b"func testScan() {}\n"),
        ], "TruongCleaner")
        self.assertEqual(cleaner["total"], 2)
        self.assertIn({"name": "macOS App", "lines": 1}, cleaner["areas"])
        self.assertIn({"name": "Tests", "lines": 1}, cleaner["areas"])

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
