import json
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch

from test_support import response_body

import photography_stats
import refresh_google_drive_usage


CONTEXT = SimpleNamespace(aws_request_id="stats-request-id")


def drive_report():
    return {
        "generatedAt": "2026-08-11T09:17:35Z",
        "rawPhotoBackup": {
            "categories": {
                "images": {"bytes": 800, "fileCount": 100},
                "videos": {"bytes": 400, "fileCount": 20},
            },
        },
        "websiteBackup": {
            "categories": {
                "photos": {"bytes": 150, "fileCount": 8},
                "videos": {"bytes": 50, "fileCount": 1},
            },
        },
    }


class PhotographyStatsTests(unittest.TestCase):
    def test_builds_public_totals_years_categories_and_exif_gear(self):
        albums = [
            {
                "visibility": "public",
                "status": "active",
                "type": "photo",
                "createdAt": "2026-08-07T12:00:00Z",
                "category": " Misty  ",
                "images": [
                    {"exif": {"model": "Canon EOS R7", "lens": "12mm F1.4"}},
                    {"exif": {"model": "Canon EOS R7"}},
                    {"rawKey": "legacy-photo.jpg"},
                ],
            },
            {
                "visibility": "public",
                "type": "video",
                "createdAt": "2025-01-01",
                "category": "Misty",
                "images": [{"rawKey": "one.mp4"}, {"rawKey": "two.mp4"}],
            },
            {
                "visibility": "public",
                "type": "photo",
                "createdAt": "2025-02-01",
                "category": "Hikes",
                "imageCount": 4,
            },
            {
                "visibility": "private",
                "type": "photo",
                "createdAt": "2026-01-01",
                "category": "Private",
                "images": [{"exif": {"model": "Hidden", "lens": "Hidden"}}],
            },
            {
                "visibility": "public",
                "status": "pending",
                "type": "video",
                "createdAt": "2026-01-01",
                "images": [{"rawKey": "pending.mp4"}],
            },
        ]

        snapshot = photography_stats._build_snapshot(
            drive_report(),
            albums,
            generated_at="2026-08-11T10:00:00Z",
        )

        self.assertEqual(snapshot["taken"], {"photos": 100, "videos": 20})
        self.assertEqual(snapshot["kept"], {
            "photos": 7,
            "videos": 2,
            "photoPercent": 7.0,
            "videoPercent": 10.0,
        })
        self.assertEqual(snapshot["storage"], {"totalBytes": 1400})
        self.assertEqual(snapshot["albums"], {"photos": 2, "videos": 1})
        self.assertEqual(snapshot["outputByYear"], [
            {"year": 2025, "photoAlbums": 1, "photos": 4, "videoAlbums": 1, "videos": 2},
            {"year": 2026, "photoAlbums": 1, "photos": 3, "videoAlbums": 0, "videos": 0},
        ])
        self.assertEqual(snapshot["categories"], [
            {"category": "Misty", "albums": 2, "photos": 3, "videos": 2},
            {"category": "Hikes", "albums": 1, "photos": 4, "videos": 0},
        ])
        self.assertEqual(snapshot["mostActive"]["year"]["year"], 2025)
        self.assertEqual(snapshot["mostActive"]["category"]["category"], "Misty")
        self.assertEqual(snapshot["gear"]["cameras"], [{"name": "Canon EOS R7", "photos": 2}])
        self.assertEqual(snapshot["gear"]["lenses"], [
            {"name": photography_stats.MANUAL_LENS_FALLBACK, "photos": 2},
            {"name": "12mm F1.4", "photos": 1},
        ])
        self.assertTrue(photography_stats._valid_snapshot(snapshot))

    def test_scans_paginated_album_inventory_with_a_narrow_projection(self):
        with patch.object(
            photography_stats.albums_table,
            "scan",
            side_effect=[
                {"Items": [{"visibility": "public"}], "LastEvaluatedKey": {"albumId": "one"}},
                {"Items": [{"visibility": "private"}]},
            ],
        ) as scan:
            self.assertEqual(len(photography_stats._scan_albums()), 2)
        self.assertEqual(scan.call_count, 2)
        self.assertNotIn("ExclusiveStartKey", scan.call_args_list[0].kwargs)
        self.assertEqual(scan.call_args_list[1].kwargs["ExclusiveStartKey"], {"albumId": "one"})
        self.assertIn("#images", scan.call_args_list[0].kwargs["ProjectionExpression"])

    def test_refresh_reads_drive_cache_and_stores_the_aggregate_snapshot(self):
        drive_item = {"Item": {"payload": json.dumps(drive_report())}}
        with patch.object(photography_stats.cache_table, "get_item", return_value=drive_item) as get_item, patch.object(
            photography_stats, "_scan_albums", return_value=[]
        ), patch.object(photography_stats.cache_table, "put_item", return_value={}) as put_item:
            result = photography_stats.refresh_photography_stats()

        self.assertEqual(get_item.call_args, call(Key={"cacheKey": photography_stats.DRIVE_CACHE_KEY}, ConsistentRead=True))
        stored = put_item.call_args.kwargs["Item"]
        self.assertEqual(stored["cacheKey"], photography_stats.STATS_CACHE_KEY)
        self.assertTrue(photography_stats._valid_snapshot(json.loads(stored["payload"])))
        self.assertEqual(result["albums"], {"photos": 0, "videos": 0})

    def test_public_handler_is_front_door_only_cacheable_and_rejects_parameters(self):
        snapshot = photography_stats._build_snapshot(drive_report(), [], generated_at="2026-08-11T10:00:00Z")
        item = {"Item": {"payload": json.dumps(snapshot)}}
        with patch.object(photography_stats, "verify_front_door_request", return_value=None), patch.object(
            photography_stats.cache_table, "get_item", return_value=item
        ):
            response = photography_stats.handler({}, CONTEXT)
            invalid = photography_stats.handler({"queryStringParameters": {"private": "true"}}, CONTEXT)
        self.assertEqual(response["statusCode"], 200)
        self.assertIn("s-maxage=86400", response["headers"]["Cache-Control"])
        self.assertEqual(response_body(response), snapshot)
        self.assertEqual(invalid["statusCode"], 400)

        denied = {"statusCode": 403}
        with patch.object(photography_stats, "verify_front_door_request", return_value=denied), patch.object(
            photography_stats.cache_table, "get_item"
        ) as cache:
            self.assertIs(photography_stats.handler({}, CONTEXT), denied)
            cache.assert_not_called()

    def test_public_handler_returns_preparing_or_redacted_internal_error(self):
        with patch.object(photography_stats, "verify_front_door_request", return_value=None), patch.object(
            photography_stats.cache_table, "get_item", return_value={}
        ):
            response = photography_stats.handler({}, CONTEXT)
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(response_body(response)["code"], "stats_preparing")

        with patch.object(photography_stats, "verify_front_door_request", return_value=None), patch.object(
            photography_stats.cache_table, "get_item", side_effect=RuntimeError("secret details")
        ), self.assertLogs("photography_api", level="ERROR") as logs:
            response = photography_stats.handler({}, CONTEXT)
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("secret details", " ".join(logs.output))

    def test_scheduled_wrapper_refreshes_stats_after_drive_usage(self):
        with patch.object(
            refresh_google_drive_usage, "refresh_handler", return_value={"refreshed": False, "status": "fresh"}
        ) as drive, patch.object(
            refresh_google_drive_usage,
            "refresh_photography_stats",
            return_value={"generatedAt": "2026-08-11T10:00:00Z"},
        ) as stats:
            response = refresh_google_drive_usage.handler({"trusted": True}, CONTEXT)
        drive.assert_called_once_with({"trusted": True}, CONTEXT)
        stats.assert_called_once_with()
        self.assertTrue(response["photographyStatsRefreshed"])


if __name__ == "__main__":
    unittest.main()
