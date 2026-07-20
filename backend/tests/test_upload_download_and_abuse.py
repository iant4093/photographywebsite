import io
import json
import os
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from test_support import claims, response_body

import contact
import get_download_url
import get_shared_album
import get_upload_url
import media_access
import security_helpers


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
RAW_KEY = f"albums/{ALBUM_ID}/original/photo.jpg"
MEDIA_ID = media_access.media_id_for_key(RAW_KEY)


class UploadTests(unittest.TestCase):
    def test_upload_intent_enforces_mime_extension_and_size(self):
        valid = {
            "albumId": ALBUM_ID,
            "filename": "photo.jpg",
            "contentType": "image/jpeg",
            "size": 1024,
            "kind": "original",
        }
        self.assertEqual(get_upload_url._validate_upload_intent(valid)[0], ALBUM_ID)
        for mutation in (
            {"filename": "photo.exe"},
            {"contentType": "text/html"},
            {"size": 101 * 1024 * 1024},
            {"size": 0},
            {"kind": "arbitrary"},
        ):
            with self.subTest(mutation=mutation), self.assertRaises(Exception):
                get_upload_url._validate_upload_intent({**valid, **mutation})

    def test_server_controls_key_and_pending_tag(self):
        event = {
            "body": json.dumps(
                {
                    "albumId": ALBUM_ID,
                    "filename": "../../chosen-name.jpg",
                    "contentType": "image/jpeg",
                    "size": 1234,
                    "kind": "original",
                }
            )
        }
        with patch.object(get_upload_url, "require_admin", return_value=None), patch.object(
            get_upload_url.s3, "generate_presigned_url", return_value="https://upload.example"
        ) as generate:
            response = get_upload_url.handler(event, None)
        body = response_body(response)
        self.assertRegex(body["key"], rf"^albums/{ALBUM_ID}/original/[a-f0-9]{{32}}\.jpg$")
        self.assertNotIn("chosen-name", body["key"])
        self.assertEqual(body["requiredHeaders"]["x-amz-tagging"], "visibility=pending")
        params = generate.call_args.kwargs["Params"]
        self.assertEqual(params["ContentLength"], 1234)
        self.assertEqual(params["Tagging"], "visibility=pending")


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.album = {
            "albumId": ALBUM_ID,
            "status": "active",
            "visibility": "public",
            "images": [{"rawKey": RAW_KEY}],
        }

    def _event(self, media_id=MEDIA_ID):
        return {
            "pathParameters": {"albumId": ALBUM_ID},
            "body": json.dumps({"mediaId": media_id}),
            "requestContext": {"http": {"sourceIp": "192.0.2.10"}},
        }

    def test_manifest_media_id_gets_short_lived_attachment_url(self):
        with patch.object(get_download_url, "get_album_record", return_value=self.album), patch.object(
            get_download_url, "get_verified_claims", return_value=None
        ), patch.object(get_download_url, "check_rate_limit", return_value=True), patch.object(
            get_download_url, "presigned_get_url", return_value="https://signed.example"
        ) as presign:
            response = get_download_url.handler(self._event(), None)
        self.assertEqual(response_body(response)["downloadUrl"], "https://signed.example")
        self.assertEqual(presign.call_args.args[0], RAW_KEY)

    def test_arbitrary_or_unknown_media_id_is_not_signed(self):
        with patch.object(get_download_url, "get_album_record", return_value=self.album), patch.object(
            get_download_url, "get_verified_claims", return_value=None
        ), patch.object(get_download_url, "presigned_get_url") as presign:
            response = get_download_url.handler(self._event("0" * 24), None)
        self.assertEqual(response["statusCode"], 404)
        presign.assert_not_called()

    def test_private_non_owner_is_denied(self):
        private = {**self.album, "visibility": "private", "ownerSub": "owner"}
        with patch.object(get_download_url, "get_album_record", return_value=private), patch.object(
            get_download_url, "get_verified_claims", return_value=claims(subject="attacker")
        ):
            response = get_download_url.handler(self._event(), None)
        self.assertEqual(response["statusCode"], 403)

    def test_revoked_share_is_indistinguishable_from_missing(self):
        unlisted = {
            **self.album,
            "visibility": "unlisted",
            "isShared": False,
            "shareCode": "share-code-123",
        }
        event = {**self._event(), "pathParameters": {"shareCode": "share-code-123"}}
        with patch.object(get_download_url, "get_album_record", return_value=unlisted):
            response = get_download_url.handler(event, None)
        self.assertEqual(response["statusCode"], 404)


