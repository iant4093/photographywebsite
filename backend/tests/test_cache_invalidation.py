"""Unit coverage for narrow public CloudFront invalidations."""

import os
import json
from fnmatch import fnmatchcase
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
                "/album/*",
                "/api/public/albums*",
                "/api/public/explore*",
                "/api/public/featured-photos*",
                "/api/public/random-photos*",
                "/api/public/social/*",
                "/video/*",
            ],
        })
        self.assertTrue(request["InvalidationBatch"]["CallerReference"].startswith("album-updated-"))

    def test_catalog_wildcards_cover_all_public_variants_without_other_namespaces(self):
        with patch.object(cache_invalidation, "_client", return_value=self.client):
            cache_invalidation.invalidate_public_api_batch(
                album_ids=[ALBUM_ID, ALBUM_ID, "22222222-2222-4222-8222-222222222222"],
                catalog=True, random_photos=True,
            )
        paths = self.client.create_invalidation.call_args.kwargs['InvalidationBatch']['Paths']
        self.assertEqual(paths['Quantity'], 7)
        covered = [
            '/api/public/albums', '/api/public/albums?category=travel&page=2',
            f'/api/public/albums/{ALBUM_ID}', f'/api/public/albums/{ALBUM_ID}?page=2',
            '/api/public/explore', '/api/public/explore?cursor=next',
            '/api/public/featured-photos', '/api/public/featured-photos?mode=category&value=Hikes&limit=6',
            '/api/public/random-photos', '/api/public/random-photos?category=travel',
            f'/album/{ALBUM_ID}', f'/album/{ALBUM_ID}/', f'/video/{ALBUM_ID}',
            f'/api/public/social/album/{ALBUM_ID}', f'/api/public/social/video/{ALBUM_ID}',
        ]
        for url in covered:
            with self.subTest(url=url):
                self.assertTrue(any(fnmatchcase(url, path) for path in paths['Items']))
        for url in ['/api/admin/albums', '/api/public/stats', '/index.html', '/assets/app.js',
                    f'/albums/{ALBUM_ID}/photo.jpg', f'/public-previews/{ALBUM_ID}/photo.webp']:
            with self.subTest(url=url):
                self.assertFalse(any(fnmatchcase(url, path) for path in paths['Items']))

    def test_album_only_batch_keeps_exact_scope_and_removes_duplicates(self):
        with patch.object(cache_invalidation, "_client", return_value=self.client):
            cache_invalidation.invalidate_public_api_batch(album_ids=[ALBUM_ID, ALBUM_ID])
        self.assertEqual(self.client.create_invalidation.call_args.kwargs['InvalidationBatch']['Paths'], {
            'Quantity': 5, 'Items': [
                f'/album/{ALBUM_ID}*',
                f'/api/public/albums/{ALBUM_ID}',
                f'/api/public/social/album/{ALBUM_ID}',
                f'/api/public/social/video/{ALBUM_ID}',
                f'/video/{ALBUM_ID}*',
            ],
        })

    def test_album_documents_cover_viewer_and_rewritten_paths_only_for_that_album(self):
        other = "22222222-2222-4222-8222-222222222222"
        with patch.object(cache_invalidation, "_client", return_value=self.client):
            cache_invalidation.invalidate_public_api_batch(album_ids=[ALBUM_ID])
        items = self.client.create_invalidation.call_args.kwargs['InvalidationBatch']['Paths']['Items']
        # The social router rewrites /album/<id>[/] and /video/<id>[/] to the
        # anonymous social document, and CloudFront caches the rewritten URL.
        for url in (f'/album/{ALBUM_ID}', f'/album/{ALBUM_ID}/', f'/video/{ALBUM_ID}',
                    f'/api/public/social/album/{ALBUM_ID}', f'/api/public/social/video/{ALBUM_ID}'):
            with self.subTest(url=url):
                self.assertTrue(any(fnmatchcase(url, path) for path in items))
        for url in (f'/album/{other}', f'/api/public/social/album/{other}', '/api/public/albums',
                    f'/albums/{ALBUM_ID}/original/photo.jpg'):
            with self.subTest(url=url):
                self.assertFalse(any(fnmatchcase(url, path) for path in items))

    def test_many_album_documents_collapse_to_bounded_wildcards(self):
        albums = [f"{index}1111111-1111-4111-8111-111111111111" for index in range(1, 9)]
        with patch.object(cache_invalidation, "_client", return_value=self.client):
            cache_invalidation.invalidate_public_api_batch(album_ids=albums)
        items = self.client.create_invalidation.call_args.kwargs['InvalidationBatch']['Paths']['Items']
        # CloudFront allows only 15 wildcard paths in progress per distribution.
        self.assertLessEqual(sum('*' in path for path in items), 3)
        self.assertEqual([path for path in items if '*' in path], ['/album/*', '/api/public/social/*', '/video/*'])
        self.assertEqual(len([path for path in items if path.startswith('/api/public/albums/')]), 8)

    def test_catalog_does_not_skip_album_identity_validation(self):
        with patch.object(cache_invalidation, "_client", return_value=self.client):
            with self.assertRaises(validation_helpers.ValidationError):
                cache_invalidation.invalidate_public_api_batch(album_ids=['../admin'], catalog=True)
        self.client.create_invalidation.assert_not_called()

    def test_strict_public_revocation_stays_synchronous_and_propagates_failure(self):
        self.client.create_invalidation.side_effect = ClientError(
            {'Error': {'Code': 'AccessDenied'}}, 'CreateInvalidation',
        )
        with patch.dict(os.environ, {'CACHE_INVALIDATION_QUEUE_URL': 'https://sqs.test/cache'}), \
                patch.object(cache_invalidation, '_queue_client') as queue, \
                patch.object(cache_invalidation, '_client', return_value=self.client):
            with self.assertRaises(ClientError):
                cache_invalidation.invalidate_public_api(album_id=ALBUM_ID, catalog=True, strict=True)
        queue.assert_not_called()

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
            random_photos=False,
            featured_photos=False,
            reason="batched-public-mutation",
            strict=True,
        )

    def test_worker_coalesces_album_documents_into_one_request(self):
        other = "22222222-2222-4222-8222-222222222222"
        event = {"Records": [
            {"messageId": "a", "body": json.dumps({"version": 1, "albumId": ALBUM_ID, "reason": "one"})},
            {"messageId": "b", "body": json.dumps({"version": 1, "albumId": other, "reason": "two"})},
            {"messageId": "c", "body": json.dumps({"version": 1, "albumId": ALBUM_ID, "reason": "three"})},
        ]}
        with patch.dict(os.environ, {"FRONTEND_DISTRIBUTION_ID": "frontend"}), patch.object(
            cache_invalidation, "_client", return_value=self.client
        ):
            result = cache_invalidation_worker.handler(event, None)
        self.assertEqual(result, {"invalidated": True, "albumCount": 2, "catalog": False})
        self.client.create_invalidation.assert_called_once()
        items = self.client.create_invalidation.call_args.kwargs["InvalidationBatch"]["Paths"]["Items"]
        self.assertEqual(items, sorted(set(items)))
        for album_id in (ALBUM_ID, other):
            for path in (f"/album/{album_id}*", f"/video/{album_id}*", f"/api/public/albums/{album_id}",
                         f"/api/public/social/album/{album_id}", f"/api/public/social/video/{album_id}"):
                with self.subTest(path=path):
                    self.assertIn(path, items)
        self.assertEqual(len(items), 10)

    def test_random_photo_queue_message_purges_only_random_photo_paths(self):
        queue = Mock()
        with patch.dict(os.environ, {
            "CACHE_INVALIDATION_QUEUE_URL": "https://sqs.test/cache",
            "FRONTEND_DISTRIBUTION_ID": "frontend",
        }), patch.object(cache_invalidation, "_queue_client", return_value=queue), patch.object(
            cache_invalidation, "_client", return_value=self.client
        ):
            cache_invalidation.request_public_api_invalidation(random_photos=True)
            body = queue.send_message.call_args.kwargs["MessageBody"]
            self.assertIs(json.loads(body)["catalog"], False)
            result = cache_invalidation_worker.handler({"Records": [{"body": body}]}, None)
        self.assertTrue(result["invalidated"])
        self.assertEqual(self.client.create_invalidation.call_args.kwargs["InvalidationBatch"]["Paths"], {
            "Quantity": 1,
            "Items": ["/api/public/random-photos*"],
        })

    def test_random_photo_synchronous_fallback_and_mixed_batch_preserve_scope(self):
        with patch.dict(os.environ, {
            "CACHE_INVALIDATION_QUEUE_URL": "", "FRONTEND_DISTRIBUTION_ID": "frontend",
        }), patch.object(cache_invalidation, "_client", return_value=self.client):
            cache_invalidation.request_public_api_invalidation(random_photos=True)
            self.assertEqual(self.client.create_invalidation.call_args.kwargs[
                "InvalidationBatch"]["Paths"]["Quantity"], 1)
            cache_invalidation_worker.handler({"Records": [
                {"body": json.dumps({"version": 1, "randomPhotos": True})},
                {"body": json.dumps({"version": 1, "catalog": True, "albumId": ALBUM_ID})},
            ]}, None)
        paths = self.client.create_invalidation.call_args.kwargs["InvalidationBatch"]["Paths"]
        self.assertEqual(paths["Quantity"], 7)
        self.assertIn("/api/public/albums*", paths["Items"])
        self.assertIn("/api/public/explore*", paths["Items"])
        self.assertIn("/api/public/social/*", paths["Items"])


if __name__ == "__main__":
    unittest.main()
