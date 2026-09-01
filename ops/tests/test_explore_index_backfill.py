from __future__ import annotations

import hashlib
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch


OPS_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(OPS_DIR) not in sys.path:
    sys.path.insert(0, str(OPS_DIR))

import backfill_explore_index as backfill


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
RAW_KEY = f"albums/{ALBUM_ID}/original/photo.jpg"
MEDIA_ID = hashlib.sha256(RAW_KEY.encode()).hexdigest()[:24]


def album(**changes):
    value = {
        "albumId": ALBUM_ID,
        "status": "active",
        "visibility": "public",
        "type": "photo",
        "images": [{
            "rawKey": RAW_KEY,
            "exif": {
                "focalRatio": "f/2.8", "shutterSpeed": "1/500s",
                "iso": "ISO 400", "focalLength": "400mm",
            },
        }],
    }
    value.update(changes)
    return value


def metadata(**changes):
    value = {
        "albumId": ALBUM_ID,
        "mediaId": MEDIA_ID,
        "status": "ready",
        "previewVersion": 3,
        "exploreVersion": 2,
        "colorFamilies": ["blue"],
        "lens": "Test Lens",
        "lensKey": "test lens",
        "temporalVersion": 1,
        "timeOfDayBucket": "morning",
        "seasonBucket": "autumn",
    }
    value.update(changes)
    return value


class FakeBatch:
    def __init__(self):
        self.puts = []
        self.deletes = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def put_item(self, *, Item):
        self.puts.append(Item)

    def delete_item(self, *, Key):
        self.deletes.append(Key)


class FakeTable:
    def __init__(self):
        self.batch = FakeBatch()
        self.markers = []

    def batch_writer(self, **_kwargs):
        return self.batch

    def put_item(self, *, Item):
        self.markers.append(Item)


class FakeScanTable:
    def __init__(self, pages):
        self.pages = list(pages)
        self.requests = []

    def scan(self, **request):
        self.requests.append(request)
        return self.pages.pop(0)


