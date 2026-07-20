import base64
import json
import os
import threading
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from test_support import response_body

import media_access
import response_helpers
import secret_helpers
import validation_helpers


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


class ValidationTests(unittest.TestCase):
    def test_json_body_rejects_non_object_and_invalid_json(self):
        for raw in ("[]", "not-json"):
            with self.subTest(raw=raw), self.assertRaises(validation_helpers.ValidationError):
                validation_helpers.parse_json_body({"body": raw})

    def test_base64_json_body(self):
        raw = base64.b64encode(b'{"title":"safe"}').decode()
        self.assertEqual(validation_helpers.parse_json_body({"body": raw, "isBase64Encoded": True})["title"], "safe")

    def test_body_size_is_bounded(self):
        with self.assertRaises(validation_helpers.ValidationError):
            validation_helpers.parse_json_body({"body": '{"x":"12345"}'}, max_bytes=4)

    def test_email_uuid_type_visibility_and_limits(self):
        self.assertEqual(validation_helpers.validate_email(" USER@Example.com "), "user@example.com")
        self.assertEqual(validation_helpers.validate_uuid(ALBUM_ID.upper()), ALBUM_ID)
        for function, value in [
            (validation_helpers.validate_email, "bad"),
            (validation_helpers.validate_uuid, "not-uuid"),
            (validation_helpers.validate_visibility, "secret"),
            (validation_helpers.validate_album_type, "audio"),
            (validation_helpers.validate_limit, "1000"),
        ]:
            with self.subTest(function=function.__name__), self.assertRaises(validation_helpers.ValidationError):
                function(value)


