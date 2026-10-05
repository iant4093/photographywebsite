import datetime as dt
import io
import json
import unittest
from unittest.mock import MagicMock, patch

import test_support  # noqa: F401  (sets the function environment)
import capture_calendar
import media_helpers
import photography_stats
from test_photography_stats import drive_report


class FakeTable:
    def __init__(self, items=None):
        self.items = dict(items or {})
        self.puts = []

    def get_item(self, Key):
        item = self.items.get(Key["cacheKey"])
        return {"Item": item} if item is not None else {}

    def put_item(self, Item):
        self.puts.append(Item)
        self.items[Item["cacheKey"]] = Item


def photo(key, **exif):
    return {"rawKey": key, **({"exif": exif} if exif else {})}


class CaptureDayParsingTests(unittest.TestCase):
    def test_reads_only_real_calendar_days(self):
        self.assertEqual(capture_calendar.exif_day("2026:09:12 18:40:03"), "2026-09-12")
        self.assertEqual(capture_calendar.exif_day(" 2026:09:12T18:40:03 "), "2026-09-12")
        for value in ("0000:00:00 00:00:00", "2026:02:30 10:00:00", "1985:01:01 10:00:00", "", None, "soon"):
            with self.subTest(value=value):
                self.assertIsNone(capture_calendar.exif_day(value))
        tomorrow_plus = (dt.date.today() + dt.timedelta(days=5)).strftime("%Y:%m:%d 10:00:00")
        self.assertIsNone(capture_calendar.exif_day(tomorrow_plus))
        self.assertEqual(capture_calendar.iso_day("2026-08-07T12:00:00Z"), "2026-08-07")
        self.assertIsNone(capture_calendar.iso_day(None))
        self.assertIsNone(capture_calendar.iso_day("August"))

    def test_prefers_the_original_capture_tag(self):
        tags = {"Image DateTime": "2026:09:14 09:00:00", "EXIF DateTimeOriginal": "2026:09:12 08:00:00"}
        self.assertEqual(capture_calendar.day_from_tags(tags), "2026-09-12")
        self.assertEqual(capture_calendar.day_from_tags({"EXIF DateTimeOriginal": "0000:00:00 00:00:00", "Image DateTime": "2026:09:14 09:00:00"}), "2026-09-14")
        self.assertIsNone(capture_calendar.day_from_tags({}))

    def test_reads_just_the_header_of_the_original(self):
        s3 = MagicMock()
        s3.get_object.return_value = {"Body": io.BytesIO(b"header")}
        with patch("exifread.process_file", return_value={"EXIF DateTimeOriginal": "2026:09:12 08:00:00"}):
            self.assertEqual(capture_calendar.read_capture_day(s3, "bucket", "albums/a/one.jpg"), "2026-09-12")
        s3.get_object.assert_called_once_with(Bucket="bucket", Key="albums/a/one.jpg", Range="bytes=0-65535")
        with patch("exifread.process_file", return_value={}):
            self.assertEqual(capture_calendar.read_capture_day(s3, "bucket", "albums/a/one.jpg"), "")

    def test_new_uploads_record_only_the_day(self):
        s3 = MagicMock()
        s3.get_object.return_value = {"Body": io.BytesIO(b"header")}
        tags = {"Image Model": "Canon EOS R7", "EXIF DateTimeOriginal": "2026:09:12 08:15:00"}
        with patch.object(media_helpers, "get_s3_client", return_value=s3), \
                patch.object(media_helpers.exifread, "process_file", return_value=tags):
            exif = media_helpers.extract_exif_data("bucket", "albums/a/one.jpg")
        self.assertEqual(exif, {"model": "Canon EOS R7", "takenOn": "2026-09-12"})