class ExploreIndexBackfillTests(unittest.TestCase):
    def test_scan_table_paginates_and_rejects_malformed_or_repeated_pages(self):
        table = FakeScanTable([
            {"Items": [{"value": 1}, "ignored"], "LastEvaluatedKey": {"cursor": "next"}},
            {"Items": [{"value": 2}]},
        ])
        self.assertEqual(backfill.scan_table(table), [{"value": 1}, {"value": 2}])
        self.assertEqual(table.requests[1], {"ExclusiveStartKey": {"cursor": "next"}})

        with self.assertRaisesRegex(RuntimeError, "malformed Items"):
            backfill.scan_table(FakeScanTable([{"Items": {}}]))
        with self.assertRaisesRegex(RuntimeError, "pagination token repeated"):
            backfill.scan_table(FakeScanTable([
                {"Items": [], "LastEvaluatedKey": {"cursor": "same"}},
                {"Items": [], "LastEvaluatedKey": {"cursor": "same"}},
            ]))

    def test_raw_key_and_missing_metadata_are_fail_closed(self):
        self.assertEqual(backfill._raw_key(None), "")
        self.assertEqual(backfill._raw_key({"key": RAW_KEY}), RAW_KEY)
        self.assertEqual(backfill._raw_key({"rawKey": 7}), "")

        desired, counts = backfill.desired_records(
            [album(images=[{"rawKey": RAW_KEY}, None, {}])],
            [metadata(exploreVersion=1, colorFamilies=[], lens="", lensKey="")],
        )
        self.assertEqual(counts["missingExploreMetadataCount"], 1)
        self.assertEqual(counts["missingTemporalMetadataCount"], 1)
        self.assertEqual(
            [item["recordType"] for item in desired.values()],
            [backfill.READY_RECORD_TYPE, backfill.READY_RECORD_TYPE],
        )

        _, missing_counts = backfill.desired_records([album()], [])
        self.assertEqual(missing_counts["missingExploreMetadataCount"], 1)
        self.assertEqual(missing_counts["missingTemporalMetadataCount"], 1)

        _, invalid_counts = backfill.desired_records(
            [album()],
            [metadata(timeOfDayBucket="golden-hour", seasonBucket="monsoon")],
        )
        self.assertEqual(invalid_counts["missingTemporalMetadataCount"], 1)

        _, partial_counts = backfill.desired_records(
            [album()],
            [metadata(seasonBucket="")],
        )
        self.assertEqual(partial_counts["missingTemporalMetadataCount"], 1)

    def test_desired_inventory_indexes_only_current_public_manifest_media(self):
        desired, counts = backfill.desired_records(
            [album(), album(albumId="22222222-2222-4222-8222-222222222222", visibility="private")],
            [metadata(), metadata(albumId="22222222-2222-4222-8222-222222222222")],
        )
        record_types = [item["recordType"] for item in desired.values()]
        self.assertEqual(record_types.count(backfill.INDEX_RECORD_TYPE), 8)
        self.assertEqual(record_types.count(backfill.FACET_RECORD_TYPE), 1)
        self.assertEqual(record_types.count(backfill.READY_RECORD_TYPE), 2)
        self.assertEqual(counts["indexedPhotoCount"], 1)
        self.assertEqual(counts["eligiblePublicPhotoAlbumCount"], 1)
        self.assertEqual(counts["temporalProcessedPhotoCount"], 1)
        self.assertEqual(counts["temporalClassifiedPhotoCount"], 1)
        self.assertEqual(counts["missingTemporalMetadataCount"], 0)

    def test_processed_undated_photos_create_no_invented_temporal_rows(self):
        desired, counts = backfill.desired_records(
            [album()],
            [metadata(timeOfDayBucket="", seasonBucket="")],
        )
        partitions = {item[0] for item in desired}
        self.assertFalse(any("#TIME#" in value or "#SEASON#" in value for value in partitions))
        self.assertEqual(counts["temporalProcessedPhotoCount"], 1)
        self.assertEqual(counts["temporalUndatedPhotoCount"], 1)

    def test_plan_removes_stale_rows_and_is_digest_bound(self):
        desired, _ = backfill.desired_records([album()], [metadata()])
        stale = {
            ("__EXPLORE_V1__#COLOR#red", "stale"): {
                "albumId": "__EXPLORE_V1__#COLOR#red",
                "mediaId": "stale",
                "recordType": backfill.INDEX_RECORD_TYPE,
            }
        }
        puts, deletes = backfill.build_plan(desired, stale)
        self.assertGreater(len(puts), 0)
        self.assertEqual(deletes, [{"albumId": "__EXPLORE_V1__#COLOR#red", "mediaId": "stale"}])
        self.assertEqual(backfill.plan_digest(puts, deletes), backfill.plan_digest(list(puts), list(deletes)))
        self.assertNotEqual(backfill.plan_digest(puts, deletes), backfill.plan_digest([], []))

    def test_apply_writes_marker_only_after_batch_operations(self):
        desired, _ = backfill.desired_records([album()], [metadata()])
        puts, deletes = backfill.build_plan(desired, {})
        table = FakeTable()
        backfill.apply_plan(table, puts, deletes)
        self.assertEqual(len(table.batch.puts), len(puts))
        self.assertEqual(
            [item["mediaId"] for item in table.markers],
            ["READY", "EXPOSURE_READY"],
        )
        self.assertTrue(all(item["recordType"] == backfill.READY_RECORD_TYPE for item in table.markers))

    def test_main_closes_cached_readers_before_writes_and_reopens_after_verification(self):
        events = []
        preview_table = Mock()
        preview_table.delete_item.side_effect = lambda **_kwargs: events.append("delete-marker")
        preview_table.put_item.side_effect = lambda **_kwargs: events.append("put-temporal-marker")
        preview_table.get_item.return_value = {"Item": backfill.temporal_ready_marker()}
        albums_table = Mock()
        dynamodb = Mock()
        dynamodb.Table.side_effect = lambda name: preview_table if name == "preview" else albums_table

        sts = Mock()
        sts.get_caller_identity.return_value = {"Account": "123456789012"}
        waiter = Mock()
        waiter.wait.side_effect = lambda **kwargs: events.append(f"wait-{kwargs['Id']}")
        cloudfront = Mock()
        cloudfront.create_invalidation.side_effect = [
            {"Invalidation": {"Id": "closed"}},
            {"Invalidation": {"Id": "ready"}},
        ]
        cloudfront.get_waiter.return_value = waiter
        session = Mock()
        session.client.side_effect = lambda name: {"sts": sts, "cloudfront": cloudfront}[name]
        session.resource.return_value = dynamodb
        inventory = {
            "missingTemporalMetadataCount": 0,
            "missingExploreMetadataCount": 0,
        }
        args = [
            "backfill_explore_index.py",
            "--stack-name", "ian-website",
            "--apply",
            "--expected-account-id", "123456789012",
            "--expected-put-count", "0",
            "--expected-delete-count", "0",
            "--expected-plan-digest", backfill.plan_digest([], []),
            "--confirm", backfill.CONFIRMATION,
        ]
        with patch.object(backfill.boto3, "Session", return_value=session), patch.object(
            backfill, "stack_resource", side_effect=lambda _stack, logical, *_args: {
                "AlbumsTable": "albums", "PreviewMetadataTable": "preview",
            }[logical]
        ), patch.object(backfill, "scan_table", return_value=[]), patch.object(
            backfill, "desired_records", return_value=({}, inventory)
        ), patch.object(backfill, "current_index_records", return_value={}), patch.object(
            backfill, "build_plan", return_value=([], [])
        ), patch.object(
            backfill, "apply_plan", side_effect=lambda *_args: events.append("apply-plan")
        ), patch.object(
            backfill.time, "sleep", side_effect=lambda _seconds: events.append("drain-readiness-cache")
        ), patch.object(sys, "argv", args):
            self.assertEqual(backfill.main(), 0)

        calls = cloudfront.create_invalidation.call_args_list
        self.assertIn("closed", calls[0].kwargs["InvalidationBatch"]["CallerReference"])
        self.assertIn("ready", calls[1].kwargs["InvalidationBatch"]["CallerReference"])
        self.assertLess(events.index("delete-marker"), events.index("drain-readiness-cache"))
        self.assertLess(events.index("wait-closed"), events.index("apply-plan"))
        self.assertLess(events.index("apply-plan"), events.index("put-temporal-marker"))
        self.assertLess(events.index("put-temporal-marker"), events.index("wait-ready"))


if __name__ == "__main__":
    unittest.main()
