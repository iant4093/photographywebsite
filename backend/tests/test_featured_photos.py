"""Featured-only membership, isolated persistence, and bounded API reads."""

from copy import deepcopy
import os
import unittest
from unittest.mock import MagicMock, patch

from test_support import response_body
import get_public_album as api
import cache_invalidation
import cache_invalidation_worker
import featured_photo_pools as featured
import random_photo_pools as pools
from media_access import PREVIEW_VERSION, expected_preview_keys, media_id_for_key


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


def album(**overrides):
    return {
        "albumId": ALBUM_ID, "visibility": "public", "status": "active",
        "type": "photo", "category": "Hikes", "title": "A hike",
        "images": [{"rawKey": f"albums/{ALBUM_ID}/original/{i}.jpg", "isFavorite": True}
                   for i in range(12)],
        **overrides,
    }


class FeaturedPoolTests(unittest.TestCase):
    def test_legacy_manifest_keys_support_favorites_without_listing_s3(self):
        key = f"albums/{ALBUM_ID}/original/legacy.jpg"
        record = album(images=[{"key": key, "isFavorite": True}, {"key": "ordinary.jpg"}])
        result = featured.build_featured_reference_pools([record])
        self.assertEqual(result[None], [f"{ALBUM_ID}:{media_id_for_key(key)}"])
        self.assertNotIn("rawKey", record["images"][0])

    def test_strict_favorites_only_and_no_source_mutation(self):
        record = album()
        record["images"] += [
            {"rawKey": f"albums/{ALBUM_ID}/original/not-{i}.jpg", "isFavorite": value}
            for i, value in enumerate((False, 1, "true", None))
        ] + [{"rawKey": "no-favorite.jpg"}, None, {}]
        records = [record, album(visibility="private"), album(visibility="unlisted"),
                   album(status="deleting"), album(type="video"), None,
                   album(category="Empty", images=None)]
        before = deepcopy(records)
        result = featured.build_featured_reference_pools(records)
        self.assertEqual(len(result[None]), 12)
        self.assertEqual(set(result[None]), set(result["Hikes"]))
        self.assertEqual(result["Empty"], [])
        self.assertEqual(records, before)
        # The unfiltered pool still includes ordinary photos.
        self.assertGreater(len(pools.build_reference_pools([record])[None]), 12)

    def test_partition_round_trip_keeps_random_decks_and_avoids_unchanged_writes(self):
        stored = {}
        table = MagicMock(name="preview-table")
        table.name = "preview-table"
        batch = table.batch_writer.return_value.__enter__.return_value

        def write(*, Item):
            stored[(Item["albumId"], Item["mediaId"])] = deepcopy(Item)

        table.put_item.side_effect = batch.put_item.side_effect = write
        batch.delete_item.side_effect = lambda *, Key: stored.pop((Key["albumId"], Key["mediaId"]), None)
        table.query.side_effect = lambda **kw: {"Items": [
            deepcopy(value) for (partition, _), value in stored.items()
            if partition == kw["ExpressionAttributeValues"][":partition"]
        ]}
        table.get_item.side_effect = lambda *, Key, **kw: {
            "Item": deepcopy(stored.get((Key["albumId"], Key["mediaId"])))
        }
        resource = MagicMock()
        resource.batch_get_item.side_effect = lambda *, RequestItems: {"Responses": {
            table.name: [deepcopy(stored[(key["albumId"], key["mediaId"])])
                         for key in RequestItems[table.name]["Keys"]]
        }}
        record = album()
        pools.replace_materialized_pools(table, pools.build_reference_pools([record]))
        random_snapshot = deepcopy(stored)
        decks = featured.build_featured_reference_pools([record])
        self.assertTrue(featured.replace_featured_pools(table, decks)["changed"])
        table.reset_mock()
        self.assertFalse(featured.replace_featured_pools(table, decks)["changed"])
        table.put_item.assert_not_called()
        table.batch_writer.assert_not_called()
        for category in (None, "Hikes"):
            starter = featured.load_featured_references(table, resource, category, limit=6)
            full = featured.load_featured_references(table, resource, category, limit=80)
            self.assertEqual(len(starter["references"]), 6)
            self.assertEqual(len(full["references"]), 12)
            self.assertEqual(starter["totalPhotos"], 12)
            self.assertEqual(starter["references"], full["references"][:6])
        resource.reset_mock()
        self.assertEqual(featured.load_featured_references(table, resource, "Missing")["totalPhotos"], 0)
        resource.batch_get_item.assert_not_called()
        featured.replace_featured_pools(table, {None: []})
        self.assertEqual(featured.load_featured_references(table, resource)["references"], [])
        self.assertEqual({key: value for key, value in stored.items()
                          if key[0] == pools.POOL_PARTITION}, random_snapshot)


class FeaturedApiTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(api, "_preview_table", return_value=MagicMock()))
        self.metadata = self.enterContext(patch.object(api, "load_preview_metadata_for_albums", return_value={}))

    def request(self, params=None):
        return api.handler({
            "rawPath": "/public/featured-photos",
            "requestContext": {"routeKey": "GET /public/featured-photos"},
            "queryStringParameters": params,
        }, None)

    def test_six_photo_startup_uses_precomputed_previews_without_scanning(self):
        record = album()
        ids = [media_id_for_key(image["rawKey"]) for image in record["images"][:6]]
        preview = {f"{ALBUM_ID}:{media_id}": {
            "previewVersion": PREVIEW_VERSION,
            "previewKeys": expected_preview_keys(ALBUM_ID, image["rawKey"]),
        } for media_id, image in zip(ids, record["images"])}
        with patch.object(api, "load_featured_references", return_value={
            "references": [{"albumId": ALBUM_ID, "mediaId": value} for value in ids],
            "totalPhotos": 12, "previews": preview,
        }) as load, patch.object(api, "_batch_albums", return_value={ALBUM_ID: record}), patch.object(
            api, "_random_photo_albums"
        ) as scan:
            response = self.request({"limit": "6", "mode": "category", "value": "Hikes"})
        body = response_body(response)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(body["totalPhotos"], 12)
        self.assertEqual(body["category"], "Hikes")
        self.assertEqual(len(body["images"]), 6)
        self.assertTrue(all(image["isFavorite"] is True for image in body["images"]))
        self.assertTrue(all(len(image["previewSrcSet"]) == 4 for image in body["images"]))
        self.assertTrue(all("rawKey" not in image for image in body["images"]))
        self.assertIn("s-maxage=300", response["headers"]["Cache-Control"])
        self.assertEqual(load.call_args.kwargs["limit"], 6)
        self.metadata.assert_not_called()
        scan.assert_not_called()

    def test_stale_pools_revalidate_favorites_visibility_category_and_media(self):
        record = album()
        reference = {"albumId": ALBUM_ID, "mediaId": media_id_for_key(record["images"][0]["rawKey"])}
        for changes in ({"visibility": "private"}, {"visibility": "unlisted"},
                        {"status": "deleted"}, {"type": "video"}, {"category": "Birding"},
                        {"images": []}, {"images": [{**record["images"][0], "isFavorite": False}]}):
            with self.subTest(changes=changes), patch.object(api, "load_featured_references", return_value={
                "references": [reference], "totalPhotos": 1,
            }), patch.object(api, "_batch_albums", return_value={ALBUM_ID: {**record, **changes}}), patch.object(
                api, "_random_photo_albums", return_value=[{**record, **changes}]
            ):
                self.assertEqual(response_body(self.request({"mode": "category", "value": "Hikes"}))["images"], [])

    def test_fallback_samples_only_favorites_and_never_lists_legacy_s3(self):
        record = album()
        record["images"] += [{"rawKey": "ordinary.jpg"}, {"rawKey": "fake.jpg", "isFavorite": 1}]
        with patch.object(api, "load_featured_references", return_value=None), patch.object(
            api, "_random_photo_albums", return_value=[record, album(images=None)]
        ), patch.object(api, "_legacy_images") as legacy:
            body = response_body(self.request({"limit": "6"}))
        self.assertEqual(body["totalPhotos"], 12)
        self.assertEqual(len(body["images"]), 6)
        self.assertTrue(all(image["isFavorite"] is True for image in body["images"]))
        legacy.assert_not_called()

    def test_legacy_manifest_favorites_serialize_on_both_paths_and_uncategorized_fallback(self):
        key = f"albums/{ALBUM_ID}/original/legacy.jpg"
        record = album(category=None, images=[{"key": key, "isFavorite": True}])
        for pool in (None, {"references": [{"albumId": ALBUM_ID, "mediaId": media_id_for_key(key)}], "totalPhotos": 1}):
            with self.subTest(pool=pool), patch.object(api, "load_featured_references", return_value=pool), patch.object(
                api, "_batch_albums", return_value={ALBUM_ID: record}
            ), patch.object(api, "_random_photo_albums", return_value=[record]):
                body = response_body(self.request({"mode": "category", "value": "Uncategorized"}))
                self.assertEqual(body["totalPhotos"], 1)
                self.assertEqual(body["images"][0]["id"], media_id_for_key(key))
                self.assertTrue(body["images"][0]["isFavorite"])

    def test_empty_or_single_favorite_does_not_fill_with_ordinary_photos(self):
        for count in (0, 1):
            with self.subTest(count=count), patch.object(api, "load_featured_references", return_value=None), patch.object(
                api, "_random_photo_albums", return_value=[album(images=album()["images"][:count])]
            ):
                body = response_body(self.request())
                self.assertEqual(body["totalPhotos"], count)
                self.assertEqual(len(body["images"]), count)

    def test_pool_read_failure_does_not_expand_database_work(self):
        with patch.object(api, "load_featured_references", side_effect=RuntimeError("offline")), patch.object(
            api, "_random_photo_albums", return_value=[album()]
        ):
            self.assertEqual(self.request()["statusCode"], 503)

    def test_invalid_queries_fail_before_reading(self):
        for params in ({"favorite": "true"}, {"category": "Hikes"}, {"mode": "all"},
                       {"mode": "category"}, {"limit": "-1"}, {"limit": "oops"}):
            with self.subTest(params=params), patch.object(api, "load_featured_references") as load:
                self.assertEqual(self.request(params)["statusCode"], 400)
                load.assert_not_called()


class FeaturedInvalidationTests(unittest.TestCase):
    def test_featured_queue_and_synchronous_fallback_only_invalidate_featured(self):
        for queue_url in ("", "https://sqs.test/cache"):
            with self.subTest(queue=queue_url), patch.dict(os.environ, {"CACHE_INVALIDATION_QUEUE_URL": queue_url}), patch.object(
                cache_invalidation, "_client"
            ) as client, patch.object(cache_invalidation, "_queue_client") as queue:
                cache_invalidation.request_public_api_invalidation(featured_photos=True)
                if queue_url:
                    body = queue.return_value.send_message.call_args.kwargs["MessageBody"]
                    cache_invalidation_worker.handler({"Records": [{"body": body}]}, None)
                paths = client.return_value.create_invalidation.call_args.kwargs["InvalidationBatch"]["Paths"]
                self.assertEqual(paths, {"Quantity": 1, "Items": ["/api/public/featured-photos*"]})