class PhotoDaysTests(unittest.TestCase):
    def test_uses_recorded_then_cached_days_and_reads_the_rest_once(self):
        cached_key = capture_calendar.cache_id("albums/a/cached.jpg")
        undated_key = capture_calendar.cache_id("albums/a/undated.jpg")
        table = FakeTable({
            "capture-dates-v1#a": {"cacheKey": "capture-dates-v1#a", "days": {cached_key: "2026-09-10", undated_key: "", "junk": "Tuesday"}},
        })
        albums = [
            {"albumId": "a", "images": [
                photo("albums/a/recorded.jpg", takenOn="2026-09-09"),
                photo("albums/a/cached.jpg"),
                photo("albums/a/undated.jpg"),
                photo("albums/a/new.jpg"),
                photo("albums/a/broken.jpg"),
                "albums/a/legacy-string.jpg",
                {"exif": "not a dict"},
            ]},
            {"albumId": "b", "images": []},
            {"images": [photo("albums/x/no-id.jpg")]},
        ]
        reads = []

        def read(_s3, bucket, key):
            reads.append(key)
            if key.endswith("broken.jpg"):
                raise RuntimeError("denied")
            return "" if key.endswith("legacy-string.jpg") else "2026-09-11"

        days = capture_calendar.photo_days(albums, table, s3=object(), bucket="bucket", read=read)
        self.assertEqual(days, {"a": ["2026-09-09", "2026-09-10", None, "2026-09-11", None, None, None]})
        self.assertEqual(sorted(reads), ["albums/a/broken.jpg", "albums/a/legacy-string.jpg", "albums/a/new.jpg"])
        stored = table.puts[-1]["days"]
        self.assertEqual(stored[capture_calendar.cache_id("albums/a/new.jpg")], "2026-09-11")
        self.assertEqual(stored[capture_calendar.cache_id("albums/a/legacy-string.jpg")], "")
        # A failed read is retried on a later run, and junk cache entries are dropped.
        self.assertNotIn(capture_calendar.cache_id("albums/a/broken.jpg"), stored)
        self.assertNotIn("junk", stored)

        reads.clear()
        table.puts.clear()
        capture_calendar.photo_days(albums, table, s3=object(), bucket="bucket", read=read)
        self.assertEqual(reads, ["albums/a/broken.jpg"])
        self.assertEqual(table.puts, [])

    def test_stops_reading_at_the_time_budget(self):
        table = FakeTable()
        albums = [{"albumId": "a", "images": [photo(f"albums/a/{index}.jpg") for index in range(3)]}]
        now = [0]

        def clock():
            now[0] += capture_calendar.READ_BUDGET_SECONDS
            return now[0]

        with patch.object(capture_calendar, "READ_WORKERS", 1):
            days = capture_calendar.photo_days(albums, table, s3=object(), bucket="bucket", clock=clock, read=lambda *_: "2026-09-11")
        self.assertEqual(days["a"].count("2026-09-11"), 1)

    def test_without_storage_access_counts_only_what_is_known(self):
        table = FakeTable()
        with patch.dict("os.environ", {"IMAGES_BUCKET": ""}):
            days = capture_calendar.photo_days([{"albumId": "a", "images": [photo("albums/a/one.jpg")]}], table)
        self.assertEqual(days, {"a": [None]})
        self.assertEqual(table.puts, [])

    def test_a_failed_cache_write_still_returns_the_days(self):
        table = FakeTable()
        table.put_item = MagicMock(side_effect=RuntimeError("throttled"))
        days = capture_calendar.photo_days(
            [{"albumId": "a", "images": [photo("albums/a/one.jpg")]}], table,
            s3=object(), bucket="bucket", read=lambda *_: "2026-09-11",
        )
        self.assertEqual(days, {"a": ["2026-09-11"]})


