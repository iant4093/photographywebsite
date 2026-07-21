import argparse
import json
import pathlib
import sys
import unittest
from unittest import mock


OPS_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(OPS_DIR) not in sys.path:
    sys.path.insert(0, str(OPS_DIR))

import backfill_preview_v2


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
RAW_KEY = f"albums/{ALBUM_ID}/original/photo.jpg"


def dynamo(value):
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, int):
        return {"N": str(value)}
    if isinstance(value, list):
        return {"L": [dynamo(item) for item in value]}
    if isinstance(value, dict):
        return {"M": {key: dynamo(item) for key, item in value.items()}}
    raise TypeError(value)


def record(**values):
    return {key: dynamo(value) for key, value in values.items()}


class PreviewBackfillTests(unittest.TestCase):
    def test_main_supports_a_deterministic_bounded_canary(self):
        jobs = [
            {
                "albumId": ALBUM_ID,
                "rawKey": f"albums/{ALBUM_ID}/original/photo-{index}.jpg",
                "previewVersion": 2,
            }
            for index in range(3)
        ]
        counts = {
            "albumRecordCount": 1,
            "previewMetadataRecordCount": 0,
            "plannedJobCount": 3,
            "conflictingMetadataCount": 0,
        }
        argv = [
            "backfill_preview_v2.py",
            "--stack-name",
            "ian-website",
            "--max-jobs",
            "2",
        ]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            backfill_preview_v2, "aws_json", return_value={"Account": "123"}
        ), mock.patch.object(
            backfill_preview_v2, "stack_resource", return_value="resource"
        ), mock.patch.object(
            backfill_preview_v2, "scan_all", side_effect=[[{}], []]
        ), mock.patch.object(
            backfill_preview_v2, "build_backfill_plan", return_value=(jobs, counts)
        ), mock.patch.object(
            backfill_preview_v2,
            "validate_source_heads",
            side_effect=lambda selected, *_args: (selected, 0),
        ) as validate_heads, mock.patch("builtins.print") as output:
            self.assertEqual(backfill_preview_v2.main(), 0)

        validate_heads.assert_called_once()
        self.assertEqual(validate_heads.call_args.args[0], jobs[:2])
        summary = json.loads(output.call_args_list[0].args[0])
        self.assertEqual(summary["requestedMaxJobs"], 2)
        self.assertEqual(summary["totalEligiblePlannedJobCount"], 3)
        self.assertEqual(summary["plannedJobCount"], 2)

    def test_main_rejects_a_nonpositive_canary_size_before_source_reads(self):
        argv = [
            "backfill_preview_v2.py",
            "--stack-name",
            "ian-website",
            "--max-jobs",
            "0",
        ]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            backfill_preview_v2, "aws_json", return_value={"Account": "123"}
        ), mock.patch.object(
            backfill_preview_v2, "stack_resource", return_value="resource"
        ), mock.patch.object(
            backfill_preview_v2, "scan_all", side_effect=[[{}], []]
        ), mock.patch.object(
            backfill_preview_v2, "build_backfill_plan", return_value=([], {"plannedJobCount": 0})
        ), mock.patch.object(backfill_preview_v2, "validate_source_heads") as validate_heads:
            with self.assertRaisesRegex(SystemExit, "positive integer"):
                backfill_preview_v2.main()
        validate_heads.assert_not_called()

    def test_plan_is_deterministic_and_skips_complete_external_metadata(self):
        album = record(
            albumId=ALBUM_ID,
            type="photo",
            status="active",
            visibility="private",
            images=[{"rawKey": RAW_KEY, "width": 3000, "height": 2000}],
        )
        jobs, counts = backfill_preview_v2.build_backfill_plan([album], [])
        self.assertEqual(jobs, [{"albumId": ALBUM_ID, "rawKey": RAW_KEY, "previewVersion": 2}])
        self.assertEqual(counts["plannedJobCount"], 1)
        self.assertEqual(backfill_preview_v2.plan_digest(jobs), backfill_preview_v2.plan_digest(list(jobs)))

        media_id = backfill_preview_v2.media_id_for_key(RAW_KEY)
        metadata = record(
            albumId=ALBUM_ID,
            mediaId=media_id,
            status="ready",
            previewVersion=2,
            previewKeys=backfill_preview_v2.expected_preview_keys(ALBUM_ID, RAW_KEY),
        )
        jobs, counts = backfill_preview_v2.build_backfill_plan([album], [metadata])
        self.assertEqual(jobs, [])
        self.assertEqual(counts["alreadyCompleteCount"], 1)

    def test_duplicate_manifest_media_produces_exactly_one_job(self):
        image = {"rawKey": RAW_KEY, "width": 3000, "height": 2000}
        album = record(
            albumId=ALBUM_ID,
            type="photo",
            status="active",
            visibility="private",
            images=[image, image],
        )

        jobs, counts = backfill_preview_v2.build_backfill_plan([album], [])

        self.assertEqual(jobs, [{"albumId": ALBUM_ID, "rawKey": RAW_KEY, "previewVersion": 2}])
        self.assertEqual(counts["plannedJobCount"], 1)
        self.assertEqual(counts["duplicateManifestMediaCount"], 1)

    def test_partial_or_conflicting_metadata_blocks_that_job(self):
        album = record(
            albumId=ALBUM_ID,
            visibility="public",
            images=[{"rawKey": RAW_KEY, "width": 2000}],
        )
        metadata = record(
            albumId=ALBUM_ID,
            mediaId=backfill_preview_v2.media_id_for_key(RAW_KEY),
            status="ready",
            previewVersion=2,
            previewKeys={"640": "albums/wrong.webp"},
        )
        jobs, counts = backfill_preview_v2.build_backfill_plan([album], [metadata])
        self.assertEqual(jobs, [])
        self.assertEqual(counts["conflictingMetadataCount"], 1)

    def test_apply_requires_every_exact_guard(self):
        counts = {
            "albumRecordCount": 1,
            "previewMetadataRecordCount": 0,
            "plannedJobCount": 1,
            "conflictingMetadataCount": 0,
            "sourceValidationFailureCount": 0,
        }
        args = argparse.Namespace(
            stack_name="photo-stack",
            expected_account_id="123",
            expected_record_count=1,
            expected_preview_record_count=0,
            expected_job_count=1,
            expected_plan_digest="digest",
            confirm_stack_name="photo-stack",
            confirm="wrong",
        )
        with self.assertRaises(SystemExit):
            backfill_preview_v2.validate_apply_guards(args, "123", counts, "digest")
        args.confirm = "backfill-preview-v2"
        backfill_preview_v2.validate_apply_guards(args, "123", counts, "digest")

    def test_dispatch_batches_at_ten_and_uses_deterministic_bodies(self):
        jobs = [
            {
                "albumId": ALBUM_ID,
                "rawKey": f"albums/{ALBUM_ID}/original/photo-{index:02d}.jpg",
                "previewVersion": 2,
            }
            for index in range(23)
        ]
        calls = []

        def send(arguments, profile, region):
            calls.append((arguments, profile, region))
            entries = json.loads(arguments[5])
            return {"Successful": [{"Id": entry["Id"]} for entry in entries], "Failed": []}

        with mock.patch.object(backfill_preview_v2, "aws_json", side_effect=send):
            dispatched = backfill_preview_v2.dispatch_jobs(jobs, "https://queue.example", "profile", "region")

        self.assertEqual(dispatched, 23)
        self.assertEqual([len(json.loads(call[0][5])) for call in calls], [10, 10, 3])
        self.assertTrue(all(call[0][:5] == [
            "sqs", "send-message-batch", "--queue-url", "https://queue.example", "--entries"
        ] for call in calls))
        first_entry = json.loads(calls[0][0][5])[0]
        self.assertEqual(first_entry["Id"], "job-00000000")
        self.assertEqual(json.loads(first_entry["MessageBody"]), jobs[0])

    def test_dispatch_stops_on_partial_batch_failure(self):
        jobs = [
            {
                "albumId": ALBUM_ID,
                "rawKey": f"albums/{ALBUM_ID}/original/photo-{index:02d}.jpg",
                "previewVersion": 2,
            }
            for index in range(11)
        ]
        response = {
            "Successful": [{"Id": f"job-{index:08d}"} for index in range(9)],
            "Failed": [{"Id": "job-00000009", "Code": "InternalError", "SenderFault": False}],
        }
        with mock.patch.object(backfill_preview_v2, "aws_json", return_value=response) as send:
            with self.assertRaisesRegex(RuntimeError, "InternalError"):
                backfill_preview_v2.dispatch_jobs(jobs, "https://queue.example", None, "region")
        send.assert_called_once()

    def test_dispatch_zero_jobs_does_not_call_sqs(self):
        with mock.patch.object(backfill_preview_v2, "aws_json") as send:
            self.assertEqual(backfill_preview_v2.dispatch_jobs([], "https://queue.example", None, None), 0)
        send.assert_not_called()

    def test_dispatch_rejects_duplicate_jobs_before_calling_sqs(self):
        job = {"albumId": ALBUM_ID, "rawKey": RAW_KEY, "previewVersion": 2}
        with mock.patch.object(backfill_preview_v2, "aws_json") as send:
            with self.assertRaisesRegex(ValueError, "duplicate"):
                backfill_preview_v2.dispatch_jobs([job, dict(job)], "https://queue.example", None, None)
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
