import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops"))

from ci import wait_for_release_idle as idle  # noqa: E402

SHA_A = "a" * 40
SHA_B = "b" * 40


def run(status, conclusion=None, sha=SHA_A):
    return {"status": status, "conclusion": conclusion, "head_sha": sha}


class ReleasedShaTests(unittest.TestCase):
    def test_waits_while_any_release_is_active(self):
        for status in sorted(idle.ACTIVE_STATUSES):
            with self.subTest(status=status):
                self.assertIsNone(idle.released_sha([run(status), run("completed", "success")]))

    def test_reports_the_newest_successful_release(self):
        runs = [run("completed", "failure", SHA_B), run("completed", "cancelled", SHA_B), run("completed", "success")]
        self.assertEqual(idle.released_sha(runs), SHA_A)

    def test_rejects_a_bad_commit_or_no_success(self):
        with self.assertRaisesRegex(idle.ReleaseWaitError, "invalid commit"):
            idle.released_sha([run("completed", "success", "not-a-sha")])
        with self.assertRaisesRegex(idle.ReleaseWaitError, "no successful"):
            idle.released_sha([run("completed", "failure")])
        with self.assertRaisesRegex(idle.ReleaseWaitError, "no successful"):
            idle.released_sha([])


class WaitTests(unittest.TestCase):
    def test_polls_until_the_release_finishes(self):
        responses = iter([[run("in_progress")], [run("queued")], [run("completed", "success", SHA_B)]])
        sleeps = []
        with mock.patch("sys.stderr", io.StringIO()) as stderr:
            sha = idle.wait_for_idle(
                lambda: next(responses), max_wait_seconds=100, poll_seconds=10,
                sleep=sleeps.append, clock=lambda: 0,
            )
        self.assertEqual(sha, SHA_B)
        self.assertEqual(sleeps, [10, 10])
        self.assertIn("release is running", stderr.getvalue())

    def test_gives_up_after_the_limit(self):
        now = [0.0]

        def sleep(seconds):
            now[0] += seconds

        with mock.patch("sys.stderr", io.StringIO()), self.assertRaisesRegex(idle.ReleaseWaitError, "still running"):
            idle.wait_for_idle(
                lambda: [run("in_progress")], max_wait_seconds=25, poll_seconds=10,
                sleep=sleep, clock=lambda: now[0],
            )
        self.assertEqual(now[0], 20)


class FetchTests(unittest.TestCase):
    def response(self, payload):
        body = io.BytesIO(json.dumps(payload).encode("utf-8"))
        context = mock.MagicMock()
        context.__enter__.return_value = body
        return context

    def test_reads_main_release_runs_with_the_token(self):
        with mock.patch("urllib.request.urlopen", return_value=self.response({"workflow_runs": [run("queued")]})) as urlopen:
            runs = idle.fetch_runs("https://api.example", "owner/repo", "token-value")
        self.assertEqual(runs, [run("queued")])
        request = urlopen.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://api.example/repos/owner/repo/actions/workflows/release-production.yml/runs?branch=main&per_page=30",
        )
        self.assertEqual(request.get_header("Authorization"), "Bearer token-value")

    def test_rejects_a_malformed_response(self):
        for payload in ({}, {"workflow_runs": {}}, []):
            with self.subTest(payload=payload), mock.patch("urllib.request.urlopen", return_value=self.response(payload)):
                with self.assertRaises(idle.ReleaseWaitError):
                    idle.fetch_runs("https://api.example", "owner/repo", "token")


class MainTests(unittest.TestCase):
    environ = {"GITHUB_REPOSITORY": "owner/repo", "GITHUB_TOKEN": "token", "GITHUB_API_URL": "https://api.example/"}

    def test_writes_the_released_commit_to_the_step_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            output.write_text("earlier=1\n", encoding="utf-8")
            with mock.patch.object(idle, "fetch_runs", return_value=[run("completed", "success")]) as fetch, \
                    mock.patch("sys.stdout", io.StringIO()) as stdout:
                code = idle.main(["--github-output", str(output)], self.environ)
            self.assertEqual(code, 0)
            self.assertEqual(output.read_text(encoding="utf-8"), f"earlier=1\nrelease_sha={SHA_A}\n")
            self.assertEqual(stdout.getvalue().strip(), SHA_A)
            fetch.assert_called_once_with("https://api.example", "owner/repo", "token")

    def test_prints_without_an_output_file(self):
        with mock.patch.object(idle, "fetch_runs", return_value=[run("completed", "success")]), \
                mock.patch("sys.stdout", io.StringIO()) as stdout:
            self.assertEqual(idle.main([], self.environ), 0)
        self.assertEqual(stdout.getvalue().strip(), SHA_A)

    def test_fails_closed_without_configuration_or_on_errors(self):
        cases = [
            ([], {"GITHUB_TOKEN": "token"}),
            ([], {"GITHUB_REPOSITORY": "owner/repo"}),
            ([], {"GITHUB_REPOSITORY": "not a repo", "GITHUB_TOKEN": "token"}),
            (["--poll-seconds", "0"], self.environ),
            (["--max-wait-seconds", "9000"], self.environ),
        ]
        for argv, environ in cases:
            with self.subTest(argv=argv, environ=environ), mock.patch("sys.stderr", io.StringIO()) as stderr:
                self.assertEqual(idle.main(argv, environ), 2)
                self.assertIn("release wait failed closed", stderr.getvalue())
        with mock.patch.object(idle, "fetch_runs", side_effect=OSError("network")), \
                mock.patch("sys.stderr", io.StringIO()) as stderr:
            self.assertEqual(idle.main([], self.environ), 2)
        self.assertIn("network", stderr.getvalue())

    def test_reads_the_process_environment_by_default(self):
        with mock.patch.dict("os.environ", {"GITHUB_REPOSITORY": "", "GITHUB_TOKEN": ""}), \
                mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(idle.main([]), 2)


if __name__ == "__main__":
    unittest.main()
