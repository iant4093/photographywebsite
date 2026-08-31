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


class AlbumMediaMigrationTests(unittest.TestCase):
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
