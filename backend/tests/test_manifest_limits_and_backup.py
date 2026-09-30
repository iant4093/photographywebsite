import json
import os
import unittest
from unittest.mock import Mock, patch

from test_support import claims, response_body
import add_images
import create_album
import dynamodb_helpers
import update_image
from validation_helpers import ValidationError


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


class ManifestSafetyTests(unittest.TestCase):
    def test_item_budget_rejects_oversized_manifest_before_write(self):
        with patch.dict(os.environ, {"ALBUM_ITEM_BUDGET_BYTES": str(64 * 1024)}):
            with self.assertRaises(ValidationError):
                dynamodb_helpers.ensure_album_item_budget({"albumId": ALBUM_ID, "images": ["x" * 70000]})

    def _append(self, stored_backup, requested_backup):
        raw = f"albums/{ALBUM_ID}/original/new.jpg"
        album = {
            "albumId": ALBUM_ID,
            "status": "active",
            "visibility": "private",
            "type": "photo",
            "title": "Album",
            "images": [],
            "backupToGoogleDrive": stored_backup,
        }
        event = {
            "pathParameters": {"albumId": ALBUM_ID},
            "body": json.dumps({"images": [{"rawKey": raw}], "backupToGoogleDrive": requested_backup}),
        }
        lambda_client = Mock()
        with patch.dict(os.environ, {"GOOGLE_DRIVE_SYNC_FUNCTION_NAME": "drive-worker"}), patch.object(
            add_images, "require_admin", return_value=None
        ), patch.object(add_images.table, "get_item", return_value={"Item": album}), patch.object(
            add_images, "_extract_exif"
        ), patch.object(add_images.table, "update_item"), patch.object(
            add_images, "tag_keys_visibility", return_value=1
        ), patch.object(add_images.boto3, "client", return_value=lambda_client):
            response = add_images.handler(event, None)
        return response, lambda_client

    def test_request_cannot_disable_stored_drive_backup(self):
        response, client = self._append(True, False)
        self.assertEqual(response["statusCode"], 200)
        client.invoke.assert_called_once()

    def test_request_cannot_enable_stored_drive_backup(self):
        response, client = self._append(False, True)
        self.assertEqual(response["statusCode"], 200)
        client.invoke.assert_not_called()


# The smallest configurable budget keeps oversized fixtures small and fast.
SMALL_BUDGET = {"ALBUM_ITEM_BUDGET_BYTES": str(64 * 1024)}
MANIFEST_MESSAGE = "Album manifest is too large; split the album or remove captions/transcripts"


def video(index):
    return f"albums/{ALBUM_ID}/original/clip-{index}.mp4"