class MediaAccessTests(unittest.TestCase):
    def setUp(self):
        self.image = {
            "rawKey": f"albums/{ALBUM_ID}/original/photo.jpg",
            "thumbKey": f"albums/{ALBUM_ID}/thumbnail/photo.jpg",
            "hlsUrl": f"albums/{ALBUM_ID}/original/photo_hls/photo.m3u8",
            "blurhash": "hash",
        }

    def test_normalization_rejects_traversal_and_cross_album_keys(self):
        for key in ("../secret", "albums\\secret", "", "\x00"):
            with self.subTest(key=key), self.assertRaises(validation_helpers.ValidationError):
                media_access.normalize_object_key(key)
        with self.assertRaises(validation_helpers.ValidationError):
            media_access.validate_album_media_key("albums/other/photo.jpg", album_id=ALBUM_ID)

    def test_public_image_uses_cdn_and_hls(self):
        result = media_access.serialize_image(self.image, "public")
        self.assertTrue(result["url"].startswith("https://media.example.test/"))
        self.assertIn("hlsUrl", result)
        self.assertNotIn("rawKey", result)
        self.assertEqual(len(result["id"]), 24)

    def test_protected_image_uses_presigned_raw_and_omits_hls(self):
        with patch.object(media_access, "presigned_get_url", side_effect=lambda key, **kwargs: f"signed:{key}"):
            result = media_access.serialize_image(self.image, "private")
        self.assertTrue(result["url"].startswith("signed:"))
        self.assertNotIn("hlsUrl", result)
        self.assertNotIn("rawKey", result)
        self.assertNotIn("downloadUrl", result)
        self.assertTrue(result["freshDownloadRequired"])
        self.assertIn("expiresAt", result)
        self.assertGreaterEqual(result["expiresIn"], 60)

    def test_public_summary_minimizes_owner_and_share_data(self):
        album = {
            "albumId": ALBUM_ID,
            "visibility": "public",
            "title": "Title",
            "ownerEmail": "private@example.com",
            "ownerSub": "subject",
            "shareCode": "secret-code",
            "s3Prefix": f"albums/{ALBUM_ID}/",
            "images": [self.image],
        }
        summary = media_access.serialize_album_summary(album)
        for sensitive in ("ownerEmail", "ownerSub", "shareCode", "s3Prefix", "images"):
            self.assertNotIn(sensitive, summary)
        admin = media_access.serialize_album_summary(album, include_admin=True)
        self.assertEqual(admin["ownerEmail"], "private@example.com")

    def test_media_identifier_maps_only_to_manifest_entries(self):
        album = {"images": [self.image]}
        media_id = media_access.media_id_for_key(self.image["rawKey"])
        self.assertIs(media_access.find_image_by_media_id(album, media_id), self.image)
        self.assertIsNone(media_access.find_image_by_media_id(album, "0" * 24))

    def test_cross_album_stored_media_is_omitted(self):
        album = {
            "albumId": ALBUM_ID,
            "visibility": "private",
            "images": [{"rawKey": "albums/22222222-2222-4222-8222-222222222222/original/secret.jpg"}],
        }
        self.assertEqual(media_access.serialize_images(album), [])

    def test_stored_prefix_cannot_widen_canonical_album_namespace(self):
        with self.assertRaises(validation_helpers.ValidationError):
            media_access.validate_album_media_key(
                "albums/other/photo.jpg",
                album={"albumId": ALBUM_ID, "s3Prefix": "albums/other/"},
            )

    def test_approved_single_segment_legacy_prefix_is_record_scoped(self):
        legacy = {
            "albumId": ALBUM_ID,
            "legacyS3Prefix": "albums/summer-portraits-a1b2c3d4/",
            "visibility": "private",
            "images": [{
                "rawKey": "albums/summer-portraits-a1b2c3d4/original/photo.jpg",
                "thumbKey": "albums/summer-portraits-a1b2c3d4/thumbnail/photo.jpg",
            }],
        }
        self.assertEqual(len(media_access.serialize_images(legacy)), 1)
        self.assertEqual(
            media_access.validate_album_media_key(legacy["images"][0]["rawKey"], album=legacy),
            legacy["images"][0]["rawKey"],
        )
        with self.assertRaises(validation_helpers.ValidationError):
            media_access.validate_album_media_key("albums/another-album/photo.jpg", album=legacy)

    def test_legacy_approval_rejects_nested_malformed_or_mutable_prefix(self):
        key = "albums/summer/original/photo.jpg"
        candidates = [
            {"albumId": ALBUM_ID, "s3Prefix": "albums/summer/"},
            {"albumId": ALBUM_ID, "legacyS3Prefix": "albums/summer/nested/"},
            {"albumId": ALBUM_ID, "legacyS3Prefix": "albums/Summer/"},
            {"albumId": ALBUM_ID, "legacyS3Prefix": "albums/../"},
        ]
        for candidate in candidates:
            with self.subTest(candidate=candidate), self.assertRaises(validation_helpers.ValidationError):
                media_access.validate_album_media_key(key, album=candidate)

    def test_external_legacy_cover_url_is_not_reflected(self):
        album = {
            "albumId": ALBUM_ID,
            "visibility": "public",
            "coverImageUrl": "https://tracker.invalid/visitor.jpg",
            "images": [],
        }
        self.assertEqual(media_access.serialize_album_summary(album)["coverImageUrl"], "")

    def test_visibility_tag_is_merged_without_dropping_other_tags(self):
        fake = Mock()
        fake.get_object_tagging.return_value = {"TagSet": [{"Key": "retention", "Value": "keep"}]}
        with patch.object(media_access, "get_s3_client", return_value=fake):
            self.assertTrue(media_access._merge_visibility_tag(self.image["rawKey"], "private"))
        tag_set = fake.put_object_tagging.call_args.kwargs["Tagging"]["TagSet"]
        self.assertIn({"Key": "retention", "Value": "keep"}, tag_set)
        self.assertIn({"Key": "visibility", "Value": "private"}, tag_set)

    def test_missing_object_tagging_is_safe_noop(self):
        fake = Mock()
        fake.get_object_tagging.side_effect = ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObjectTagging")
        with patch.object(media_access, "get_s3_client", return_value=fake):
            self.assertFalse(media_access._merge_visibility_tag(self.image["rawKey"], "private"))

    def test_multi_key_tagging_is_bounded_concurrent_and_deduplicated(self):
        entered = 0
        maximum_active = 0
        active = 0
        release = threading.Event()
        lock = threading.Lock()

        def merge(key, visibility):
            nonlocal entered, maximum_active, active
            with lock:
                entered += 1
                active += 1
                maximum_active = max(maximum_active, active)
                if entered >= 3:
                    release.set()
            self.assertTrue(release.wait(2))
            with lock:
                active -= 1
            return True

        keys = [f"albums/{ALBUM_ID}/original/{index}.jpg" for index in range(20)]
        with patch.dict(os.environ, {"MEDIA_TAG_WORKERS": "4"}), patch.object(
            media_access, "_merge_visibility_tag", side_effect=merge
        ) as merge_mock:
            tagged = media_access.tag_keys_visibility([*keys, keys[0]], "private")
        self.assertEqual(tagged, 20)
        self.assertEqual(merge_mock.call_count, 20)
        self.assertGreaterEqual(maximum_active, 3)
        self.assertLessEqual(maximum_active, 4)

    def test_multi_key_tagging_propagates_provider_failure(self):
        keys = [
            f"albums/{ALBUM_ID}/original/a.jpg",
            f"albums/{ALBUM_ID}/original/b.jpg",
            f"albums/{ALBUM_ID}/original/c.jpg",
        ]

        def merge(key, visibility):
            if key.endswith("b.jpg"):
                raise RuntimeError("provider failure")
            return True

        with patch.object(media_access, "_merge_visibility_tag", side_effect=merge):
            with self.assertRaises(RuntimeError):
                media_access.tag_keys_visibility(keys, "public")


class SecretAndErrorTests(unittest.TestCase):
    def tearDown(self):
        secret_helpers.clear_secret_cache()

    def test_arn_secret_is_preferred_and_cached(self):
        fake = Mock()
        fake.get_secret_value.return_value = {"SecretString": json.dumps({"apiKey": "from-secret"})}
        with patch.dict(os.environ, {"TEST_SECRET_ARN": "arn:test", "TEST_DIRECT": "legacy"}), patch.object(
            secret_helpers, "_secrets_client", return_value=fake
        ):
            first = secret_helpers.resolve_secret(direct_env="TEST_DIRECT", arn_env="TEST_SECRET_ARN", json_keys=("apiKey",))
            second = secret_helpers.resolve_secret(direct_env="TEST_DIRECT", arn_env="TEST_SECRET_ARN", json_keys=("apiKey",))
        self.assertEqual(first, "from-secret")
        self.assertEqual(second, "from-secret")
        fake.get_secret_value.assert_called_once()

    def test_missing_secret_fails_closed(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MISSING_DIRECT", None)
            os.environ.pop("MISSING_ARN", None)
            with self.assertRaises(RuntimeError):
                secret_helpers.resolve_secret(direct_env="MISSING_DIRECT", arn_env="MISSING_ARN")

    def test_internal_error_does_not_echo_exception(self):
        response = response_helpers.internal_error(error=RuntimeError("token=secret-value"), operation="test")
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("secret-value", response["body"])
        self.assertEqual(response_body(response)["code"], "internal_error")


if __name__ == "__main__":
    unittest.main()
