"""Unit coverage for narrow public CloudFront invalidations."""

import os
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

import cache_invalidation
import cache_invalidation_worker
import validation_helpers


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


class CacheInvalidationTests(unittest.TestCase):
    def setUp(self):
        cache_invalidation.reset_cache_invalidation_client_for_tests()
        self.client = Mock()

    def tearDown(self):
        cache_invalidation.reset_cache_invalidation_client_for_tests()

    def test_public_api_invalidation_is_narrow_and_deduplicated(self):
        with patch.dict(os.environ, {"FRONTEND_DISTRIBUTION_ID": "frontend"}), patch.object(
            cache_invalidation, "_client", return_value=self.client
        ):
            self.assertTrue(cache_invalidation.invalidate_public_api(
                album_id=ALBUM_ID,
                catalog=True,
                reason="album-updated",
            ))
        request = self.client.create_invalidation.call_args.kwargs
        self.assertEqual(request["DistributionId"], "frontend")
        self.assertEqual(request["InvalidationBatch"]["Paths"], {
            "Quantity": 7,
            "Items": [
                "/api/public/albums",
                f"/api/public/albums/{ALBUM_ID}",
                "/api/public/albums?*",
                "/api/public/explore",
                "/api/public/explore?*",
                "/api/public/random-photos",
                "/api/public/random-photos?*",
            ],
        })
        self.assertTrue(request["InvalidationBatch"]["CallerReference"].startswith("album-updated-"))

    def test_public_preview_invalidation_requires_valid_album_and_distribution(self):
        with patch.dict(os.environ, {"IMAGES_DISTRIBUTION_ID": "media"}), patch.object(
            cache_invalidation, "_client", return_value=self.client
        ):
            self.assertTrue(cache_invalidation.invalidate_public_previews(ALBUM_ID))
            with self.assertRaises(validation_helpers.ValidationError):
                cache_invalidation.invalidate_public_previews("not-an-album")
        request = self.client.create_invalidation.call_args.kwargs
        self.assertEqual(request["DistributionId"], "media")
        self.assertEqual(request["InvalidationBatch"]["Paths"], {
            "Quantity": 1,
            "Items": [f"/public-previews/{ALBUM_ID}/*"],
        })

    def test_best_effort_failure_is_false_and_strict_failure_propagates(self):
        error = ClientError({"Error": {"Code": "AccessDenied"}}, "CreateInvalidation")
        self.client.create_invalidation.side_effect = error
        with patch.dict(os.environ, {"IMAGES_DISTRIBUTION_ID": "media"}), patch.object(
            cache_invalidation, "_client", return_value=self.client
        ):
            self.assertFalse(cache_invalidation.invalidate_public_previews(ALBUM_ID))
            with self.assertRaises(ClientError):
                cache_invalidation.invalidate_public_previews(ALBUM_ID, strict=True)

    def test_album_media_invalidation_covers_canonical_legacy_and_preview_aliases(self):
        album = {
            "albumId": ALBUM_ID,
            "legacyS3Prefix": "albums/summer-portraits-a1b2c3d4/",
            "s3Prefix": "albums/someone-else/",
        }
        with patch.dict(os.environ, {"IMAGES_DISTRIBUTION_ID": "media"}), patch.object(
            cache_invalidation, "_client", return_value=self.client
        ):
            self.assertTrue(cache_invalidation.invalidate_album_media(album, strict=True))
        request = self.client.create_invalidation.call_args.kwargs
        self.assertEqual(request["DistributionId"], "media")
        self.assertEqual(request["InvalidationBatch"]["Paths"], {
            "Quantity": 3,
            "Items": [
                f"/albums/{ALBUM_ID}/*",
                "/albums/summer-portraits-a1b2c3d4/*",
                f"/public-previews/{ALBUM_ID}/*",
            ],
        })

    def test_album_media_invalidation_never_broadens_for_unsafe_legacy_prefix(self):
        for legacy in ("albums/", "albums/*/", "albums/../", "/albums/legacy/", f"albums/{ALBUM_ID}/"):
            with self.subTest(legacy=legacy), patch.dict(
                os.environ, {"IMAGES_DISTRIBUTION_ID": "media"}
            ), patch.object(cache_invalidation, "_client", return_value=self.client):
                cache_invalidation.invalidate_album_media({
                    "albumId": ALBUM_ID,
                    "legacyS3Prefix": legacy,
                    "s3Prefix": "albums/untrusted/",
                })
                paths = self.client.create_invalidation.call_args.kwargs["InvalidationBatch"]["Paths"]
                self.assertEqual(paths, {
                    "Quantity": 2,
                    "Items": [f"/albums/{ALBUM_ID}/*", f"/public-previews/{ALBUM_ID}/*"],
                })

    def test_album_media_invalidation_rejects_invalid_album_and_propagates_strict_failure(self):
        self.client.create_invalidation.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied"}}, "CreateInvalidation"
        )
        with patch.dict(os.environ, {"IMAGES_DISTRIBUTION_ID": "media"}), patch.object(
            cache_invalidation, "_client", return_value=self.client
        ):
            with self.assertRaises(validation_helpers.ValidationError):
                cache_invalidation.invalidate_album_media({"albumId": "../other"})
            self.client.create_invalidation.assert_not_called()
            with self.assertRaises(ClientError):
                cache_invalidation.invalidate_album_media({"albumId": ALBUM_ID}, strict=True)
            self.assertFalse(cache_invalidation.invalidate_album_media({"albumId": ALBUM_ID}))

    def test_empty_invalidation_never_calls_provider(self):
        with patch.object(cache_invalidation, "_client", return_value=self.client):
            self.assertFalse(cache_invalidation._create_invalidation("", ["/safe"], "none", strict=False))
            self.assertFalse(cache_invalidation._create_invalidation("frontend", [], "none", strict=False))
        self.client.create_invalidation.assert_not_called()

    def test_public_mutations_enqueue_when_worker_queue_is_configured(self):
        queue = Mock()
        with patch.dict(os.environ, {"CACHE_INVALIDATION_QUEUE_URL": "https://sqs.test/cache"}), patch.object(
            cache_invalidation, "_queue_client", return_value=queue
        ), patch.object(cache_invalidation, "invalidate_public_api") as synchronous:
            self.assertTrue(cache_invalidation.request_public_api_invalidation(
                album_id=ALBUM_ID,
                catalog=True,
                reason="album-updated",
            ))

        synchronous.assert_not_called()
        request = queue.send_message.call_args.kwargs
        self.assertEqual(request["QueueUrl"], "https://sqs.test/cache")
        self.assertIn(ALBUM_ID, request["MessageBody"])

    def test_worker_coalesces_catalog_and_album_invalidations(self):
        event = {"Records": [
            {"body": '{"version":1,"albumId":"' + ALBUM_ID + '","catalog":false,"reason":"one"}'},
            {"body": '{"version":1,"catalog":true,"reason":"two"}'},
            {"body": "not-json"},
        ]}
        with patch.object(cache_invalidation_worker, "invalidate_public_api_batch") as invalidate:
            result = cache_invalidation_worker.handler(event, None)

        self.assertEqual(result, {"invalidated": True, "albumCount": 1, "catalog": True})
        invalidate.assert_called_once_with(
            album_ids={ALBUM_ID},
            catalog=True,
            reason="batched-public-mutation",
            strict=True,
        )


if __name__ == "__main__":
    unittest.main()
