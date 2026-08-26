from __future__ import annotations

import hashlib
import pathlib
import sys
import unittest


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
        "images": [{"rawKey": RAW_KEY}],
    }
    value.update(changes)
    return value


def metadata(**changes):
    value = {
        "albumId": ALBUM_ID,
        "mediaId": MEDIA_ID,
        "status": "ready",
        "exploreVersion": 2,
        "colorFamilies": ["blue"],
        "lens": "Test Lens",
        "lensKey": "test lens",
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
        self.marker = None

    def batch_writer(self, **_kwargs):
        return self.batch

    def put_item(self, *, Item):
        self.marker = Item


class ExploreIndexBackfillTests(unittest.TestCase):
    def test_desired_inventory_indexes_only_current_public_manifest_media(self):
        desired, counts = backfill.desired_records(
            [album(), album(albumId="22222222-2222-4222-8222-222222222222", visibility="private")],
            [metadata(), metadata(albumId="22222222-2222-4222-8222-222222222222")],
        )
        record_types = [item["recordType"] for item in desired.values()]
        self.assertEqual(record_types.count(backfill.INDEX_RECORD_TYPE), 2)
        self.assertEqual(record_types.count(backfill.FACET_RECORD_TYPE), 1)
        self.assertEqual(record_types.count(backfill.READY_RECORD_TYPE), 1)
        self.assertEqual(counts["indexedPhotoCount"], 1)
        self.assertEqual(counts["eligiblePublicPhotoAlbumCount"], 1)

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
        self.assertEqual(table.marker["recordType"], backfill.READY_RECORD_TYPE)


if __name__ == "__main__":
    unittest.main()
