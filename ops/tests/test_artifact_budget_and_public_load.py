from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ops.ci import artifact_budget  # noqa: E402
from ops import public_catalog_load_test as public_load  # noqa: E402


ACCOUNT = "111111111111"
PRODUCTION_ACCOUNT = "222222222222"
ALBUM_ONE = "11111111-1111-4111-8111-111111111111"
ALBUM_TWO = "22222222-2222-4222-8222-222222222222"
PUBLIC_HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=60, s-maxage=300",
}


def summary(album_id=ALBUM_ONE, count=1):
    return {
        "albumId": album_id,
        "type": "photo",
        "title": "Title",
        "description": "Description",
        "category": "Portraits",
        "createdAt": "2026-01-01T00:00:00Z",
        "visibility": "public",
        "imageCount": count,
        "coverImageUrl": "https://media.example.test/cover.jpg",
        "coverThumbnailUrl": "https://media.example.test/thumb.jpg",
        "coverBlurhash": "hash",
    }


def detail(album_id=ALBUM_ONE, count=1):
    album = summary(album_id, count)
    album.pop("imageCount")
    images = [
        {
            "id": f"image-{index}",
            "url": f"https://media.example.test/{index}.jpg",
            "thumbnailUrl": f"https://media.example.test/{index}-thumb.jpg",
            "downloadUrl": f"https://media.example.test/{index}.jpg",
            "previewSrcSet": [
                {"width": 640, "url": f"https://media.example.test/{index}-640.webp"}
            ],
            "exif": {"model": "Camera", "iso": "ISO 100"},
        }
        for index in range(count)
    ]
    return {"album": album, "images": images}


