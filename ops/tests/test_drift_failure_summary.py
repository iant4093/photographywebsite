import io
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ops.ci import drift_failure_summary

ROOT = Path(__file__).resolve().parents[2]
REASON = (
    "Failed to detect drift on resources [ConfigDeliveryBucket, NotifierFunction]: "
    "User: arn:aws:sts::123456789012:assumed-role/ian-photography-github-production-audit/audit-1 "
    "is not authorized to perform: s3:GetBucketMetadataConfiguration on resource: "
    "arn:aws:s3:::secret-bucket-name (Service: S3, Status Code: 403, Request ID: ABC123); "
    "not authorized to perform: lambda:GetFunctionConcurrency"
)


class DriftFailureSummaryTests(unittest.TestCase):
    def test_names_resources_and_actions_but_never_provider_text(self):
        summary = drift_failure_summary.summarize(REASON)
        self.assertEqual(
            summary,
            "unchecked resources: ConfigDeliveryBucket, NotifierFunction; "
            "denied actions: s3:GetBucketMetadataConfiguration, lambda:GetFunctionConcurrency",
        )
        for leaked in ("123456789012", "secret-bucket-name", "audit-1", "ABC123", "arn:"):
            self.assertNotIn(leaked, summary)

    def test_unhelpful_or_hostile_reasons_stay_generic(self):
        self.assertEqual(drift_failure_summary.summarize(""), "unchecked resources: not named")
        self.assertEqual(
            drift_failure_summary.summarize("[not a logical id, <script>, a b] arn:aws:iam::1:role/x"),
            "unchecked resources: not named",
        )
        many = "[" + ", ".join(f"Resource{index}" for index in range(40)) + "]"
        self.assertEqual(drift_failure_summary.summarize(many).count("Resource"), 20)

    def test_command_reads_stdin(self):
        with patch("sys.stdin", io.StringIO(REASON)), patch("sys.stdout", new_callable=io.StringIO) as out:
            self.assertEqual(drift_failure_summary.main(), 0)
        self.assertTrue(out.getvalue().startswith("unchecked resources: ConfigDeliveryBucket"))


class WaitForDriftMessageTests(unittest.TestCase):
    def run_wait(self, status_line, reason=REASON):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "aws"
            fake.write_text(
                "#!/usr/bin/env bash\n"
                'case "$*" in\n'
                f"  *DetectionStatusReason*) printf '%s\\n' {reason!r} ;;\n"
                f"  *) printf '{status_line}\\n' ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            env = os.environ | {
                "PATH": f"{directory}:{os.environ['PATH']}",
                "AWS_REGION": "us-west-2",
                "DRIFT_DETECTION_ID": "11111111-1111-1111-1111-111111111111",
                "STACK_NAME": "ian-photography-security-managed",
            }
            return subprocess.run(
                [str(ROOT / "ops" / "ci" / "wait_for_drift.sh")],
                cwd=ROOT, env=env, text=True, capture_output=True, check=False,
            )

    def test_failed_detection_names_the_stack_resources_and_denied_actions(self):
        result = self.run_wait("DETECTION_FAILED\\tUNKNOWN")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(
            result.stderr.strip(),
            "Stack drift detection failed closed for ian-photography-security-managed "
            "(unchecked resources: ConfigDeliveryBucket, NotifierFunction; "
            "denied actions: s3:GetBucketMetadataConfiguration, lambda:GetFunctionConcurrency).",
        )

    def test_drifted_stack_is_named(self):
        result = self.run_wait("DETECTION_COMPLETE\\tDRIFTED")
        self.assertEqual(result.returncode, 2)
        self.assertIn("ian-photography-security-managed is DRIFTED", result.stderr)
        self.assertEqual(self.run_wait("DETECTION_COMPLETE\\tIN_SYNC").returncode, 0)


if __name__ == "__main__":
    unittest.main()
