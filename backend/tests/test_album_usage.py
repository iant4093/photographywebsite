"""Per-album storage and bandwidth, and next month's cost forecast."""

import datetime as dt
import gzip
import json
import os
import unittest
from unittest.mock import Mock, patch

import boto3
from moto import mock_aws

import test_support  # noqa: F401  (adds backend/functions to sys.path)

import album_usage
import get_cost_report


A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
C = "33333333-3333-4333-8333-333333333333"
DIST = "E2EXAMPLE"
TODAY = dt.date(2026, 10, 5)
FIELDS = "#Fields: date time x-edge-location sc-bytes c-ip cs-method cs(Host) cs-uri-stem sc-status\n"


def log_line(path, sent):
    return f"2026-10-01\t10:00:00\tSEA19\t{sent}\t198.51.100.7\tGET\tmedia.example\t{path}\t200\n"


def log(*entries):
    return gzip.compress(("#Version: 1.0\n" + FIELDS + "".join(log_line(*entry) for entry in entries)).encode())


class LogParsingTests(unittest.TestCase):
    def test_bytes_are_attributed_to_albums_and_nothing_else_is_kept(self):
        lines = (FIELDS + log_line(f"/albums/{A}/original/x_hls/v2/x_1080p.ts", 1000)
                 + log_line(f"/public-previews/{A}/v3/abc-w640.webp", 50)
                 + log_line(f"/albums/{B}/thumbnail/b.jpg", 7)
                 + log_line("/site/hero/reel.m3u8", 300)
                 + "2026-10-01\t10:00:00\tSEA19\t-\t198.51.100.7\tGET\th\t/albums/x\t304\n"
                 + "\n#comment\n").splitlines()
        totals = album_usage.parse_log(lines, {})
        self.assertEqual(totals, {A: 1050, B: 7, album_usage.OTHER: 300})
        self.assertNotIn("198.51.100.7", json.dumps(totals))
        # Lines before a #Fields header cannot be read and are skipped.
        self.assertEqual(album_usage.parse_log([log_line("/albums/x", 5)], {}), {})


class SummaryTests(unittest.TestCase):
    def test_top_albums_by_storage_and_bandwidth_carry_labels(self):
        storage = {A: 500, B: 900, C: 10, album_usage.OTHER: 4}
        bandwidth = {A: 8000, C: 0, album_usage.OTHER: 100, "44444444-4444-4444-8444-444444444444": 3}
        labels = {A: {"title": "Coast", "type": "photo", "visibility": "public", "deleted": False},
                  B: {"title": "Film", "type": "video", "visibility": "private", "deleted": False}}
        now = dt.datetime(2026, 10, 5, 6, tzinfo=dt.timezone.utc)
        summary = album_usage.build_summary(storage, {A: 3, B: 2}, bandwidth, labels, first=dt.date(2026, 9, 4),
                                            last=dt.date(2026, 10, 3), days=30, now=now)
        self.assertEqual([row["albumId"] for row in summary["byStorage"]], [B, A, C, "44444444-4444-4444-8444-444444444444"])
        self.assertEqual([row["albumId"] for row in summary["byBandwidth"]], [A, "44444444-4444-4444-8444-444444444444"])
        self.assertEqual(summary["byStorage"][0], {
            "albumId": B, "title": "Film", "type": "video", "visibility": "private", "deleted": False,
            "storageBytes": 900, "objectCount": 2, "bandwidthBytes": 0,
        })
        self.assertEqual(summary["byBandwidth"][1]["title"], "Removed album")
        self.assertEqual((summary["storageBytes"], summary["bandwidthBytes"], summary["otherBandwidthBytes"]), (1414, 8103, 100))
        self.assertEqual(summary["albumCount"], 4)
        self.assertEqual(summary["bandwidthWindow"], {"from": "2026-09-04", "to": "2026-10-03", "days": 30})
        self.assertEqual(summary["generatedAt"], "2026-10-05T06:00:00Z")

    def test_the_cost_report_reads_only_a_valid_summary(self):
        table = Mock()
        for payload, expected in (
            (json.dumps({"kind": "album-usage", "schemaVersion": 1, "x": 1}), True),
            (json.dumps({"kind": "album-usage", "schemaVersion": 2}), False),
            (json.dumps({"schemaVersion": 1}), False),
            ("{", False), (None, False),
        ):
            with self.subTest(payload=payload):
                table.get_item.return_value = {"Item": {"payload": payload}} if payload is not None else {}
                self.assertEqual(album_usage.load_summary(table) is not None, expected)


class UsageRunTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock_aws())
        self.enterContext(patch.dict(os.environ, {
            "COST_REPORT_CACHE_TABLE": "cost-cache", "ALBUMS_TABLE": "albums-usage", "IMAGES_BUCKET": "images-usage",
            "MEDIA_LOGS_BUCKET": "logs-usage", "IMAGES_DISTRIBUTION_ID": DIST,
        }))
        self.enterContext(patch.object(album_usage, "_s3", None))
        self.enterContext(patch.object(album_usage, "_dynamodb", None))
        db = boto3.resource("dynamodb", region_name="us-west-2")
        self.cache = db.create_table(TableName="cost-cache", KeySchema=[{"AttributeName": "cacheKey", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "cacheKey", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST")
        albums = db.create_table(TableName="albums-usage", KeySchema=[{"AttributeName": "albumId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "albumId", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST")
        albums.put_item(Item={"albumId": A, "title": "Coast", "type": "photo", "visibility": "public", "images": ["x" * 2000]})
        albums.put_item(Item={"albumId": B, "title": "Film", "type": "video", "visibility": "unlisted", "trashedAt": "2026-10-01T00:00:00Z"})
        albums.put_item(Item={"albumId": "__USER_DELETION__x", "status": "internal"})
        albums.put_item(Item={"albumId": C, "visibility": "secret"})
        s3 = boto3.client("s3", region_name="us-west-2")
        for bucket in ("images-usage", "logs-usage"):
            s3.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": "us-west-2"})
        s3.put_object(Bucket="images-usage", Key=f"albums/{A}/original/a.jpg", Body=b"x" * 300)
        s3.put_object(Bucket="images-usage", Key=f"albums/{A}/thumbnail/a.jpg", Body=b"x" * 20)
        s3.put_object(Bucket="images-usage", Key=f"albums/{B}/original/b.mp4", Body=b"x" * 900)
        s3.put_object(Bucket="images-usage", Key="albums/legacy-folder/c.jpg", Body=b"x" * 5)
        # Two days of logs: one file on the oldest window day, two on another.
        s3.put_object(Bucket="logs-usage", Key=f"media/{DIST}.2026-09-04-10.aaa.gz", Body=log((f"/albums/{A}/original/a.jpg", 1000)))
        s3.put_object(Bucket="logs-usage", Key=f"media/{DIST}.2026-10-03-01.bbb.gz", Body=log((f"/albums/{B}/original/b.mp4", 40)))
        s3.put_object(Bucket="logs-usage", Key=f"media/{DIST}.2026-10-03-02.ccc.gz", Body=log((f"/albums/{A}/thumbnail/a.jpg", 5), ("/site/x", 9)))
        # Outside the window, or not yet complete enough to count.
        s3.put_object(Bucket="logs-usage", Key=f"media/{DIST}.2026-09-03-10.old.gz", Body=log((f"/albums/{A}/x", 99999)))
        s3.put_object(Bucket="logs-usage", Key=f"media/{DIST}.2026-10-04-10.new.gz", Body=log((f"/albums/{A}/x", 77777)))
        self.now = dt.datetime(2026, 10, 5, 6, tzinfo=dt.timezone.utc)

    def run_job(self, remaining=300_000):
        context = Mock(get_remaining_time_in_millis=Mock(return_value=remaining))
        with patch.object(album_usage.datetime, "datetime", wraps=dt.datetime) as clock:
            clock.now.return_value = self.now
            return album_usage.handler({}, context)

    def summary(self):
        return album_usage.load_summary(self.cache)

    def test_a_daily_run_reduces_logs_once_and_summarizes_the_window(self):
        self.assertEqual(self.run_job(), {"albums": 2, "logDays": 30, "processed": 30})
        summary = self.summary()
        rows = {row["albumId"]: row for row in summary["byStorage"]}
        self.assertEqual((rows[A]["storageBytes"], rows[A]["objectCount"], rows[A]["bandwidthBytes"]), (320, 2, 1005))
        self.assertEqual((rows[B]["title"], rows[B]["deleted"], rows[B]["bandwidthBytes"]), ("Film", True, 40))
        self.assertEqual(summary["otherBandwidthBytes"], 9)
        self.assertEqual(summary["storageBytes"], 1225)
        self.assertEqual(summary["bandwidthWindow"], {"from": "2026-09-04", "to": "2026-10-03", "days": 30})
        state = self.cache.get_item(Key={"cacheKey": album_usage.STATE_KEY})["Item"]
        self.assertEqual(state["lastDay"], "2026-10-03")

        # The next day only reads the newly complete day, and drops old ones.
        self.cache.put_item(Item={"cacheKey": album_usage.DAY_KEY.format(day="2026-08-30"), "bytes": {A: 1}})
        self.now += dt.timedelta(days=1)
        self.assertEqual(self.run_job()["processed"], 1)
        summary = self.summary()
        self.assertEqual(summary["bandwidthWindow"], {"from": "2026-09-05", "to": "2026-10-04", "days": 30})
        rows = {row["albumId"]: row for row in summary["byBandwidth"]}
        self.assertEqual(rows[A]["bandwidthBytes"], 5 + 77777)
        self.assertNotIn("Item", self.cache.get_item(Key={"cacheKey": album_usage.DAY_KEY.format(day="2026-08-30")}))
        # Nothing new to read on a repeat run the same day.
        self.assertEqual(self.run_job()["processed"], 0)

    def test_a_run_stops_reading_logs_when_time_is_short(self):
        self.assertEqual(self.run_job(remaining=1000), {"albums": 2, "logDays": 0, "processed": 0})
        self.assertEqual(self.summary()["bandwidthBytes"], 0)

    def test_clients_are_created_lazily(self):
        with patch.object(album_usage.boto3, "client") as client, patch.object(album_usage, "_s3", None):
            self.assertIs(album_usage._client(), client.return_value)


class NextMonthForecastTests(unittest.TestCase):
    def months(self, totals):
        return [{"month": f"2026-{index + 1:02d}", "total": value} for index, value in enumerate(totals)]

    def test_the_trend_of_recent_months_carries_into_next_month(self):
        # Steady growth of 2 per month: 10, 12, 14, 16, 18, 20, then 22 projected now.
        report = get_cost_report._next_month(TODAY, self.months([0, 0, 10, 12, 14, 16, 18, 20, 999]), 22)
        self.assertEqual(report, {"month": "2026-11", "forecastTotal": 24.0, "trendPerMonth": 2.0})

    def test_short_or_falling_histories_stay_sensible(self):
        self.assertEqual(get_cost_report._next_month(TODAY, self.months([0, 0, 5, 0]), 8)["forecastTotal"], 8)
        falling = get_cost_report._next_month(dt.date(2026, 12, 20), self.months([30, 10, 1, 0]), 0)
        self.assertEqual((falling["month"], falling["forecastTotal"]), ("2027-01", 0.0))
        self.assertLess(falling["trendPerMonth"], 0)

    def test_the_cost_report_includes_the_forecast_and_album_usage(self):
        with patch.object(get_cost_report.cost_explorer, "get_cost_and_usage", return_value={"ResultsByTime": []}):
            report = get_cost_report._build_report(dt.date(2026, 8, 3))
        self.assertEqual(report["nextMonth"]["month"], "2026-09")
        usage = {"kind": "album-usage", "schemaVersion": 1, "byStorage": []}
        with patch.object(get_cost_report.album_usage, "load_summary", return_value=usage):
            self.assertEqual(get_cost_report._with_cache_status(report, "fresh", TODAY)["albumUsage"], usage)
        with patch.object(get_cost_report.album_usage, "load_summary", return_value=None):
            self.assertNotIn("albumUsage", get_cost_report._with_cache_status(report, "fresh", TODAY))
        with patch.object(get_cost_report.album_usage, "load_summary", side_effect=RuntimeError("ddb")):
            self.assertNotIn("albumUsage", get_cost_report._with_cache_status(report, "fresh", TODAY))


if __name__ == "__main__":
    unittest.main()
