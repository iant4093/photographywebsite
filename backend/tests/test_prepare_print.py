import json
import os
import unittest
from unittest.mock import Mock, patch

from test_support import response_body

import prepare_print
from botocore.exceptions import ClientError


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
MEDIA_ID = "a" * 24
SHARE_CODE = "secure-share-code"
RAW_KEY = f"albums/{ALBUM_ID}/original/photo.jpg"
THUMB_KEY = f"albums/{ALBUM_ID}/thumbnail/photo.jpg"


def album(**overrides):
    value = {
        "albumId": ALBUM_ID,
        "status": "active",
        "visibility": "public",
        "type": "photo",
        "images": [{"rawKey": RAW_KEY, "thumbKey": THUMB_KEY}],
        "isShared": False,
    }
    value.update(overrides)
    return value


def event(*, path=None, body=None, raw_path="/api/albums/x/print"):
    return {
        "rawPath": raw_path,
        "pathParameters": path or {},
        "body": json.dumps(body or {}),
        "requestContext": {"http": {"sourceIp": "192.0.2.10"}},
    }


class PrintSessionTests(unittest.TestCase):
    def setUp(self):
        prepare_print.reset_caches_for_tests()
        prepare_print._cached_secret = b"unit-test-print-secret-that-is-long-enough"

    def tearDown(self):
        prepare_print.reset_caches_for_tests()

    def test_signed_capability_is_short_lived_scoped_and_tamper_evident(self):
        with patch.object(prepare_print.time, "time", return_value=2_000_000_000):
            token, expires = prepare_print._issue_token(album(), MEDIA_ID, "public")
            payload = prepare_print._verify_token(token)
        self.assertEqual(expires, 2_000_000_300)
        self.assertEqual(payload["a"], ALBUM_ID)
        self.assertEqual(payload["m"], MEDIA_ID)
        self.assertNotIn(RAW_KEY, token)

        tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
        with self.assertRaises(prepare_print.ValidationError):
            prepare_print._verify_token(tampered)
        with patch.object(prepare_print.time, "time", return_value=2_000_000_301), self.assertRaises(
            prepare_print.ValidationError
        ):
            prepare_print._verify_token(token)

    def test_public_private_and_share_authorization_issue_only_a_capability(self):
        public = album()
        with patch.object(prepare_print, "get_album_record", return_value=public), patch.object(
            prepare_print, "get_verified_claims", return_value=None
        ), patch.object(prepare_print, "find_image_by_media_id", return_value=public["images"][0]), patch.object(
            prepare_print, "check_rate_limit", return_value=True
        ), patch.object(prepare_print, "_audit"):
            response = prepare_print.handler(event(path={"albumId": ALBUM_ID}, body={"mediaId": MEDIA_ID}), None)
        self.assertEqual(response["statusCode"], 200)
        payload = response_body(response)
        self.assertIn("sessionToken", payload)
        self.assertNotIn("imageUrl", payload)

        private = album(visibility="private", ownerSub="owner")
        with patch.object(prepare_print, "get_album_record", return_value=private), patch.object(
            prepare_print, "get_verified_claims", return_value=None
        ), patch.object(prepare_print, "_audit"):
            denied = prepare_print.handler(event(path={"albumId": ALBUM_ID}, body={"mediaId": MEDIA_ID}), None)
        self.assertEqual(denied["statusCode"], 401)

        shared = album(visibility="unlisted", isShared=True, shareCode=SHARE_CODE)
        with patch.object(prepare_print, "get_album_record", return_value=shared), patch.object(
            prepare_print, "find_image_by_media_id", return_value=shared["images"][0]
        ), patch.object(prepare_print, "check_rate_limit", return_value=True), patch.object(
            prepare_print, "_audit"
        ):
            allowed = prepare_print.handler(event(path={"shareCode": SHARE_CODE}, body={"mediaId": MEDIA_ID}), None)
        self.assertEqual(allowed["statusCode"], 200)
        token = response_body(allowed)["sessionToken"]
        self.assertNotIn(SHARE_CODE, token)

    def test_redeem_rechecks_album_and_stages_only_the_scoped_image(self):
        record = album()
        with patch.object(prepare_print.time, "time", return_value=2_000_000_000):
            token, _ = prepare_print._issue_token(record, MEDIA_ID, "public")
        with patch.object(prepare_print.time, "time", return_value=2_000_000_010), patch.object(
            prepare_print, "get_album_record", return_value=record
        ), patch.object(prepare_print, "find_image_by_media_id", return_value=record["images"][0]), patch.object(
            prepare_print, "check_rate_limit", return_value=True
        ), patch.object(prepare_print, "_stage_print", return_value="https://media.test/fotomoto/reference.jpg") as stage, patch.object(
            prepare_print, "_audit"
        ):
            response = prepare_print.handler(event(
                raw_path="/api/print/session",
                body={"sessionToken": token},
            ), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response), {"imageUrl": "https://media.test/fotomoto/reference.jpg"})
        stage.assert_called_once_with(record, record["images"][0], MEDIA_ID)

        changed = album(visibility="private")
        with patch.object(prepare_print.time, "time", return_value=2_000_000_010), patch.object(
            prepare_print, "get_album_record", return_value=changed
        ), patch.object(prepare_print, "_audit"):
            denied = prepare_print.handler(event(
                raw_path="/api/print/session",
                body={"sessionToken": token},
            ), None)
        self.assertEqual(denied["statusCode"], 404)

    def test_staging_uses_opaque_paths_and_public_private_visibility_tags(self):
        record = album()
        s3 = Mock()
        s3.head_object.side_effect = [
            {"ContentType": "image/jpeg", "ContentLength": 100},
            {"ContentType": "image/jpeg", "ContentLength": 1000},
            Exception("missing"),
        ]
        # Destination HEAD failures are normally ClientError; exercise the copy
        # contract directly to keep this test independent of botocore internals.
        with patch.object(prepare_print, "_s3_client", return_value=s3), patch.object(
            prepare_print, "_copy_if_needed"
        ) as copy:
            url = prepare_print._stage_print(record, record["images"][0], MEDIA_ID)
        self.assertTrue(url.startswith("https://media.example.test/fotomoto/references/"))
        self.assertNotIn(ALBUM_ID, url)
        self.assertEqual(copy.call_count, 2)
        self.assertEqual(copy.call_args_list[0].kwargs["visibility"], "public")
        self.assertEqual(copy.call_args_list[1].kwargs["visibility"], "private")

    def test_missing_destination_without_list_permission_is_copied(self):
        s3 = Mock()
        s3.head_object.side_effect = ClientError(
            {"Error": {"Code": "403", "Message": "Access Denied"}},
            "HeadObject",
        )
        with patch.object(prepare_print, "_s3_client", return_value=s3):
            prepare_print._copy_if_needed(
                RAW_KEY,
                "fotomoto/originals/opaque_print.jpg",
                visibility="private",
                cache_control="private,no-store",
                print_id="opaque",
                source_etag="etag",
            )
        s3.copy_object.assert_called_once()


if __name__ == "__main__":
    unittest.main()
