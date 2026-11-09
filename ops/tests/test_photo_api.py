"""Regression checks for the exporter's public-only and fallback contracts."""

from decimal import Decimal
import json
import unittest
from unittest.mock import Mock

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

    def test_selector_code_enforces_aws_size_limit_before_publishing(self):
        code = publisher.selector_code({"cliffs": ["version", 1, 0]}, b"test-key", 10)
        self.assertIn(b'"expires":10000', code)
        self.assertNotIn(b"const snapshot = null;", code)
        with self.assertRaisesRegex(RuntimeError, "code limit"):
            publisher.selector_code({"cliffs": ["x" * 12000, 1, 0]}, b"test-key", 10)