class CalendarSnapshotTests(unittest.TestCase):
    albums = [
        {"albumId": "trip", "visibility": "public", "type": "photo", "createdAt": "2026-09-10T00:00:00Z",
         "images": [{}, {}, {}, {}]},
        {"albumId": "walk", "visibility": "public", "type": "photo", "createdAt": "2026-09-12", "images": [{}]},
        {"albumId": "reel", "visibility": "public", "type": "video", "createdAt": "2026-09-12", "images": [{}, {}]},
        {"albumId": "legacy", "visibility": "public", "type": "photo", "createdAt": "2025-01-05", "imageCount": 2},
        {"albumId": "secret", "visibility": "private", "type": "photo", "createdAt": "2026-09-12", "images": [{}]},
        {"albumId": "undated", "visibility": "public", "type": "photo", "createdAt": "", "images": [{}]},
        {"visibility": "public", "type": "photo", "createdAt": "2026-09-12", "images": [{}]},
    ]

    def test_counts_each_day_from_capture_days_with_album_dates_as_fallback(self):
        photo_days = {"trip": ["2026-09-10", "2026-09-11", "2026-09-12", None], "walk": ["2026-09-12"]}
        calendar = photography_stats._calendar(self.albums, photo_days)
        albums = calendar["albums"]
        named = [[day, photos, videos, [albums[index] for index in refs]] for day, photos, videos, refs in calendar["days"]]
        self.assertEqual(named, [
            ["2025-01-05", 2, 0, ["legacy"]],
            ["2026-09-10", 2, 0, ["trip"]],
            ["2026-09-11", 1, 0, ["trip"]],
            ["2026-09-12", 2, 2, ["reel", "trip", "walk"]],
        ])
        self.assertNotIn("secret", albums)
        self.assertTrue(photography_stats._valid_calendar(calendar))

    def test_snapshots_validate_the_calendar_but_accept_older_ones_without_it(self):
        snapshot = photography_stats._build_snapshot(drive_report(), self.albums, generated_at="2026-09-13T10:00:00Z")
        self.assertTrue(photography_stats._valid_snapshot(snapshot))
        self.assertEqual(snapshot["calendar"]["days"][-1][0], "2026-09-12")
        older = {key: value for key, value in snapshot.items() if key != "calendar"}
        self.assertTrue(photography_stats._valid_snapshot(older))
        for broken in (
            None,
            {"albums": [], "days": {}},
            {"albums": [1], "days": []},
            {"albums": ["a"], "days": [["2026-13-01", 1, 0, [0]]]},
            {"albums": ["a"], "days": [["2026-09-12", -1, 0, [0]]]},
            {"albums": ["a"], "days": [["2026-09-12", 1, 0, [1]]]},
            {"albums": ["a"], "days": [["2026-09-12", 1, 0, [True]]]},
            {"albums": ["a"], "days": [["2026-09-12", 1, 0]]},
        ):
            with self.subTest(calendar=broken):
                self.assertFalse(photography_stats._valid_snapshot({**snapshot, "calendar": broken}))

    def test_refresh_passes_public_photo_albums_and_survives_a_calendar_failure(self):
        drive_item = {"Item": {"payload": json.dumps(drive_report())}}
        with patch.object(photography_stats.cache_table, "get_item", return_value=drive_item), \
                patch.object(photography_stats, "_scan_albums", return_value=self.albums), \
                patch.object(photography_stats.cache_table, "put_item", return_value={}) as put_item, \
                patch.object(photography_stats.capture_calendar, "photo_days", return_value={"walk": ["2026-09-01"]}) as photo_days:
            snapshot = photography_stats.refresh_photography_stats()
        passed = [album["albumId"] for album in photo_days.call_args.args[0] if "albumId" in album]
        self.assertEqual(passed, ["trip", "walk", "legacy", "undated"])
        self.assertIn("2026-09-01", [row[0] for row in snapshot["calendar"]["days"]])
        self.assertTrue(photography_stats._valid_snapshot(json.loads(put_item.call_args.kwargs["Item"]["payload"])))

        with patch.object(photography_stats.cache_table, "get_item", return_value=drive_item), \
                patch.object(photography_stats, "_scan_albums", return_value=self.albums), \
                patch.object(photography_stats.cache_table, "put_item", return_value={}), \
                patch.object(photography_stats.capture_calendar, "photo_days", side_effect=RuntimeError("s3 down")):
            snapshot = photography_stats.refresh_photography_stats()
        # Without capture days, every photo counts on its album's date.
        by_day = {row[0]: row[1:3] for row in snapshot["calendar"]["days"]}
        self.assertEqual(by_day["2026-09-10"], [4, 0])
        self.assertEqual(by_day["2026-09-12"], [1, 2])

    def test_a_larger_snapshot_still_round_trips_through_the_cache(self):
        days = [[(dt.date(2020, 1, 1) + dt.timedelta(days=index)).isoformat(), 5, 0, [0]] for index in range(1500)]
        snapshot = {**photography_stats._build_snapshot(drive_report(), [], generated_at="2026-09-13T10:00:00Z"),
                    "calendar": {"albums": ["a" * 36], "days": days}}
        with patch.object(photography_stats.cache_table, "put_item", return_value={}) as put_item:
            photography_stats._store_snapshot(snapshot)
        stored = put_item.call_args.kwargs["Item"]
        self.assertGreater(len(stored["payload"]), photography_stats.MAX_CACHE_PAYLOAD_BYTES // 3)
        with patch.object(photography_stats.cache_table, "get_item", return_value={"Item": stored}):
            self.assertEqual(len(photography_stats._read_snapshot()["calendar"]["days"]), 1500)


if __name__ == "__main__":
    unittest.main()
