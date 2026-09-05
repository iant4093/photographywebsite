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
    def test_load_deduplicates_and_applies_independent_gallery_positions(self):
        table = MagicMock()
        table.get_item.return_value = {
            "Item": {
                "albumIds": [ALBUM_TWO, ALBUM_TWO, "", ALBUM_ONE, 3],
                "categoryNames": ["Hikes", "Hikes", "", "Astro", 3],
                "videoAlbumIds": [ALBUM_ONE],
                "videoCategoryNames": ["Films"],
            }
        }
        settings = gallery_order.load_gallery_settings(table)
        self.assertEqual(settings["photo"]["albums"], {ALBUM_TWO: 0, ALBUM_ONE: 1})
        self.assertEqual(settings["photo"]["categories"], {"Hikes": 0, "Astro": 1})
        self.assertEqual(settings["video"]["albums"], {ALBUM_ONE: 0})
        self.assertEqual(settings["video"]["categories"], {"Films": 0})
        summary = gallery_order.apply_gallery_order(
            {"albumId": ALBUM_ONE, "type": "photo", "category": "Astro"},
            settings,
        )
        self.assertEqual(summary["galleryOrder"], 1)
        self.assertEqual(summary["galleryCategoryOrder"], 1)
        video = gallery_order.apply_gallery_order(
            {"albumId": ALBUM_ONE, "type": "video", "category": "Films"},
            settings,
        )
        self.assertEqual(video["galleryOrder"], 0)
        self.assertEqual(video["galleryCategoryOrder"], 0)

    def test_read_errors_and_invalid_records_fall_back_safely(self):
        table = MagicMock()
        table.get_item.side_effect = ClientError(
            {"Error": {"Code": "InternalServerError", "Message": "private"}}, "GetItem"
        )
        logger = MagicMock()
        self.assertEqual(gallery_order.load_gallery_settings(table, logger), {})
        logger.warning.assert_called_once_with("gallery_order_unavailable")

        table.get_item.side_effect = None
        table.get_item.return_value = {"Item": {"albumIds": "invalid"}}
        settings = gallery_order.load_gallery_settings(table, logger)
        self.assertEqual(settings["photo"], {"albums": {}, "categories": {}})
        self.assertEqual(settings["video"], {"albums": {}, "categories": {}})


class UpdateGalleryOrderTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(update_gallery_order, "request_public_api_invalidation", return_value=True))

    def event(self, album_ids):
        return {"body": json.dumps({"albumIds": album_ids})}

    def test_admin_can_replace_order_after_all_albums_are_validated(self):
        with patch.object(update_gallery_order, "verify_front_door_request", return_value=None), patch.object(
            update_gallery_order, "require_admin", return_value=None
        ), patch.object(
            update_gallery_order, "_load_albums", return_value=[album(ALBUM_ONE), album(ALBUM_TWO)]
        ), patch.object(
            update_gallery_order.settings_table, "update_item"
        ) as update, patch.object(update_gallery_order, "emit_audit_event") as audit:
            response = update_gallery_order.handler(self.event([ALBUM_TWO, ALBUM_ONE]), None)

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["albumType"], "photo")
        self.assertEqual(response_body(response)["albumIds"], [ALBUM_TWO, ALBUM_ONE])
        request = update.call_args.kwargs
        self.assertEqual(request["Key"], {"settingId": gallery_order.SETTING_ID})
        self.assertIn("albumIds = :album_ids", request["UpdateExpression"])
        self.assertEqual(
            request["ExpressionAttributeValues"][":album_ids"],
            [ALBUM_TWO, ALBUM_ONE],
        )
        self.assertIn(":updated_at", request["ExpressionAttributeValues"])
        self.assertTrue(audit.called)

    def test_admin_can_replace_category_order_without_rewriting_album_order(self):
        event = {"body": json.dumps({"categoryNames": ["Hikes", "Astro"]})}
        with patch.object(update_gallery_order, "verify_front_door_request", return_value=None), patch.object(
            update_gallery_order, "require_admin", return_value=None
        ), patch.object(update_gallery_order, "_load_albums") as load, patch.object(
            update_gallery_order.settings_table, "update_item"
        ) as update:
            response = update_gallery_order.handler(event, None)

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["albumType"], "photo")
        self.assertEqual(response_body(response)["categoryNames"], ["Hikes", "Astro"])
        load.assert_not_called()
        request = update.call_args.kwargs
        self.assertIn("categoryNames = :category_names", request["UpdateExpression"])
        self.assertNotIn("albumIds", request["UpdateExpression"])
        self.assertEqual(
            request["ExpressionAttributeValues"][":category_names"],
            ["Hikes", "Astro"],
        )

    def test_video_order_uses_separate_fields_and_validates_video_albums(self):
        event = {
            "body": json.dumps({
                "albumType": "video",
                "albumIds": [ALBUM_TWO, ALBUM_ONE],
                "categoryNames": ["Films", "Sports"],
            })
        }
        records = [album(ALBUM_ONE, type="video"), album(ALBUM_TWO, type="video")]
        with patch.object(update_gallery_order, "verify_front_door_request", return_value=None), patch.object(
            update_gallery_order, "require_admin", return_value=None
        ), patch.object(
            update_gallery_order, "_load_albums", return_value=records
        ), patch.object(update_gallery_order.settings_table, "update_item") as update:
            response = update_gallery_order.handler(event, None)

        self.assertEqual(response["statusCode"], 200)
        body = response_body(response)
        self.assertEqual(body["albumType"], "video")
        self.assertEqual(body["albumIds"], [ALBUM_TWO, ALBUM_ONE])
        request = update.call_args.kwargs
        self.assertIn("videoAlbumIds = :album_ids", request["UpdateExpression"])
        self.assertIn("videoCategoryNames = :category_names", request["UpdateExpression"])

    def test_rejects_duplicates_unknown_nonpublic_video_and_extra_fields(self):
        invalid_cases = (
            (self.event([ALBUM_ONE, ALBUM_ONE]), []),
            (self.event([ALBUM_ONE]), []),
            (self.event([ALBUM_ONE]), [album(ALBUM_ONE, visibility="private")]),
            (self.event([ALBUM_ONE]), [album(ALBUM_ONE, type="video")]),
            ({"body": json.dumps({"albumIds": [], "extra": True})}, []),
            ({"body": json.dumps({"categoryNames": ["Hikes", "Hikes"]})}, []),
            ({"body": json.dumps({"categoryNames": [""]})}, []),
            ({"body": json.dumps({"albumType": "audio", "albumIds": []})}, []),
            ({"body": json.dumps({"albumType": "video"})}, []),
        )
        for event, records in invalid_cases:
            with self.subTest(event=event), patch.object(
                update_gallery_order, "verify_front_door_request", return_value=None
            ), patch.object(
                update_gallery_order, "require_admin", return_value=None
            ), patch.object(
                update_gallery_order, "_load_albums", return_value=records
            ), patch.object(update_gallery_order.settings_table, "update_item") as update:
                response = update_gallery_order.handler(event, None)
            self.assertEqual(response["statusCode"], 400)
            update.assert_not_called()

    def test_empty_order_resets_and_provider_failures_are_redacted(self):
        with patch.object(update_gallery_order, "verify_front_door_request", return_value=None), patch.object(
            update_gallery_order, "require_admin", return_value=None
        ), patch.object(update_gallery_order.settings_table, "update_item") as update:
            response = update_gallery_order.handler(self.event([]), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(update.call_args.kwargs["ExpressionAttributeValues"][":album_ids"], [])

        error = ClientError(
            {"Error": {"Code": "InternalServerError", "Message": "sensitive"}}, "UpdateItem"
        )
        with patch.object(update_gallery_order, "verify_front_door_request", return_value=None), patch.object(
            update_gallery_order, "require_admin", return_value=None
        ), patch.object(
            update_gallery_order, "_load_albums", return_value=[]
        ), patch.object(update_gallery_order.settings_table, "update_item", side_effect=error):
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
