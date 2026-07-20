import json
import os
import unittest
from unittest.mock import Mock, patch

import add_images
import dynamodb_helpers
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


if __name__ == "__main__":
    unittest.main()
