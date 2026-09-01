from __future__ import annotations

import hashlib
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch


OPS_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(OPS_DIR) not in sys.path:
    sys.path.insert(0, str(OPS_DIR))

import backfill_explore_metadata as explore
import backfill_preview_v3 as previews


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
RAW_KEY = f"albums/{ALBUM_ID}/original/photo.jpg"


def encoded(value):
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, int):
        return {"N": str(value)}
    if isinstance(value, list):
        return {"L": [encoded(item) for item in value]}
    if isinstance(value, dict):
        return {"M": {key: encoded(item) for key, item in value.items()}}
    raise TypeError(value)


def record(**values):
    return {key: encoded(value) for key, value in values.items()}


def album(**overrides):
    values = {
        "albumId": ALBUM_ID,
        "type": "photo",
        "status": "active",
        "images": [{"rawKey": RAW_KEY}],
    }
    values.update(overrides)
    return record(**values)


def metadata(**overrides):
    values = {
        "albumId": ALBUM_ID,
        "mediaId": hashlib.sha256(RAW_KEY.encode()).hexdigest()[:24],
        "previewVersion": previews.PREVIEW_VERSION,
        "status": "ready",
    }
    values.update(overrides)
    return record(**values)


class ExploreBackfillTests(unittest.TestCase):
    def test_plan_queues_only_ready_v3_records_missing_explore_fields(self):
        jobs, counts = explore.build_explore_plan([album()], [metadata()])
        self.assertEqual(jobs, [{"albumId": ALBUM_ID, "rawKey": RAW_KEY, "previewVersion": 3}])
        self.assertEqual(counts["plannedJobCount"], 1)

        complete = metadata(
            exploreVersion=2,
            palette=["#112233"],
            colorFamilies=["blue"],
            lens="Test Lens",
            lensKey="test lens",
            exposureBuckets=[],
            temporalVersion=1,
            timeOfDayBucket="morning",
            seasonBucket="autumn",
        )
        jobs, counts = explore.build_explore_plan([album()], [complete])
        self.assertEqual(jobs, [])
        self.assertEqual(counts["alreadyCompleteCount"], 1)

        partial_temporal = metadata(
            exploreVersion=2,
            palette=["#112233"],
            colorFamilies=["blue"],
            lens="Test Lens",
            lensKey="test lens",
            exposureBuckets=[],
            temporalVersion=1,
            timeOfDayBucket="morning",
            seasonBucket="",
        )
        jobs, _ = explore.build_explore_plan([album()], [partial_temporal])
        self.assertEqual(len(jobs), 1)

        malformed = metadata(
            exploreVersion=2,
            palette=["not-a-color"],
            colorFamilies=["ultraviolet"],
            lens="Test Lens",
            lensKey="wrong lens",
        )
        jobs, counts = explore.build_explore_plan([album()], [malformed])
        self.assertEqual(len(jobs), 1)
        self.assertEqual(counts["alreadyCompleteCount"], 0)

    def test_plan_skips_nonphoto_inactive_malformed_and_nonready_inventory(self):
        albums = [
            album(type="video"),
            album(status="deleting"),
            record(albumId="bad", type="photo", status="active", images=[]),
            album(images=[{"rawKey": RAW_KEY}, {"rawKey": RAW_KEY}, {}]),
        ]
        jobs, counts = explore.build_explore_plan(albums, [metadata(status="pending")])
        self.assertEqual(jobs, [])
        self.assertEqual(counts["nonPhotoAlbumSkippedCount"], 1)
        self.assertEqual(counts["inactiveAlbumSkippedCount"], 1)
        self.assertEqual(counts["malformedAlbumCount"], 1)
        self.assertEqual(counts["previewNotReadyCount"], 1)
        self.assertEqual(counts["duplicateManifestMediaCount"], 1)
        self.assertEqual(counts["malformedMediaCount"], 1)

    def test_plan_digest_is_deterministic_and_content_bound(self):
        jobs = [{"albumId": ALBUM_ID, "rawKey": RAW_KEY, "previewVersion": 3}]
        self.assertEqual(explore.plan_digest(jobs), explore.plan_digest(list(jobs)))
        self.assertNotEqual(explore.plan_digest(jobs), explore.plan_digest([]))

    def test_main_binds_apply_to_account_count_and_digest_before_dispatch(self):
        jobs = [{"albumId": ALBUM_ID, "rawKey": RAW_KEY, "previewVersion": 3}]
        base_args = [
            "backfill_explore_metadata.py",
            "--stack-name", "ian-website",
            "--apply",
            "--confirm-stack-name", "ian-website",
            "--confirm", explore.CONFIRMATION,
            "--expected-plan-digest", "reviewed-digest",
        ]
        dispatch = Mock(return_value=1)
        with patch.object(explore, "aws_json", return_value={"Account": "123456789012"}), patch.object(
            explore, "stack_resource", return_value="resource"
        ), patch.object(explore, "scan_all", return_value=[]), patch.object(
            explore, "build_explore_plan", return_value=(jobs, {"plannedJobCount": 1})
        ), patch.object(explore, "plan_digest", return_value="reviewed-digest"), patch.object(
            explore, "dispatch_jobs", dispatch
        ):
            with patch.object(sys, "argv", base_args + [
                "--expected-account-id", "000000000000", "--expected-job-count", "1",
            ]), self.assertRaisesRegex(SystemExit, "account-id"):
                explore.main()
            with patch.object(sys, "argv", base_args + [
                "--expected-account-id", "123456789012", "--expected-job-count", "2",
            ]), self.assertRaisesRegex(SystemExit, "job-count"):
                explore.main()
            with patch.object(sys, "argv", base_args + [
                "--expected-account-id", "123456789012", "--expected-job-count", "1",
            ]):
                self.assertEqual(explore.main(), 0)
        dispatch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
