"""Exercise real media purge paths and their ordering around origin changes."""

import json
import os
import unittest
from contextlib import ExitStack
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from test_support import response_body

import cache_invalidation
import delete_album
import delete_images
import update_album


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
LEGACY_PREFIX = "albums/summer-portraits-a1b2c3d4/"
RAW_KEY = f"{LEGACY_PREFIX}original/video.mp4"
THUMB_KEY = f"{LEGACY_PREFIX}thumbnail/video.jpg"


class MediaRevocationTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.record = {
            "albumId": ALBUM_ID,
            "title": "Album",
            "type": "video",
            "status": "active",
            "visibility": "public",
            "legacyS3Prefix": LEGACY_PREFIX,
            "s3Prefix": "albums/untrusted/",
            "images": [{"rawKey": RAW_KEY, "thumbKey": THUMB_KEY}],
        }
        self.table = Mock()
        self.table.get_item.return_value = {"Item": self.record}
        self.table.update_item.return_value = {}
        self.table.meta.client.exceptions.ConditionalCheckFailedException = type(
            "ConditionalCheckFailedException", (Exception,), {}
        )
        self.order = []
        self.table.update_item.side_effect = lambda **_: self.order.append("commit") or {}
        self.table.delete_item.side_effect = lambda **_: self.order.append("commit")
        self.cloudfront = Mock()
        self.cloudfront.create_invalidation.side_effect = lambda **_: self.order.append("purge")
        self.stack.enter_context(patch.dict(os.environ, {"IMAGES_DISTRIBUTION_ID": "media"}))
        self.stack.enter_context(patch.object(cache_invalidation, "_client", return_value=self.cloudfront))

    def mock(self, module, name, **kwargs):
        return self.stack.enter_context(patch.object(module, name, **kwargs))

    def prepare_handler(self, module):
        self.mock(module, "table", new=self.table)
        self.mock(module, "require_admin", return_value=None)
        self.mock(module, "verify_front_door_request", return_value=None)
        self.mock(module, "_audit")
        self.mock(module, "request_public_api_invalidation")
        self.mock(module, "load_preview_metadata", return_value={})

    def assert_purge_paths(self):
        self.cloudfront.create_invalidation.assert_called_once()
        self.assertEqual(
            self.cloudfront.create_invalidation.call_args.kwargs["InvalidationBatch"]["Paths"],
            {
                "Quantity": 3,
                "Items": [
                    f"/albums/{ALBUM_ID}/*",
                    f"/{LEGACY_PREFIX}*",
                    f"/public-previews/{ALBUM_ID}/*",
                ],
            },
        )

    def update_visibility(self, visibility):
        self.prepare_handler(update_album)
        updated = {**self.record, "visibility": visibility}
        self.mock(update_album, "_updated_album", return_value=updated)
        self.mock(update_album, "_reconcile_album_qr")
        self.mock(update_album, "tag_album_visibility", side_effect=lambda *_args, **_kwargs: self.order.append("tag"))
        self.mock(update_album, "tag_preview_visibility")
        self.mock(update_album, "serialize_album_summary", side_effect=lambda album, **_: album)
        return update_album.handler({
            "pathParameters": {"albumId": ALBUM_ID},
            "body": json.dumps({"visibility": visibility}),
        }, None)

    def test_private_transition_blocks_origin_then_purges_before_committing(self):
        response = self.update_visibility("private")
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(self.order, ["tag", "purge", "commit"])
        self.assert_purge_paths()

    def test_unlisted_transition_also_purges_originals_and_video_segments(self):
        self.assertEqual(self.update_visibility("unlisted")["statusCode"], 200)
        self.assertEqual(self.order, ["tag", "purge", "commit"])
        self.assert_purge_paths()

    def test_failed_restrictive_purge_never_commits_new_visibility(self):
        self.cloudfront.create_invalidation.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied"}}, "CreateInvalidation"
        )
        self.assertEqual(self.update_visibility("private")["statusCode"], 500)
        self.assertEqual(self.order, ["tag"])
        self.table.update_item.assert_not_called()

    def delete(self, module):
        self.prepare_handler(module)
        self.mock(module, "preflight_deletion")
        self.mock(module, "delete_preview_metadata")
        self.mock(module, "delete_album_media")
        self.mock(module, "delete_prefix_all_versions", side_effect=lambda _: self.order.append("delete") or 1)
        body = {"pathParameters": {"albumId": ALBUM_ID}}
        if module is delete_images:
            self.mock(module, "delete_keys_all_versions", side_effect=lambda _: self.order.append("delete") or 2)
            self.mock(module, "serialize_album_summary", side_effect=lambda album, **_: album)
            body["body"] = json.dumps({"keys": [RAW_KEY]})
        return module.handler(body, None)

    def test_album_deletion_removes_origin_objects_then_purges_before_record_removal(self):
        response = self.delete(delete_album)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["deletedObjectVersions"], 3)
        self.assertEqual(self.order, ["delete", "delete", "delete", "purge", "commit"])
        self.assert_purge_paths()

    def test_media_deletion_purges_originals_thumbnails_and_hls_after_origin_removal(self):
        response = self.delete(delete_images)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["deletedCount"], 1)
        self.assertEqual(self.order, ["delete", "delete", "purge", "commit"])
        self.assert_purge_paths()

    def test_failed_album_deletion_purge_preserves_record_for_retry(self):
        self.cloudfront.create_invalidation.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied"}}, "CreateInvalidation"
        )
        self.assertEqual(self.delete(delete_album)["statusCode"], 500)
        self.table.delete_item.assert_not_called()
        self.assertNotIn("commit", self.order)

    def test_failed_media_deletion_purge_preserves_manifest_for_retry(self):
        self.cloudfront.create_invalidation.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied"}}, "CreateInvalidation"
        )
        self.assertEqual(self.delete(delete_images)["statusCode"], 500)
        self.table.update_item.assert_not_called()
        self.assertNotIn("commit", self.order)


if __name__ == "__main__":
    unittest.main()
