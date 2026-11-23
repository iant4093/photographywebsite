"""Regression checks for the exporter's public-only and fallback contracts."""

from decimal import Decimal
import io
import json
import os
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from ops import photo_api_publisher as publisher


class PhotoApiTest(unittest.TestCase):
    def test_only_public_active_photo_albums_and_approved_keys_are_eligible(self):
        album_id = "bf4c8aae-c8d1-43ad-8b3d-a163fc06b4c8"
        album = {"albumId": album_id, "visibility": "public", "legacyS3Prefix": "albums/approved/"}
        self.assertTrue(publisher.public_album(album))
        self.assertFalse(publisher.public_album({**album, "visibility": "unlisted"}))
        self.assertFalse(publisher.public_album({**album, "pendingVisibilityChange": {"to": "private"}}))
        self.assertFalse(publisher.public_album({**album, "status": "trashed"}))
        self.assertFalse(publisher.public_album({**album, "type": "video"}))
        rows = publisher.eligible_images(album, [
            {"rawKey": f"albums/{album_id}/original/photo.jpg", "width": Decimal(6000), "height": 4000},
            {"rawKey": "albums/approved/old.jpg", "isFavorite": True},
            {"rawKey": "albums/approved/../private.jpg"},
            {"rawKey": "albums/unknown/private.jpg"},
            {"rawKey": f"albums/{album_id}/archive.zip"},
        ])
        self.assertEqual(rows, [
            ["albums/approved/old.jpg", True, None, None],
            [f"albums/{album_id}/original/photo.jpg", False, 6000, 4000],
        ])

    def test_catalog_contains_stable_full_image_links_and_the_expected_pools(self):
        s3 = Mock()
        s3.head_object.return_value = {"ContentLength": 10000000, "ContentType": "image/jpeg"}
        image = ["albums/approved/photo.jpg", False, 6000, 4000]
        photo = publisher.build_photo(s3, "media", "photos.example.com", b"key", "approved", image)
        self.assertEqual(photo["bytes"], 10000000)
        self.assertEqual(photo["width"], 6000)
        self.assertTrue(photo["imageUrl"].startswith("https://photos.example.com/v1/images/"))
        objects = {key: json.loads(body) for key, body in publisher.catalog_objects("version", [photo])}
        self.assertFalse(objects["catalog/version/all/0.json"]["fallbackUsed"])
        self.assertTrue(objects["catalog/version/fallback/0.json"]["fallbackUsed"])
        with_favorite = list(publisher.catalog_objects("version", [photo, {**photo, "featured": True}]))
        self.assertEqual([key for key, _ in with_favorite], [
            "catalog/version/all/0.json", "catalog/version/all/1.json", "catalog/version/featured/0.json",
        ])

    def test_unreadable_photos_are_excluded_and_unexpected_origin_errors_are_retried(self):
        s3 = Mock()
        image = ["albums/approved/photo.jpg", False, 6000, 4000]
        s3.head_object.side_effect = ClientError({"Error": {"Code": "403"}}, "HeadObject")
        self.assertIsNone(publisher.build_photo(s3, "media", "photos.example.com", b"key", "approved", image))
        s3.head_object.side_effect = ClientError({"Error": {"Code": "503"}}, "HeadObject")
        with self.assertRaises(ClientError):
            publisher.build_photo(s3, "media", "photos.example.com", b"key", "approved", image)

    def test_list_objects_paginates_pools_and_handles_album_fallback(self):
        photos = [
            {"id": f"p{i}", "featured": i == 1, "fallbackUsed": False}
            for i in range(3)
        ]
        album_pages = {key: json.loads(body) for key, body in publisher.list_objects("v1", photos, page_size=2)}
        self.assertEqual(sorted(album_pages), [
            "catalog/v1/all/page-0.json",
            "catalog/v1/all/page-1.json",
            "catalog/v1/featured/page-0.json",
        ])
        self.assertEqual([p["id"] for p in album_pages["catalog/v1/all/page-0.json"]["items"]], ["p0", "p1"])
        self.assertEqual(album_pages["catalog/v1/all/page-0.json"]["nextCursor"], "1")
        self.assertFalse(album_pages["catalog/v1/all/page-0.json"]["fallbackUsed"])
        self.assertEqual([p["id"] for p in album_pages["catalog/v1/all/page-1.json"]["items"]], ["p2"])
        self.assertIsNone(album_pages["catalog/v1/all/page-1.json"]["nextCursor"])
        self.assertEqual([p["id"] for p in album_pages["catalog/v1/featured/page-0.json"]["items"]], ["p1"])
        self.assertIsNone(album_pages["catalog/v1/featured/page-0.json"]["nextCursor"])

        unfeatured = [{"id": "u0", "featured": False, "fallbackUsed": False}]
        fallback_pages = {key: json.loads(body) for key, body in publisher.list_objects("v2", unfeatured, page_size=2)}
        self.assertIn("catalog/v2/fallback/page-0.json", fallback_pages)
        self.assertTrue(fallback_pages["catalog/v2/fallback/page-0.json"]["fallbackUsed"])
        self.assertTrue(fallback_pages["catalog/v2/fallback/page-0.json"]["items"][0]["fallbackUsed"])

        global_pages = {
            key: json.loads(body)
            for key, body in publisher.list_objects("v3", unfeatured, include_fallback=False, page_size=2)
        }
        self.assertEqual(list(global_pages), ["catalog/v3/all/page-0.json"])
        self.assertEqual(list(publisher.list_objects("v4", [])), [])

    def test_selector_code_enforces_aws_size_limit_before_publishing(self):
        code = publisher.selector_code({"cliffs": ["version", 1, 0]}, b"test-key", 10, global_pool=["g", 1, 0])
        self.assertIn(b'"expires":10000', code)
        self.assertIn(b'"global":["g",1,0]', code)
        self.assertNotIn(b"const snapshot = null;", code)
        with self.assertRaisesRegex(RuntimeError, "code limit"):
            publisher.selector_code({"cliffs": ["x" * 12000, 1, 0]}, b"test-key", 10)

    def test_handler_writes_album_and_global_lists_and_reuses_unchanged_album_state(self):
        album_id = "bf4c8aae-c8d1-43ad-8b3d-a163fc06b4c8"
        stored = {publisher.SIGNING_KEY: (b"a" * 64)}
        written_keys = []

        s3 = Mock()
        def get_object(Bucket, Key):
            if Key not in stored:
                raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
            return {"Body": io.BytesIO(stored[Key])}
        def put_object(Bucket, Key, Body, **_kwargs):
            stored[Key] = Body
            written_keys.append(Key)
        s3.get_object.side_effect = get_object
        s3.put_object.side_effect = put_object

        image_s3 = Mock()
        image_s3.head_object.return_value = {"ContentLength": 5000, "ContentType": "image/jpeg"}

        ddb = Mock()
        ddb.query.return_value = {"Items": [{"albumId": {"S": album_id}}]}
        ddb.get_item.return_value = {
            "Item": {
                "albumId": {"S": album_id},
                "visibility": {"S": "public"},
                "status": {"S": "active"},
                "type": {"S": "photo"},
                "slug": {"S": "cliffs"},
                "images": {"L": [
                    {"M": {"rawKey": {"S": f"albums/{album_id}/a.jpg"}, "isFavorite": {"BOOL": True}, "width": {"N": "4000"}, "height": {"N": "3000"}}},
                    {"M": {"rawKey": {"S": f"albums/{album_id}/b.jpg"}, "isFavorite": {"BOOL": False}, "width": {"N": "3000"}, "height": {"N": "4000"}}},
                ]},
            }
        }

        cloudfront = Mock()
        cloudfront.describe_function.return_value = {
            "ETag": "e1",
            "FunctionSummary": {"FunctionConfig": {"Comment": "test", "Runtime": "cloudfront-js-2.0"}},
        }
        cloudfront.update_function.return_value = {"ETag": "e2"}

        def client_factory(service, **kwargs):
            if service == "s3":
                return image_s3 if kwargs.get("region_name") else s3
            if service == "dynamodb":
                return ddb
            if service == "cloudfront":
                return cloudfront
            raise AssertionError(service)

        env = {
            "IMAGES_REGION": "us-west-2",
            "ALBUMS_TABLE": "albums",
            "ALBUM_MEDIA_TABLE": "media",
            "CATALOG_BUCKET": "catalog",
            "IMAGES_BUCKET": "images",
            "PHOTO_API_DOMAIN": "photos.example.com",
            "SELECTOR_NAME": "selector",
        }
        with patch.dict(os.environ, env), patch.object(publisher.boto3, "client", side_effect=client_factory):
            first = publisher.handler({}, None)
            self.assertEqual(first["albums"], 1)
            self.assertEqual(first["photos"], 2)
            self.assertEqual(first["featured"], 1)
            self.assertTrue(first["published"])
            state = json.loads(stored[publisher.STATE_KEY])
            global_version = state["global"][0]
            self.assertEqual(state["global"][1:], [2, 1])
            self.assertIn(f"catalog/{global_version}/all/page-0.json", stored)
            self.assertIn(f"catalog/{global_version}/featured/page-0.json", stored)
            album_version = state["albums"]["cliffs"]["pool"][0]
            self.assertIn(f"catalog/{album_version}/featured/page-0.json", stored)
            self.assertIn(f"catalog/{album_version}/all/0.json", stored)

            # Second run within retryAfter skips head_object and writes nothing.
            written_keys.clear()
            image_s3.head_object.reset_mock()
            second = publisher.handler({}, None)
            self.assertFalse(second["published"])
            self.assertEqual(second["photosWritten"], 0)
            self.assertEqual(written_keys, [])
            image_s3.head_object.assert_not_called()
