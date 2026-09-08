import os
import unittest
from unittest.mock import patch

import test_support  # noqa: F401 -- initialize the offline AWS environment
with patch.dict(os.environ, {"PREVIEW_METADATA_TABLE": "previews-test"}):
    import random_photo_pool_builder as builder
from media_access import PREVIEW_VERSION, expected_preview_keys, media_id_for_key


class RandomPhotoPoolBuilderTests(unittest.TestCase):
    def test_builder_publishes_ready_previews_and_loads_legacy_images_once(self):
        album_id = "11111111-1111-4111-8111-111111111111"
        image = {"rawKey": f"albums/{album_id}/original/photo.jpg"}
        album = {"albumId": album_id, "visibility": "public", "category": "Hikes", "images": []}
        media_id = media_id_for_key(image["rawKey"])
        metadata = {album_id: {media_id: {
            "albumId": album_id, "mediaId": media_id, "status": "ready",
            "previewVersion": PREVIEW_VERSION,
            "previewKeys": expected_preview_keys(album_id, image["rawKey"]),
        }}}
        result = {"poolCount": 2, "totalPhotos": 1, "changed": True}
        with patch.object(builder, "_public_photo_albums", return_value=[album]), patch.object(
            builder, "_legacy_images", return_value=[image]
        ) as legacy, patch.object(builder, "load_preview_metadata_for_albums", return_value=metadata) as load, patch.object(
            builder, "replace_materialized_pools", return_value=result
        ) as publish, patch.object(builder, "request_public_api_invalidation"):
            self.assertEqual(builder.handler({}, None), result)
        legacy.assert_called_once_with(album)
        load.assert_called_once_with([(album, None)])
        self.assertEqual(set(publish.call_args.kwargs["previews"]), {f"{album_id}:{media_id}"})
        self.assertEqual(set(publish.call_args.args[1]), {None, "Hikes"})

    def test_only_changed_decks_request_random_photo_invalidation(self):
        for changed in (False, True):
            with self.subTest(changed=changed), patch.dict(
                os.environ, {"CACHE_INVALIDATION_QUEUE_URL": "https://sqs.test/cache"}
            ), patch.object(builder, "_public_photo_albums", return_value=[]), patch.object(
                builder, "load_preview_metadata_for_albums", return_value={}
            ), patch.object(builder, "replace_materialized_pools", return_value={
                "poolCount": 1, "totalPhotos": 0, "changed": changed,
            }), patch.object(builder, "request_public_api_invalidation") as invalidate:
                builder.handler({}, None)
            if changed:
                invalidate.assert_called_once_with(
                    random_photos=True, reason="random-photo-pool-refreshed",
                )
            else:
                invalidate.assert_not_called()