class FrontendArtifactBudgetTests(unittest.TestCase):
    def section(self):
        return {
            "totalUncompressedBytes": 10_000,
            "totalGzipBytes": 10_000,
            "entryJavaScriptBytes": 10_000,
            "entryJavaScriptGzipBytes": 10_000,
            "entryCssBytes": 10_000,
            "entryCssGzipBytes": 10_000,
            "largestChunkBytes": 10_000,
            "largestChunkGzipBytes": 10_000,
        }

    def create_frontend(self, root: Path):
        (root / "assets").mkdir()
        (root / "index.html").write_text(
            '<script type="module" src="/assets/app.js"></script>'
            '<link rel="modulepreload" href="/assets/vendor.js">'
            '<link rel="stylesheet" href="/assets/app.css">',
            encoding="utf-8",
        )
        (root / "assets" / "app.js").write_text("export default 1", encoding="utf-8")
        (root / "assets" / "vendor.js").write_text("export const dependency = 1", encoding="utf-8")
        (root / "assets" / "app.css").write_text("body{}", encoding="utf-8")

    def test_frontend_metrics_pass_and_budget_violation_is_sanitized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.create_frontend(root)
            evidence = artifact_budget.evaluate_frontend(root, self.section())
            self.assertTrue(evidence["passed"])
            self.assertEqual(evidence["metrics"]["fileCount"], 4)
            self.assertGreater(
                evidence["metrics"]["entryJavaScriptBytes"],
                (root / "assets" / "app.js").stat().st_size,
            )
            section = self.section()
            section["largestChunkBytes"] = 1
            evidence = artifact_budget.evaluate_frontend(root, section)
            self.assertFalse(evidence["passed"])
            self.assertEqual(evidence["violations"][0]["code"], "budget_exceeded")
            self.assertNotIn(directory, json.dumps(evidence))

    def test_frontend_rejects_empty_symlink_missing_and_unsafe_entrypoints(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(artifact_budget.BudgetError):
                artifact_budget.evaluate_frontend(root, self.section())
            self.create_frontend(root)
            (root / "assets" / "app.js").unlink()
            with self.assertRaises(artifact_budget.BudgetError):
                artifact_budget.evaluate_frontend(root, self.section())
            (root / "index.html").write_text(
                '<script src="../escape.js"></script><link rel="stylesheet" href="/assets/app.css">',
                encoding="utf-8",
            )
            with self.assertRaises(artifact_budget.BudgetError):
                artifact_budget.evaluate_frontend(root, self.section())

    def test_config_and_positive_integer_validation_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            for value in ("not json", "{}", '{"schemaVersion":1,"frontend":{},"sam":{}}'):
                path.write_text(value, encoding="utf-8")
                if value.endswith("{}}"):
                    self.assertEqual(artifact_budget.load_config(path)["schemaVersion"], 1)
                else:
                    with self.assertRaises(artifact_budget.BudgetError):
                        artifact_budget.load_config(path)
            for value in (0, True, "1"):
                with self.subTest(value=value), self.assertRaises(artifact_budget.BudgetError):
                    artifact_budget._integer({"size": value}, "size")


class SamArtifactBudgetTests(unittest.TestCase):
    def fixture(self, root: Path, *, unrelated=False, missing=False):
        source = root / "functions"
        build = root / "build"
        source.mkdir()
        build.mkdir()
        for name in ("alpha.py", "helper.py", "other.py"):
            (source / name).write_text("pass\n", encoding="utf-8")
        (root / "Makefile").write_text(
            "SOURCES_AlphaFunction := alpha.py helper.py\n", encoding="utf-8"
        )
        (root / "template.yaml").write_text(
            "Resources:\n"
            "  AlphaFunction:\n"
            "    Type: AWS::Serverless::Function\n"
            "    Properties:\n"
            "      Handler: alpha.handler\n",
            encoding="utf-8",
        )
        alpha = build / "AlphaFunction"
        preview = build / "PreviewWorkerFunction"
        alpha.mkdir()
        preview.mkdir()
        (alpha / "alpha.py").write_text("pass\n", encoding="utf-8")
        if not missing:
            (alpha / "helper.py").write_text("pass\n", encoding="utf-8")
        if unrelated:
            (alpha / "other.py").write_text("pass\n", encoding="utf-8")
        (preview / "index.mjs").write_text("export {};\n", encoding="utf-8")
        return build, source

    def budgets(self):
        return {
            "default": {"uncompressedBytes": 10_000, "fileCount": 10},
            "overrides": {
                "PreviewWorkerFunction": {"uncompressedBytes": 10_000, "fileCount": 10}
            },
        }

    def evaluate(self, root: Path, build: Path, source: Path, budgets=None):
        return artifact_budget.evaluate_sam(
            build,
            budgets or self.budgets(),
            root / "Makefile",
            root / "template.yaml",
            source,
        )

    def test_sam_metrics_pass_with_explicit_allowlists(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build, source = self.fixture(root)
            evidence = self.evaluate(root, build, source)
            self.assertTrue(evidence["passed"])
            self.assertEqual(evidence["metrics"]["functionCount"], 2)

    def test_sam_accepts_only_internal_file_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build, source = self.fixture(root)
            preview = build / "PreviewWorkerFunction"
            (preview / "bin-link").symlink_to("index.mjs")
            self.assertTrue(self.evaluate(root, build, source)["passed"])
            (preview / "bin-link").unlink()
            (preview / "outside-link").symlink_to(root / "Makefile")
            evidence = self.evaluate(root, build, source)
            self.assertFalse(evidence["passed"])
            self.assertIn("artifact_invalid", {item["code"] for item in evidence["violations"]})

    def test_sam_detects_unrelated_missing_oversized_and_absent_artifacts(self):
        for mode in ("unrelated", "missing", "absent", "oversized"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                build, source = self.fixture(
                    root, unrelated=mode == "unrelated", missing=mode == "missing"
                )
                budgets = self.budgets()
                if mode == "absent":
                    (build / "PreviewWorkerFunction" / "index.mjs").unlink()
                if mode == "oversized":
                    budgets["default"] = {"uncompressedBytes": 1, "fileCount": 1}
                evidence = self.evaluate(root, build, source, budgets)
                self.assertFalse(evidence["passed"])

    def test_sam_parsers_reject_drift_and_malformed_allowlists(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            makefile = root / "Makefile"
            template = root / "template.yaml"
            makefile.write_text("SOURCES_A := a.py a.py\n", encoding="utf-8")
            with self.assertRaises(artifact_budget.BudgetError):
                artifact_budget.parse_makefile_allowlists(makefile)
            makefile.write_text("SOURCES_A := ../a.py\n", encoding="utf-8")
            with self.assertRaises(artifact_budget.BudgetError):
                artifact_budget.parse_makefile_allowlists(makefile)
            template.write_text("Resources: {}\n", encoding="utf-8")
            with self.assertRaises(artifact_budget.BudgetError):
                artifact_budget.parse_python_handlers(template)

    def test_cli_writes_failure_evidence_without_local_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "evidence.json"
            result = artifact_budget.main(
                ["--config", str(root / "missing.json"), "--output", str(output), "frontend", "--root", str(root)]
            )
            self.assertEqual(result, 2)
            evidence = json.loads(output.read_text(encoding="utf-8"))
            self.assertFalse(evidence["passed"])
            self.assertNotIn(directory, json.dumps(evidence))


class PublicCatalogProbeTests(unittest.TestCase):
    def test_transport_accepts_bounded_json_and_rejects_duplicate_or_failed_responses(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        response.headers = {"Content-Type": "application/json", "Cache-Control": "public"}
        response.read.return_value = b'{"items":[]}'
        opener = mock.MagicMock()
        opener.open.return_value = response
        with mock.patch.object(public_load.urllib.request, "build_opener", return_value=opener):
            payload, headers = public_load.request_json("https://api.example.test/dev", 5)
        self.assertEqual(payload, {"items": []})
        self.assertEqual(headers["content-type"], "application/json")

        response.read.return_value = b'{"a":1,"a":2}'
        with mock.patch.object(public_load.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(public_load.ProbeError):
                public_load.request_json("https://api.example.test/dev", 5)
        response.headers = {"Content-Length": "10000001"}
        with mock.patch.object(public_load.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(public_load.ProbeError, "body limit"):
                public_load.request_json("https://api.example.test/dev", 5)
        response.headers = {}
        response.read.return_value = b"x" * 10_000_001
        with mock.patch.object(public_load.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(public_load.ProbeError, "body limit"):
                public_load.request_json("https://api.example.test/dev", 5)
        opener.open.side_effect = urllib.error.HTTPError("https://x", 429, "", {}, None)
        with mock.patch.object(public_load.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(public_load.ProbeError, "HTTP 429"):
                public_load.request_json("https://api.example.test/dev", 5)
        opener.open.side_effect = urllib.error.URLError("private transport detail")
        with mock.patch.object(public_load.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(public_load.ProbeError, "request failed"):
                public_load.request_json("https://api.example.test/dev", 5)
        with self.assertRaises(public_load.ProbeError):
            public_load._NoRedirect().redirect_request(None, None, 302, "", {}, "https://prod")

    def test_two_page_probe_checks_completeness_cursor_and_detail_aggregate(self):
        calls = []

        def requester(url, timeout):
            calls.append((url, timeout))
            if url.endswith(f"/{ALBUM_ONE}"):
                return detail(ALBUM_ONE, 1), PUBLIC_HEADERS
            if "cursor=" in url:
                return {"items": [summary(ALBUM_TWO, 0)], "nextCursor": None}, PUBLIC_HEADERS
            return {"items": [summary(ALBUM_ONE, 1)], "nextCursor": "next"}, PUBLIC_HEADERS

        metrics = public_load.run_catalog_probe(
            "https://api.staging.example.test/dev",
            limit=100,
            max_pages=3,
            detail_sample=1,
            timeout=5,
            requester=requester,
        )
        self.assertEqual(metrics["albumCount"], 2)
        self.assertEqual(metrics["requestCount"], 3)
        self.assertEqual(metrics["sampledImageCount"], 1)
        self.assertTrue(metrics["complete"])

    def test_probe_rejects_duplicate_album_repeated_cursor_count_mismatch_and_page_bound(self):
        responses = [
            [
                ({"items": [summary(), summary()], "nextCursor": None}, PUBLIC_HEADERS),
            ],
            [
                ({"items": [], "nextCursor": "same"}, PUBLIC_HEADERS),
                ({"items": [], "nextCursor": "same"}, PUBLIC_HEADERS),
            ],
            [
                ({"items": [summary(count=2)], "nextCursor": None}, PUBLIC_HEADERS),
                (detail(count=1), PUBLIC_HEADERS),
            ],
            [
                ({"items": [], "nextCursor": "more"}, PUBLIC_HEADERS),
            ],
        ]
        for index, sequence in enumerate(responses):
            with self.subTest(index=index):
                iterator = iter(sequence)
                with self.assertRaises(public_load.ProbeError):
                    public_load.run_catalog_probe(
                        "https://api.staging.example.test/dev",
                        limit=100,
                        max_pages=1 if index == 3 else 3,
                        detail_sample=1,
                        timeout=5,
                        requester=lambda _url, _timeout: next(iterator),
                    )

    def test_public_schema_rejects_private_fields_signed_urls_and_exif_expansion(self):
        invalid_summaries = [
            summary() | {"ownerEmail": "private@example.test"},
            summary() | {"visibility": "private"},
            summary() | {"albumId": "bad"},
            summary() | {"imageCount": True},
            summary() | {"coverImageUrl": "https://media.test/x?X-Amz-Signature=secret"},
        ]
        for value in invalid_summaries:
            with self.subTest(value=value), self.assertRaises(public_load.ProbeError):
                public_load.validate_summary(value)
        payload = detail()
        payload["images"][0]["exif"]["gps"] = "private"
        with self.assertRaises(public_load.ProbeError):
            public_load.validate_detail(payload, ALBUM_ONE)
        payload = detail()
        payload["images"][0]["previewSrcSet"] = [{"width": True, "url": "https://media.test/x"}]
        with self.assertRaises(public_load.ProbeError):
            public_load.validate_detail(payload, ALBUM_ONE)

    def test_cache_and_detail_field_guards_fail_closed(self):
        for headers in (
            {"content-type": "text/html", "cache-control": "public, s-maxage=1"},
            {"content-type": "application/json", "cache-control": "private, no-store"},
            PUBLIC_HEADERS | {"set-cookie": "session=bad"},
        ):
            with self.subTest(headers=headers), self.assertRaises(public_load.ProbeError):
                public_load._validate_cache_headers(headers)
        payload = detail()
        payload["images"][0]["rawKey"] = "albums/private.jpg"
        with self.assertRaises(public_load.ProbeError):
            public_load.validate_detail(payload, ALBUM_ONE)
        invalid_details = []
        payload = detail()
        payload["album"]["albumId"] = ALBUM_TWO
        invalid_details.append(payload)
        payload = detail()
        payload["images"] = {}
        invalid_details.append(payload)
        payload = detail()
        payload["images"] = ["not-an-object"]
        invalid_details.append(payload)
        payload = detail()
        payload["images"][0]["id"] = ""
        invalid_details.append(payload)
        payload = detail()
        payload["images"][0]["previewSrcSet"] = [{}]
        invalid_details.append(payload)
        for payload in invalid_details:
            with self.subTest(payload=payload), self.assertRaises(public_load.ProbeError):
                public_load.validate_detail(payload, ALBUM_ONE)
        for value in (None, "http://media.example.test/file.jpg"):
            with self.subTest(value=value), self.assertRaises(public_load.ProbeError):
                public_load._public_url(value)
        with self.assertRaises(public_load.ProbeError):
            public_load._exact_fields([], set(), "value")
        invalid_text = summary()
        invalid_text["title"] = None
        with self.assertRaises(public_load.ProbeError):
            public_load.validate_summary(invalid_text)

    def test_nonproduction_url_and_account_guards(self):
        self.assertEqual(
            public_load.validate_nonproduction_target("https://api.staging.example.test/dev/"),
            "https://api.staging.example.test/dev",
        )
        self.assertEqual(
            public_load.validate_nonproduction_target("http://localhost:3000"),
            "http://localhost:3000",
        )
        for value in (
            "https://iantruongphotography.com",
            "https://api.iantruongphotography.com",
            "https://api.example.test/prod",
            "http://api.staging.example.test/dev",
            "https://user:pass@example.test/dev",
        ):
            with self.subTest(value=value), self.assertRaises(public_load.ProbeError):
                public_load.validate_nonproduction_target(value)

        args = argparse.Namespace(
            environment="nonproduction",
            confirm=public_load.CONFIRMATION,
            expected_account_id=ACCOUNT,
            confirm_account_id=ACCOUNT,
            production_account_id=PRODUCTION_ACCOUNT,
            base_url="https://api.staging.example.test/dev",
            aws_cli="aws",
        )
        self.assertEqual(
            public_load.validate_apply_guards(args, account_lookup=lambda _cli: ACCOUNT),
            args.base_url,
        )
        args.production_account_id = ACCOUNT
        with self.assertRaises(public_load.ProbeError):
            public_load.validate_apply_guards(args, account_lookup=lambda _cli: ACCOUNT)

    def test_account_lookup_and_remaining_apply_guards_fail_closed(self):
        completed = mock.Mock(stdout=json.dumps({"Account": ACCOUNT}))
        with mock.patch.object(public_load.subprocess, "run", return_value=completed) as run:
            self.assertEqual(public_load.active_account_id("aws"), ACCOUNT)
        self.assertEqual(run.call_args.args[0][:3], ["aws", "sts", "get-caller-identity"])
        with mock.patch.object(public_load.subprocess, "run", side_effect=OSError("private")):
            with self.assertRaisesRegex(public_load.ProbeError, "verify"):
                public_load.active_account_id("aws")

        base = dict(
            environment="nonproduction",
            confirm=public_load.CONFIRMATION,
            expected_account_id=ACCOUNT,
            confirm_account_id=ACCOUNT,
            production_account_id=PRODUCTION_ACCOUNT,
            base_url="https://api.staging.example.test/dev",
            aws_cli="aws",
        )
        invalid = [
            base | {"confirm": "wrong"},
            base | {"expected_account_id": "bad"},
            base | {"confirm_account_id": PRODUCTION_ACCOUNT},
        ]
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(public_load.ProbeError):
                public_load.validate_apply_guards(
                    argparse.Namespace(**values), account_lookup=lambda _cli: ACCOUNT
                )
        with self.assertRaisesRegex(public_load.ProbeError, "active AWS account"):
            public_load.validate_apply_guards(
                argparse.Namespace(**base), account_lookup=lambda _cli: PRODUCTION_ACCOUNT
            )

    def test_default_cli_is_network_free_and_writes_aggregate_evidence(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            public_load, "request_json"
        ) as request:
            output = Path(directory) / "evidence.json"
            self.assertEqual(public_load.main(["--output", str(output)]), 0)
            request.assert_not_called()
            evidence = json.loads(output.read_text(encoding="utf-8"))
            self.assertTrue(evidence["passed"])
            self.assertFalse(evidence["metrics"]["networkExecuted"])
            self.assertNotIn("base-url", json.dumps(evidence).lower())

    def test_cli_rejects_unsafe_bounds_and_sanitizes_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "evidence.json"
            result = public_load.main(["--limit", "101", "--output", str(output)])
            self.assertEqual(result, 2)
            evidence = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(evidence["violations"], [{"code": "public_catalog_probe_failed"}])

    def test_apply_cli_uses_guards_and_writes_only_probe_aggregates(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            public_load, "validate_apply_guards", return_value="https://api.staging.example.test/dev"
        ) as guards, mock.patch.object(
            public_load,
            "run_catalog_probe",
            return_value={"networkExecuted": True, "requestCount": 1, "albumCount": 0},
        ) as probe:
            output = Path(directory) / "evidence.json"
            result = public_load.main(["--apply", "--output", str(output)])
            self.assertEqual(result, 0)
            guards.assert_called_once()
            probe.assert_called_once()
            evidence = json.loads(output.read_text(encoding="utf-8"))
            self.assertTrue(evidence["passed"])
            self.assertNotIn("staging", json.dumps(evidence))


if __name__ == "__main__":
    unittest.main()