class AlbumManifestSizeGuardTests(unittest.TestCase):
    def assert_manifest_rejected(self, response, audit):
        self.assertEqual(response["statusCode"], 413)
        self.assertEqual(response_body(response), {"error": MANIFEST_MESSAGE, "code": "album_manifest_too_large"})
        self.assertEqual(audit.call_args.args[2:4], ("denied", "manifest_too_large"))

    def test_budget_boundary_raises_a_validation_subclass(self):
        item = {"albumId": ALBUM_ID, "images": [{"rawKey": video(1), "transcript": "x" * 100}]}
        size = dynamodb_helpers.estimated_item_bytes(item)
        with patch.object(dynamodb_helpers, "album_item_budget_bytes", return_value=size):
            self.assertIsNone(dynamodb_helpers.ensure_album_item_budget(item))
        with patch.object(dynamodb_helpers, "album_item_budget_bytes", return_value=size - 1), self.assertRaises(
            dynamodb_helpers.AlbumManifestTooLarge
        ) as raised:
            dynamodb_helpers.ensure_album_item_budget(item)
        self.assertIsInstance(raised.exception, ValidationError)
        self.assertEqual(str(raised.exception), MANIFEST_MESSAGE)

    def _create(self, images):
        table = Mock()
        body = {
            "albumId": ALBUM_ID, "type": "photo", "visibility": "public", "title": "Album",
            "createdAt": "2026-01-01T00:00:00Z", "images": images,
        }
        with patch.dict(os.environ, SMALL_BUDGET), patch.object(create_album, "require_admin", return_value=None), patch.object(
            create_album, "get_caller_claims", return_value=claims(groups=["Admins"])
        ), patch.object(create_album, "_extract_exif"), patch.object(
            create_album, "tag_album_visibility", return_value=1
        ), patch.object(create_album, "enqueue_preview_jobs", return_value=1), patch.object(
            create_album, "request_original_comparisons"
        ), patch.object(create_album, "_ensure_album_qr", return_value=None), patch.object(
            create_album, "request_public_api_invalidation"
        ), patch.object(create_album, "request_random_photo_pool_refresh"), patch.object(
            create_album, "replace_album_media", return_value=False
        ), patch.object(create_album, "_audit") as audit, patch.object(create_album, "table", table):
            response = create_album.handler({"body": json.dumps(body)}, None)
        return response, table, audit

    def test_create_album_rejects_an_oversized_manifest_before_writing(self):
        filename = "f" * 251 + ".jpg"
        images = [{"rawKey": f"albums/{ALBUM_ID}/original/p{index}.jpg", "originalFilename": filename} for index in range(200)]
        response, table, audit = self._create(images)
        self.assert_manifest_rejected(response, audit)
        table.put_item.assert_not_called()
        table.update_item.assert_not_called()

        response, table, _ = self._create([{"rawKey": f"albums/{ALBUM_ID}/original/p0.jpg", "originalFilename": filename}])
        self.assertEqual(response["statusCode"], 201)
        table.put_item.assert_called_once()

    def _add(self, stored, new_images):
        table = Mock()
        table.get_item.return_value = {"Item": stored}
        with patch.dict(os.environ, SMALL_BUDGET), patch.object(add_images, "require_admin", return_value=None), patch.object(
            add_images, "table", table
        ), patch.object(add_images, "_extract_exif"), patch.object(add_images, "tag_keys_visibility"), patch.object(
            add_images, "enqueue_preview_jobs", return_value=1
        ), patch.object(add_images, "request_original_comparisons"), patch.object(
            add_images, "request_public_api_invalidation"
        ), patch.object(add_images, "request_random_photo_pool_refresh"), patch.object(add_images, "_audit") as audit:
            response = add_images.handler(
                {"pathParameters": {"albumId": ALBUM_ID}, "body": json.dumps({"images": new_images})}, None,
            )
        return response, table, audit

    def test_add_images_rejects_an_append_that_crosses_the_budget(self):
        stored = {
            "albumId": ALBUM_ID, "status": "active", "visibility": "public", "type": "photo", "title": "Album",
            "images": [{"rawKey": f"albums/{ALBUM_ID}/original/old-{index}.jpg", "altText": "a" * 500} for index in range(100)],
        }
        stored["imageCount"] = len(stored["images"])
        self.assertLess(dynamodb_helpers.estimated_item_bytes(stored), 64 * 1024)
        filename = "f" * 251 + ".jpg"
        crossing = [{"rawKey": f"albums/{ALBUM_ID}/original/new-{index}.jpg", "originalFilename": filename} for index in range(30)]
        response, table, audit = self._add(stored, crossing)
        self.assert_manifest_rejected(response, audit)
        table.update_item.assert_not_called()

        response, table, _ = self._add(stored, crossing[:1])
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["added"], 1)
        table.update_item.assert_called_once()

    def _update(self, stored, transcript):
        table = Mock()
        table.meta.client.exceptions.ConditionalCheckFailedException = type("ConditionalCheckFailedException", (Exception,), {})
        table.get_item.return_value = {"Item": stored}
        with patch.dict(os.environ, SMALL_BUDGET), patch.object(update_image, "require_admin", return_value=None), patch.object(
            update_image, "table", table
        ), patch.object(update_image, "tag_keys_visibility"), patch.object(
            update_image, "request_public_api_invalidation"
        ), patch.object(update_image, "_audit") as audit:
            response = update_image.handler(
                {"pathParameters": {"albumId": ALBUM_ID}, "body": json.dumps({"rawKey": video(0), "transcript": transcript})},
                None,
            )
        return response, table, audit

    def test_update_image_rejects_a_transcript_that_crosses_the_budget(self):
        stored = {
            "albumId": ALBUM_ID, "status": "active", "visibility": "public", "type": "video", "title": "Album",
            "images": [{"rawKey": video(0)}] + [{"rawKey": video(index), "transcript": "t" * 7600} for index in range(1, 9)],
        }
        self.assertLess(dynamodb_helpers.estimated_item_bytes(stored), 64 * 1024)
        response, table, audit = self._update(stored, "t" * 8000)
        self.assert_manifest_rejected(response, audit)
        table.update_item.assert_not_called()

        response, table, _ = self._update(stored, "A short transcript.")
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["item"]["transcript"], "A short transcript.")
        table.update_item.assert_called_once()

    def test_update_image_can_shrink_an_album_that_is_already_over_budget(self):
        stored = {
            "albumId": ALBUM_ID, "status": "active", "visibility": "public", "type": "video", "title": "Album",
            "images": [{"rawKey": video(index), "transcript": "t" * 8000} for index in range(9)],
        }
        self.assertGreater(dynamodb_helpers.estimated_item_bytes(stored), 64 * 1024)
        response, table, _ = self._update(stored, "")
        self.assertEqual(response["statusCode"], 200)
        table.update_item.assert_called_once()
        # Rewriting the same oversized value is not growth either.
        response, _, _ = self._update(stored, "t" * 8000)
        self.assertEqual(response["statusCode"], 200)


if __name__ == "__main__":
    unittest.main()
