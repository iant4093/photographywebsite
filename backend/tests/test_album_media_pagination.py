import unittest
from unittest.mock import Mock, patch

from test_support import claims, gateway_event, response_body

import album_media_store
import backfill_album_media
import get_album_media


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


def record(**overrides):
    value = {
        "albumId": ALBUM_ID,
        "status": "active",
        "visibility": "public",
        "type": "photo",
        "title": "Portfolio",
        "createdAt": "2026-01-01T00:00:00Z",
        "images": [
            {"rawKey": f"albums/{ALBUM_ID}/one.jpg"},
            {"rawKey": f"albums/{ALBUM_ID}/two.jpg"},
        ],
        "imageCount": 2,
    }
    value.update(overrides)
    return value


class AlbumMediaPaginationTests(unittest.TestCase):
    def event(self, params=None):
        return gateway_event(
            claims(groups=["Admins"]),
            pathParameters={"albumId": ALBUM_ID},
            queryStringParameters=params or {},
        )

    def test_legacy_manifest_is_paginated_until_cutover_marker_exists(self):
        album = record()
        with patch.object(
            get_album_media.albums_table,
            "get_item",
            return_value={"Item": album},
        ), patch.object(
            get_album_media,
            "serialize_album_detail",
            return_value={"albumId": ALBUM_ID},
        ), patch.object(
            get_album_media,
            "serialize_images",
            side_effect=lambda value, **_kwargs: value["images"],
        ):
            first = response_body(get_album_media.handler(self.event({"limit": "1"}), None))
            second = response_body(get_album_media.handler(
                self.event({"limit": "1", "cursor": first["nextCursor"]}),
                None,
            ))

        self.assertEqual(first["items"], [album["images"][0]])
        self.assertEqual(second["items"], [album["images"][1]])
        self.assertIsNone(second["nextCursor"])
        self.assertEqual(first["album"]["imageCount"], 2)

    def test_normalized_marker_uses_ordered_media_query(self):
        album = record(mediaStoreVersion=1)
        item = album_media_store.normalized_media_item(ALBUM_ID, album["images"][0], 0)
        with patch.object(
            get_album_media.albums_table,
            "get_item",
            return_value={"Item": album},
        ), patch.object(
            get_album_media,
            "query_album_media",
            return_value=([item], {"albumId": ALBUM_ID, "mediaId": item["mediaId"], "orderKey": item["orderKey"]}),
        ) as query, patch.object(
            get_album_media,
            "serialize_album_detail",
            return_value={"albumId": ALBUM_ID},
        ), patch.object(
            get_album_media,
            "serialize_images",
            side_effect=lambda value, **_kwargs: value["images"],
        ):
            payload = response_body(get_album_media.handler(self.event({"limit": "10"}), None))

        query.assert_called_once_with(ALBUM_ID, 10, None)
        self.assertEqual(payload["items"][0]["rawKey"], album["images"][0]["rawKey"])
        self.assertIsNotNone(payload["nextCursor"])

    def test_non_admin_is_denied(self):
        response = get_album_media.handler(
            gateway_event(
                claims(groups=[]),
                pathParameters={"albumId": ALBUM_ID},
            ),
            None,
        )
        self.assertEqual(response["statusCode"], 403)

    def test_missing_album_is_not_exposed_to_an_admin(self):
        with patch.object(get_album_media.albums_table, "get_item", return_value={}):
            response = get_album_media.handler(self.event(), None)

        self.assertEqual(response["statusCode"], 404)

    def test_front_door_denial_short_circuits_admin_media_reads(self):
        denied = {"statusCode": 403, "body": "denied"}
        with patch.object(get_album_media, "verify_front_door_request", return_value=denied), patch.object(
            get_album_media.albums_table,
            "get_item",
        ) as get_item:
            response = get_album_media.handler(self.event(), None)

        self.assertEqual(response, denied)
        get_item.assert_not_called()


