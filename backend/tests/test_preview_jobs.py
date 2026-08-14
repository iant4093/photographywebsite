import json
import os
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from test_support import DEFAULT_ENV

import preview_jobs
import delete_images
import media_access
import update_album


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


class PreviewJobTests(unittest.TestCase):
    def test_queue_is_optional_for_safe_v1_compatibility(self):
        with patch.dict(os.environ, DEFAULT_ENV, clear=False):
            os.environ.pop("PREVIEW_QUEUE_URL", None)
            self.assertEqual(preview_jobs.enqueue_preview_jobs(ALBUM_ID, [{"rawKey": "albums/x/photo.jpg"}]), 0)

    def test_dispatch_batches_messages_and_contains_no_visibility_authority(self):
        client = Mock()
        client.send_message_batch.side_effect = [
            {"Successful": [{"Id": str(index)} for index in range(10)]},
            {"Successful": [{"Id": "0"}]},
        ]
        images = [{"rawKey": f"albums/{ALBUM_ID}/original/{index}.jpg"} for index in range(11)]
        with patch.dict(os.environ, {"PREVIEW_QUEUE_URL": "https://sqs.example/preview"}), patch.object(
            preview_jobs, "get_sqs_client", return_value=client
        ):
            self.assertEqual(preview_jobs.enqueue_preview_jobs(ALBUM_ID, images), 11)
        self.assertEqual(client.send_message_batch.call_count, 2)
        body = json.loads(client.send_message_batch.call_args_list[0].kwargs["Entries"][0]["MessageBody"])
        self.assertEqual(body["previewVersion"], 3)
        self.assertNotIn("visibility", body)
        self.assertNotIn("ownerEmail", body)

    def test_partial_batch_failure_is_not_silently_accepted(self):
        client = Mock()
        client.send_message_batch.return_value = {"Successful": [], "Failed": [{"Id": "0"}]}
        with patch.dict(os.environ, {"PREVIEW_QUEUE_URL": "https://sqs.example/preview"}), patch.object(
            preview_jobs, "get_sqs_client", return_value=client
        ), self.assertRaises(RuntimeError):
            preview_jobs.enqueue_preview_jobs(ALBUM_ID, [{"rawKey": f"albums/{ALBUM_ID}/original/a.jpg"}])


class PreviewLifecycleTests(unittest.TestCase):
    def test_visibility_change_performs_post_write_preview_convergence_pass(self):
        album = {
            "albumId": ALBUM_ID,
            "status": "active",
            "type": "photo",
            "visibility": "public",
            "images": [],
        }
        updated = {**album, "visibility": "private", "ownerEmail": "owner@example.com", "ownerSub": "subject"}
        event = {"pathParameters": {"albumId": ALBUM_ID}, "body": json.dumps({"visibility": "private"})}
        with patch.object(update_album, "require_admin", return_value=None), patch.object(
            update_album.table, "get_item", return_value={"Item": album}
        ), patch.object(update_album, "_updated_album", return_value=updated), patch.object(
            update_album, "_reconcile_album_qr", return_value=None
        ), patch.object(
            update_album.table, "put_item"
        ), patch.object(update_album, "tag_album_visibility"), patch.object(
            update_album, "tag_preview_visibility"
        ) as preview_tag, patch.object(update_album, "_audit"):
            response = update_album.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        preview_tag.assert_called_once_with(updated, "private")

    def test_album_update_returns_conflict_when_fetched_images_or_visibility_changed(self):
        album = {"albumId": ALBUM_ID, "status": "active", "visibility": "public", "images": []}
        updated = {**album, "title": "Updated"}
        event = {"pathParameters": {"albumId": ALBUM_ID}, "body": json.dumps({"title": "Updated"})}
        conflict = ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem")
        with patch.object(update_album, "require_admin", return_value=None), patch.object(
            update_album.table, "get_item", return_value={"Item": album}
        ), patch.object(update_album, "_updated_album", return_value=updated), patch.object(
            update_album, "_reconcile_album_qr", return_value=None
        ), patch.object(
            update_album.table, "put_item", side_effect=conflict
        ) as put, patch.object(update_album, "tag_album_visibility"), patch.object(update_album, "_audit"):
            response = update_album.handler(event, None)
        self.assertEqual(response["statusCode"], 409)
        self.assertIn("#images = :expected_images", put.call_args.kwargs["ConditionExpression"])
        self.assertEqual(put.call_args.kwargs["ExpressionAttributeValues"][":expected_images"], [])

    def test_media_deletion_strictly_loads_and_deletes_external_preview_state(self):
        raw_key = f"albums/{ALBUM_ID}/original/photo.jpg"
        image = {"rawKey": raw_key}
        album = {"albumId": ALBUM_ID, "visibility": "private", "images": [image]}
        media_id = media_access.media_id_for_key(raw_key)
        preview_keys = media_access.expected_preview_keys(ALBUM_ID, raw_key)
        metadata = {
            "albumId": ALBUM_ID,
            "mediaId": media_id,
            "status": "ready",
            "previewVersion": 3,
            "previewKeys": preview_keys,
        }
        event = {"pathParameters": {"albumId": ALBUM_ID}, "body": json.dumps({"keys": [raw_key]})}
        with patch.object(delete_images, "require_admin", return_value=None), patch.object(
            delete_images.table, "get_item", return_value={"Item": album}
        ), patch.object(delete_images, "load_preview_metadata", return_value={media_id: metadata}) as load, patch.object(
            delete_images, "preflight_deletion"
        ), patch.object(delete_images, "delete_keys_all_versions", return_value=3) as delete, patch.object(
            delete_images, "delete_prefix_all_versions", return_value=0
        ), patch.object(delete_images.table, "update_item"
        ), patch.object(delete_images, "delete_preview_metadata") as delete_metadata, patch.object(
            delete_images, "_audit"
        ):
            response = delete_images.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        load.assert_called_once_with(album, strict=True)
        self.assertEqual(set(delete.call_args.args[0]), {raw_key, *preview_keys.values()})
        delete_metadata.assert_called_once_with(ALBUM_ID, {media_id})

    def test_visibility_key_resolution_never_uses_availability_fallback(self):
        album = {"albumId": ALBUM_ID, "images": []}
        with patch.object(media_access, "load_preview_metadata", side_effect=RuntimeError("outage")) as load:
            with self.assertRaises(RuntimeError):
                media_access.preview_known_keys(album)
        load.assert_called_once_with(album, strict=True)


if __name__ == "__main__":
    unittest.main()