class AbuseProtectionTests(unittest.TestCase):
    def setUp(self):
        security_helpers._rate_table = None

    def test_rate_limit_resets_then_atomically_increments(self):
        table = Mock()
        table.update_item.side_effect = [
            {"Attributes": {"count": 1}},
            ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem"),
            {"Attributes": {"count": 2}},
        ]
        with patch.object(security_helpers, "_get_rate_table", return_value=table):
            self.assertTrue(security_helpers.check_rate_limit("person@example.com", "login", 2, 60, now=100))
            self.assertTrue(security_helpers.check_rate_limit("person@example.com", "login", 2, 60, now=101))
        first_key = table.update_item.call_args_list[0].kwargs["Key"]["identifier"]
        self.assertNotIn("person@example.com", first_key)

    def test_backend_failure_fails_closed_by_default(self):
        with patch.object(security_helpers, "_get_rate_table", side_effect=RuntimeError("down")):
            self.assertFalse(security_helpers.check_rate_limit("ip", "login", 2, 60, fail_closed=True))
            self.assertTrue(security_helpers.check_rate_limit("ip", "login", 2, 60, fail_closed=False))

    def test_turnstile_checks_hostname_and_action(self):
        payload = json.dumps({"success": True, "hostname": "iantruongphotography.com", "action": "login"}).encode()
        response = Mock()
        response.read.return_value = payload
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.dict(
            os.environ,
            {
                "TURNSTILE_SECRET_KEY": "secret",
                "TURNSTILE_EXPECTED_HOSTNAMES": "iantruongphotography.com",
                "TURNSTILE_LOGIN_ACTION": "login",
            },
        ), patch("urllib.request.urlopen", return_value=response):
            self.assertTrue(security_helpers.verify_turnstile("token", "192.0.2.1", expected_action="login"))
            self.assertFalse(security_helpers.verify_turnstile("token", "192.0.2.1", expected_action="contact"))

    def test_contact_html_escapes_untrusted_fields(self):
        event = {
            "body": json.dumps(
                {
                    "name": "<img src=x onerror=alert(1)>",
                    "email": "user@example.com",
                    "message": "<script>alert(1)</script>",
                    "turnstileToken": "token",
                }
            ),
            "requestContext": {"http": {"sourceIp": "192.0.2.1"}},
        }
        with patch.object(contact, "verify_turnstile", return_value=True), patch.object(
            contact, "check_rate_limit", return_value=True
        ), patch.object(contact, "send_email") as send:
            response = contact.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        html_body = send.call_args.args[2]
        self.assertNotIn("<script>", html_body)
        self.assertIn("&lt;script&gt;", html_body)

    def test_shared_album_requires_turnstile_before_database_lookup(self):
        event = {
            "pathParameters": {"shareCode": "share-code-123"},
            "headers": {"X-Turnstile-Token": "bad"},
            "requestContext": {"http": {"sourceIp": "192.0.2.1"}},
        }
        with patch.object(get_shared_album, "verify_turnstile", return_value=False), patch.object(
            get_shared_album.table, "query"
        ) as query:
            response = get_shared_album.handler(event, None)
        self.assertEqual(response["statusCode"], 403)
        query.assert_not_called()


if __name__ == "__main__":
    unittest.main()