class AlbumMediaMigrationTests(unittest.TestCase):
    def test_normalized_item_accepts_a_legacy_string_without_optional_fields(self):
        raw_key = f"albums/{ALBUM_ID}/legacy.jpg"

        item = album_media_store.normalized_media_item(ALBUM_ID, raw_key, -3)

        self.assertEqual(item["rawKey"], raw_key)
        self.assertTrue(item["orderKey"].startswith("000000000000#"))
        self.assertNotIn("thumbKey", item)

    def test_migrate_skips_invalid_or_completed_rows_and_activates_a_valid_snapshot(self):
        albums_table = Mock()
        with patch.object(backfill_album_media, "albums_table", albums_table), patch.object(
            backfill_album_media,
            "replace_album_media",
            return_value=True,
        ) as replace, patch.object(backfill_album_media, "activate_album_media") as activate:
            self.assertFalse(backfill_album_media._migrate({"albumId": 3, "images": []}))
            self.assertFalse(backfill_album_media._migrate(record(mediaStoreVersion=1)))
            self.assertTrue(backfill_album_media._migrate(record()))

        replace.assert_called_once_with(ALBUM_ID, record()["images"])
        activate.assert_called_once_with(albums_table, ALBUM_ID, record()["images"])

    def test_completed_backfill_state_avoids_repeated_album_scans(self):
        media_table = Mock()
        media_table.get_item.return_value = {"Item": {"status": "complete"}}
        albums_table = Mock()

        with patch.object(backfill_album_media, "albums_table", albums_table), patch.object(
            backfill_album_media,
            "_table",
            return_value=media_table,
        ):
            result = backfill_album_media.handler({}, None)

        self.assertEqual(result, {"status": "complete", "processed": 0})
        albums_table.scan.assert_not_called()
        media_table.put_item.assert_not_called()

    def test_backfill_requires_its_normalized_table_configuration(self):
        with patch.object(backfill_album_media, "_table", return_value=None):
            with self.assertRaises(RuntimeError):
                backfill_album_media.handler({}, None)

    def test_backfill_persists_a_scan_cursor_for_the_next_bounded_run(self):
        media_table = Mock()
        media_table.get_item.return_value = {}
        albums_table = Mock()
        cursor = {"albumId": ALBUM_ID}
        albums_table.scan.return_value = {"Items": [], "LastEvaluatedKey": cursor}

        with patch.object(backfill_album_media, "albums_table", albums_table), patch.object(
            backfill_album_media,
            "_table",
            return_value=media_table,
        ):
            result = backfill_album_media.handler({}, None)

        self.assertEqual(result, {"status": "running", "processed": 0})
        state = media_table.put_item.call_args.kwargs["Item"]
        self.assertEqual(state["lastEvaluatedKey"], cursor)
        self.assertFalse(state["scanComplete"])

    def test_activation_is_guarded_by_the_exact_legacy_manifest(self):
        table = Mock()
        images = record()["images"]

        album_media_store.activate_album_media(table, ALBUM_ID, images)

        table.update_item.assert_called_once_with(
            Key={"albumId": ALBUM_ID},
            UpdateExpression="SET mediaStoreVersion = :version, imageCount = :count",
            ConditionExpression="attribute_exists(albumId) AND images = :images",
            ExpressionAttributeValues={":version": 1, ":count": 2, ":images": images},
        )

    def test_backfill_marks_a_completed_page_only_after_migration(self):
        media_table = Mock()
        media_table.get_item.return_value = {}
        albums_table = Mock()
        albums_table.scan.return_value = {"Items": [record()]}

        with patch.object(backfill_album_media, "albums_table", albums_table), patch.object(
            backfill_album_media, "_table", return_value=media_table,
        ), patch.object(
            backfill_album_media,
            "_migrate",
            return_value=True,
        ) as migrate:
            result = backfill_album_media.handler({}, None)

        migrate.assert_called_once()
        self.assertEqual(result, {"status": "complete", "processed": 1})
        state = media_table.put_item.call_args.kwargs["Item"]
        self.assertEqual(state["status"], "complete")
        self.assertTrue(state["scanComplete"])
        self.assertNotIn("retryAlbumIds", state)

    def test_backfill_retains_raced_album_for_a_later_retry(self):
        media_table = Mock()
        media_table.get_item.return_value = {
            "Item": {
                "scanComplete": True,
                "retryAlbumIds": [ALBUM_ID],
            },
        }
        albums_table = Mock()
        albums_table.get_item.return_value = {"Item": record()}

        with patch.object(backfill_album_media, "albums_table", albums_table), patch.object(
            backfill_album_media, "_table", return_value=media_table,
        ), patch.object(
            backfill_album_media,
            "_migrate",
            side_effect=RuntimeError("concurrent update"),
        ):
            result = backfill_album_media.handler({}, None)

        self.assertEqual(result, {"status": "running", "processed": 0})
        state = media_table.put_item.call_args.kwargs["Item"]
        self.assertEqual(state["retryAlbumIds"], [ALBUM_ID])
        self.assertEqual(state["status"], "running")


if __name__ == "__main__":
    unittest.main()
