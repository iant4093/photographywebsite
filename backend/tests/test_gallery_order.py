import json
import unittest
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError

from test_support import response_body

import gallery_order
import update_gallery_order


ALBUM_ONE = "11111111-1111-4111-8111-111111111111"
ALBUM_TWO = "22222222-2222-4222-8222-222222222222"


def album(album_id, **overrides):
    record = {
        "albumId": album_id,
        "status": "active",
        "visibility": "public",
        "type": "photo",
    }
    record.update(overrides)
    return record


class GalleryOrderHelperTests(unittest.TestCase):
    def test_load_deduplicates_and_applies_photo_positions(self):
        table = MagicMock()
        table.get_item.return_value = {
            "Item": {"albumIds": [ALBUM_TWO, ALBUM_TWO, "", ALBUM_ONE, 3]}
        }
        positions = gallery_order.load_gallery_order(table)
        self.assertEqual(positions, {ALBUM_TWO: 0, ALBUM_ONE: 1})
        summary = gallery_order.apply_gallery_order(
            {"albumId": ALBUM_ONE, "type": "photo"}, positions
        )
        self.assertEqual(summary["galleryOrder"], 1)
        video = gallery_order.apply_gallery_order(
            {"albumId": ALBUM_TWO, "type": "video"}, positions
        )
        self.assertNotIn("galleryOrder", video)

    def test_read_errors_and_invalid_records_fall_back_safely(self):
        table = MagicMock()
        table.get_item.side_effect = ClientError(
            {"Error": {"Code": "InternalServerError", "Message": "private"}}, "GetItem"
        )
        logger = MagicMock()
        self.assertEqual(gallery_order.load_gallery_order(table, logger), {})
        logger.warning.assert_called_once_with("gallery_order_unavailable")

        table.get_item.side_effect = None
        table.get_item.return_value = {"Item": {"albumIds": "invalid"}}
        self.assertEqual(gallery_order.load_gallery_order(table, logger), {})


class UpdateGalleryOrderTests(unittest.TestCase):
    def event(self, album_ids):
        return {"body": json.dumps({"albumIds": album_ids})}

    def test_admin_can_replace_order_after_all_albums_are_validated(self):
        with patch.object(update_gallery_order, "verify_front_door_request", return_value=None), patch.object(
            update_gallery_order, "require_admin", return_value=None
        ), patch.object(
            update_gallery_order, "_load_albums", return_value=[album(ALBUM_ONE), album(ALBUM_TWO)]
        ), patch.object(
            update_gallery_order.settings_table, "put_item"
        ) as put, patch.object(update_gallery_order, "emit_audit_event") as audit:
            response = update_gallery_order.handler(self.event([ALBUM_TWO, ALBUM_ONE]), None)

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["albumIds"], [ALBUM_TWO, ALBUM_ONE])
        saved = put.call_args.kwargs["Item"]
        self.assertEqual(saved["settingId"], gallery_order.SETTING_ID)
        self.assertEqual(saved["albumIds"], [ALBUM_TWO, ALBUM_ONE])
        self.assertIn("updatedAt", saved)
        self.assertTrue(audit.called)

    def test_rejects_duplicates_unknown_nonpublic_video_and_extra_fields(self):
        invalid_cases = (
            (self.event([ALBUM_ONE, ALBUM_ONE]), []),
            (self.event([ALBUM_ONE]), []),
            (self.event([ALBUM_ONE]), [album(ALBUM_ONE, visibility="private")]),
            (self.event([ALBUM_ONE]), [album(ALBUM_ONE, type="video")]),
            ({"body": json.dumps({"albumIds": [], "extra": True})}, []),
        )
        for event, records in invalid_cases:
            with self.subTest(event=event), patch.object(
                update_gallery_order, "verify_front_door_request", return_value=None
            ), patch.object(
                update_gallery_order, "require_admin", return_value=None
            ), patch.object(
                update_gallery_order, "_load_albums", return_value=records
            ), patch.object(update_gallery_order.settings_table, "put_item") as put:
                response = update_gallery_order.handler(event, None)
            self.assertEqual(response["statusCode"], 400)
            put.assert_not_called()

    def test_empty_order_resets_and_provider_failures_are_redacted(self):
        with patch.object(update_gallery_order, "verify_front_door_request", return_value=None), patch.object(
            update_gallery_order, "require_admin", return_value=None
        ), patch.object(update_gallery_order.settings_table, "put_item") as put:
            response = update_gallery_order.handler(self.event([]), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(put.call_args.kwargs["Item"]["albumIds"], [])

        error = ClientError(
            {"Error": {"Code": "InternalServerError", "Message": "sensitive"}}, "PutItem"
        )
        with patch.object(update_gallery_order, "verify_front_door_request", return_value=None), patch.object(
            update_gallery_order, "require_admin", return_value=None
        ), patch.object(
            update_gallery_order, "_load_albums", return_value=[]
        ), patch.object(update_gallery_order.settings_table, "put_item", side_effect=error):
            response = update_gallery_order.handler(self.event([]), None)
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("sensitive", response["body"])

    def test_batch_get_retries_unprocessed_keys_without_scanning(self):
        table = MagicMock(name="albums_table")
        table.name = "albums-test"
        resource = MagicMock()
        resource.batch_get_item.side_effect = [
            {
                "Responses": {"albums-test": [album(ALBUM_ONE)]},
                "UnprocessedKeys": {"albums-test": {"Keys": [{"albumId": ALBUM_TWO}]}},
            },
            {"Responses": {"albums-test": [album(ALBUM_TWO)]}, "UnprocessedKeys": {}},
        ]
        with patch.object(update_gallery_order, "albums_table", table), patch.object(
            update_gallery_order, "dynamodb", resource
        ):
            records = update_gallery_order._load_albums([ALBUM_ONE, ALBUM_TWO])
        self.assertEqual({item["albumId"] for item in records}, {ALBUM_ONE, ALBUM_TWO})
        self.assertEqual(resource.batch_get_item.call_count, 2)


if __name__ == "__main__":
    unittest.main()
