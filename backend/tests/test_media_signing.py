"""CloudFront signed-cookie delivery for protected album media."""

import base64
import json
import os
import unittest
from unittest.mock import Mock, patch

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from test_support import claims, gateway_event, response_body

import add_images
import get_album
import get_album_media
import get_shared_album
import media_access
import media_signing
import response_helpers
import secret_helpers
import update_image
import test_album_write_branch_coverage as write_cases


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
LEGACY_PREFIX = "albums/legacy.album_2019/"
BASE_URL = "https://iantruongphotography.com/private-media"
KEY_PAIR_ID = "K2TESTPUBLICKEY"
SHARE_CODE = "share-code-1234"
# A throwaway key generated per test run: never a deployed signing key.
TEST_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
TEST_KEY_PEM = TEST_KEY.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
).decode("ascii")
ENABLED_ENV = {
    "PRIVATE_MEDIA_DELIVERY": "true",
    "PRIVATE_MEDIA_BASE_URL": BASE_URL + "/",
    "PRIVATE_MEDIA_KEY_PAIR_ID": KEY_PAIR_ID,
    "PRIVATE_MEDIA_SIGNING_KEY": TEST_KEY_PEM,
}


def safe_b64decode(value):
    return base64.b64decode(value.replace("-", "+").replace("_", "=").replace("~", "/"))


def parse_cookie(header):
    pair, *attributes = header.split("; ")
    name, value = pair.split("=", 1)
    return name, value, attributes


def album(visibility="private", **overrides):
    record = {
        "albumId": ALBUM_ID,
        "status": "active",
        "visibility": visibility,
        "type": "photo",
        "title": "Portfolio",
        "createdAt": "2026-01-01T00:00:00Z",
        "ownerSub": "owner-sub",
        "coverImageUrl": f"albums/{ALBUM_ID}/original/cover.jpg",
        "images": [{
            "rawKey": f"albums/{ALBUM_ID}/original/photo one.jpg",
            "thumbKey": f"albums/{ALBUM_ID}/thumbnail/photo one.jpg",
        }],
    }
    record.update(overrides)
    return record


def presigned(key, **_kwargs):
    return f"https://signed.example/{key}"


class SigningCase(unittest.TestCase):
    def setUp(self):
        secret_helpers.clear_secret_cache()
        media_signing._loaded_key = None
        self.addCleanup(secret_helpers.clear_secret_cache)
        self.addCleanup(setattr, media_signing, "_loaded_key", None)
        self.enterContext(patch("media_access.presigned_get_url", side_effect=presigned))

    def enable(self, **overrides):
        self.enterContext(patch.dict(os.environ, {**ENABLED_ENV, **overrides}))


class MediaSigningTests(SigningCase):
    def test_flag_defaults_off_and_accepts_only_true(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PRIVATE_MEDIA_DELIVERY", None)
            self.assertFalse(media_signing.private_media_enabled())
        for value, expected in (("true", True), (" TRUE ", True), ("false", False), ("1", False), ("", False)):
            with self.subTest(value=value), patch.dict(os.environ, {"PRIVATE_MEDIA_DELIVERY": value}):
                self.assertIs(media_signing.private_media_enabled(), expected)

    def test_base_url_is_exact_https_path(self):
        self.enable()
        self.assertEqual(media_signing.private_media_base_url(), BASE_URL)
        for value in ("", "http://iantruongphotography.com/private-media", "https://iantruongphotography.com",
                      "https://iantruongphotography.com/private-media?x=1", "https:///private-media"):
            with self.subTest(value=value), patch.dict(os.environ, {"PRIVATE_MEDIA_BASE_URL": value}):
                with self.assertRaises(RuntimeError):
                    media_signing.private_media_base_url()

    def test_private_media_url_encodes_and_refuses_keys_outside_albums(self):
        self.enable()
        self.assertEqual(
            media_signing.private_media_url(f"/albums/{ALBUM_ID}/original/a b+c~d?.jpg"),
            f"{BASE_URL}/albums/{ALBUM_ID}/original/a%20b%2Bc~d%3F.jpg",
        )
        for key in ("temp-zips/archive.zip", "site/hero/current.jpg", "../albums/x.jpg", "", None):
            with self.subTest(key=key), self.assertRaises(media_access.ValidationError):
                media_signing.private_media_url(key)
        with self.assertRaises(RuntimeError):
            media_access.private_cdn_url(f"albums/{ALBUM_ID}/a.jpg", "http://insecure.example")

    def test_safe_base64_uses_only_the_cloudfront_alphabet(self):
        data = bytes(range(256)) * 3 + b"\xfb\xff"
        encoded = media_signing.cloudfront_safe_b64(data)
        self.assertFalse(set(encoded) & set("+=/"))
        self.assertTrue({"-", "_", "~"} <= set(encoded))
        self.assertEqual(safe_b64decode(encoded), data)

    def test_policy_is_compact_and_ordered(self):
        self.assertEqual(
            media_signing.build_policy(f"{BASE_URL}/albums/{ALBUM_ID}/*", 1_800_000_600.9),
            (
                '{"Statement":[{"Resource":"' + BASE_URL + f'/albums/{ALBUM_ID}/*",'
                '"Condition":{"DateLessThan":{"AWS:EpochTime":1800000600}}}]}'
            ).encode(),
        )

    def test_signature_is_rsa_sha1_over_policy_bytes_and_key_is_cached(self):
        self.enable()
        policy = media_signing.build_policy(f"{BASE_URL}/albums/{ALBUM_ID}/*", 1_800_000_600)
        with patch(
            "cryptography.hazmat.primitives.serialization.load_pem_private_key",
            wraps=serialization.load_pem_private_key,
        ) as loader:
            first = media_signing.sign_policy(policy)
            second = media_signing.sign_policy(policy)
        self.assertEqual(loader.call_count, 1)
        self.assertEqual(first, second)
        TEST_KEY.public_key().verify(safe_b64decode(first), policy, padding.PKCS1v15(), hashes.SHA1())
        with self.assertRaises(InvalidSignature):
            TEST_KEY.public_key().verify(safe_b64decode(first), policy + b" ", padding.PKCS1v15(), hashes.SHA1())

    def test_rotated_key_material_is_reloaded(self):
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        other_pem = other.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        ).decode("ascii")
        policy = b"{}"
        self.enable()
        media_signing.sign_policy(policy)
        with patch.dict(os.environ, {"PRIVATE_MEDIA_SIGNING_KEY": other_pem}):
            signature = media_signing.sign_policy(policy)
        other.public_key().verify(safe_b64decode(signature), policy, padding.PKCS1v15(), hashes.SHA1())

    def test_signing_key_is_read_from_the_exact_secure_parameter(self):
        self.enable(PRIVATE_MEDIA_SIGNING_KEY="", PRIVATE_MEDIA_SIGNING_KEY_PARAMETER="/ian-website/test/private-media-signing-key")
        client = Mock()
        client.get_parameter.return_value = {"Parameter": {"Value": TEST_KEY_PEM}}
        with patch.object(secret_helpers, "_ssm_client", return_value=client):
            media_signing.sign_policy(b"{}")
            media_signing.sign_policy(b"{}")
        client.get_parameter.assert_called_once_with(
            Name="/ian-website/test/private-media-signing-key", WithDecryption=True,
        )

    def test_cookies_are_scoped_per_album_prefix_and_expire_with_the_ttl(self):
        self.enable()
        now = 1_800_000_000
        cookies = media_signing.signed_cookies_for_prefixes(
            (f"albums/{ALBUM_ID}/", LEGACY_PREFIX), ttl_seconds=600, now=now,
        )
        self.assertEqual(len(cookies), 6)
        for index, prefix in enumerate((f"albums/{ALBUM_ID}/", LEGACY_PREFIX)):
            triple = [parse_cookie(value) for value in cookies[index * 3:index * 3 + 3]]
            self.assertEqual(
                [name for name, _value, _attributes in triple],
                ["CloudFront-Policy", "CloudFront-Signature", "CloudFront-Key-Pair-Id"],
            )
            for _name, _value, attributes in triple:
                self.assertEqual(attributes, [
                    f"Path=/private-media/{prefix.rstrip('/')}", "Max-Age=600", "Secure", "HttpOnly", "SameSite=Lax",
                ])
            policy = safe_b64decode(triple[0][1])
            self.assertEqual(json.loads(policy), {"Statement": [{
                "Resource": f"{BASE_URL}/{prefix}*",
                "Condition": {"DateLessThan": {"AWS:EpochTime": now + 600}},
            }]})
            TEST_KEY.public_key().verify(safe_b64decode(triple[1][1]), policy, padding.PKCS1v15(), hashes.SHA1())
            self.assertEqual(triple[2][1], KEY_PAIR_ID)

    def test_cookies_refuse_prefixes_and_key_ids_outside_the_contract(self):
        self.enable()
        for prefix in ("site/hero/", f"albums/{ALBUM_ID}", "albums/../temp-zips/"):
            with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                media_signing.signed_cookies_for_prefixes((prefix,), ttl_seconds=600)
        for value in ("", "K2 BAD", "K2;Path=/"):
            with self.subTest(key_pair_id=value), patch.dict(os.environ, {"PRIVATE_MEDIA_KEY_PAIR_ID": value}):
                with self.assertRaises(RuntimeError):
                    media_signing.signed_cookies_for_prefixes((f"albums/{ALBUM_ID}/",), ttl_seconds=600)

    def test_album_cookies_use_approved_prefixes_and_the_presigned_ttl(self):
        self.enable(MEDIA_URL_TTL_SECONDS="900")
        with patch.object(media_signing.time, "time", return_value=1_800_000_000.5):
            cookies = media_signing.signed_cookies_for_album(album(legacyS3Prefix=LEGACY_PREFIX))
        self.assertEqual(len(cookies), 6)
        self.assertIn("Max-Age=900", cookies[0])
        self.assertEqual(
            json.loads(safe_b64decode(parse_cookie(cookies[0])[1]))["Statement"][0]["Condition"],
            {"DateLessThan": {"AWS:EpochTime": 1_800_000_900}},
        )
        # An unapproved mutable s3Prefix never widens the cookie scope.
        self.assertEqual(len(media_signing.signed_cookies_for_album(album(s3Prefix="albums/other/"))), 3)

    def test_delivery_is_off_for_disabled_flag_public_or_malformed_albums(self):
        self.assertEqual(media_signing.private_media_delivery(album(), operation="test"), media_signing.DISABLED)
        self.enable()
        for value in (album("public"), None, {**album(), "visibility": "pending"}):
            with self.subTest(album=value):
                self.assertEqual(media_signing.private_media_delivery(value, operation="test"), media_signing.DISABLED)
        delivery = media_signing.private_media_delivery(album("unlisted"), operation="test")
        self.assertEqual(delivery.base_url, BASE_URL)
        self.assertEqual(len(delivery.cookies), 3)

    def test_signing_failure_falls_back_without_logging_secret_material(self):
        self.enable(PRIVATE_MEDIA_SIGNING_KEY="-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----")
        with self.assertLogs("photography_api.media_signing", level="WARNING") as logs:
            delivery = media_signing.private_media_delivery(album(), operation="get_album")
        self.assertEqual(delivery, media_signing.DISABLED)
        self.assertEqual(len(logs.output), 1)
        self.assertIn("private_media_signing_failed operation=get_album error_type=", logs.output[0])
        self.assertNotIn("not-a-key", logs.output[0])
        self.assertNotIn(ALBUM_ID, logs.output[0])


class ResponseCookieTests(unittest.TestCase):
    def test_cookies_are_emitted_only_when_present(self):
        self.assertNotIn("cookies", response_helpers.json_response(200, {}))
        self.assertNotIn("cookies", response_helpers.json_response(200, {}, cookies=[]))
        response = response_helpers.json_response(200, {}, cookies=("a=1", "b=2"))
        self.assertEqual(response["cookies"], ["a=1", "b=2"])
        self.assertNotIn("Set-Cookie", response["headers"])


class SerializerTests(SigningCase):
    def preview_metadata(self, raw_key):
        media_id = media_access.media_id_for_key(raw_key)
        return {media_id: {
            "status": "ready",
            "previewVersion": media_access.PREVIEW_VERSION,
            "albumId": ALBUM_ID,
            "mediaId": media_id,
            "previewKeys": media_access.expected_preview_keys(ALBUM_ID, raw_key),
        }}

    def test_protected_images_use_the_private_cdn_only_when_a_base_is_supplied(self):
        record = album()
        raw_key = record["images"][0]["rawKey"]
        metadata = self.preview_metadata(raw_key)
        image = media_access.serialize_images(
            record, preview_metadata_by_id=metadata, private_media_base=BASE_URL,
        )[0]
        self.assertEqual(image["url"], f"{BASE_URL}/albums/{ALBUM_ID}/original/photo%20one.jpg")
        self.assertEqual(image["thumbnailUrl"], f"{BASE_URL}/albums/{ALBUM_ID}/thumbnail/photo%20one.jpg")
        self.assertTrue(all(item["url"].startswith(f"{BASE_URL}/albums/{ALBUM_ID}/preview/v3/")
                            for item in image["previewSrcSet"]))
        self.assertTrue(image["freshDownloadRequired"])
        self.assertNotIn("downloadUrl", image)
        self.assertIn("expiresAt", image)

        legacy = media_access.serialize_images(record, preview_metadata_by_id=metadata)[0]
        self.assertEqual(legacy["url"], f"https://signed.example/{raw_key}")
        self.assertTrue(all(item["url"].startswith("https://signed.example/") for item in legacy["previewSrcSet"]))

    def test_protected_hls_is_emitted_only_with_cookie_delivery(self):
        record = album(type="video", images=[{
            "rawKey": f"albums/{ALBUM_ID}/original/clip.mp4",
            "hlsUrl": f"albums/{ALBUM_ID}/original/clip_hls/clip.m3u8",
        }])
        self.assertNotIn("hlsUrl", media_access.serialize_images(record, preview_metadata_by_id={})[0])
        image = media_access.serialize_images(record, preview_metadata_by_id={}, private_media_base=BASE_URL)[0]
        self.assertEqual(image["hlsUrl"], f"{BASE_URL}/albums/{ALBUM_ID}/original/clip_hls/clip.m3u8")

    def test_public_albums_ignore_a_private_base(self):
        record = album("public", type="video", images=[{
            "rawKey": f"albums/{ALBUM_ID}/original/clip.mp4",
            "hlsUrl": f"albums/{ALBUM_ID}/original/clip_hls/clip.m3u8",
        }])
        image = media_access.serialize_images(record, preview_metadata_by_id={}, private_media_base=BASE_URL)[0]
        self.assertEqual(image["url"], f"https://media.example.test/albums/{ALBUM_ID}/original/clip.mp4")
        self.assertEqual(image["hlsUrl"], f"https://media.example.test/albums/{ALBUM_ID}/original/clip_hls/clip.m3u8")
        self.assertEqual(image["downloadUrl"], image["url"])

    def test_downloads_summaries_and_qr_codes_stay_presigned(self):
        key = f"albums/{ALBUM_ID}/original/photo.jpg"
        self.assertEqual(
            media_access.media_url(key, "private", download_filename="photo.jpg", private_media_base=BASE_URL),
            f"https://signed.example/{key}",
        )
        qr_key = f"albums/{ALBUM_ID}/qr/v1/{'a' * 24}.svg"
        detail = media_access.serialize_album_detail(
            album("unlisted", isShared=True, shareCode=SHARE_CODE, qrCodeKey=qr_key)
        )
        self.assertEqual(detail["coverImageUrl"], f"https://signed.example/albums/{ALBUM_ID}/original/cover.jpg")
        self.assertEqual(detail["qrCodeUrl"], f"https://signed.example/{qr_key}")


class HandlerCookieTests(SigningCase):
    def owner_get_album(self, record):
        with patch.object(get_album.table, "get_item", return_value={"Item": record}), patch.object(
            get_album, "get_verified_claims", return_value=claims(subject="owner-sub")
        ):
            return get_album.handler({"pathParameters": {"albumId": ALBUM_ID}}, None)

    def assert_album_cookies(self, response, prefixes):
        paths = [
            [attribute for attribute in parse_cookie(value)[2] if attribute.startswith("Path=")][0]
            for value in response["cookies"]
        ]
        self.assertEqual(paths, [f"Path=/private-media/{prefix.rstrip('/')}" for prefix in prefixes for _ in range(3)])

    def test_get_album_attaches_cookies_for_each_protected_prefix(self):
        self.enable()
        response = self.owner_get_album(album(legacyS3Prefix=LEGACY_PREFIX))
        self.assertEqual(response["statusCode"], 200)
        self.assert_album_cookies(response, (f"albums/{ALBUM_ID}/", LEGACY_PREFIX))
        body = response_body(response)
        self.assertTrue(body["images"][0]["url"].startswith(f"{BASE_URL}/albums/{ALBUM_ID}/"))
        self.assertTrue(body["album"]["coverImageUrl"].startswith("https://signed.example/"))
        self.assertEqual(response["headers"]["Cache-Control"], "private, no-store")

    def test_get_album_public_and_disabled_responses_are_unchanged(self):
        self.enable()
        with patch.object(get_album.table, "get_item", return_value={"Item": album("public")}), patch.object(
            get_album, "get_verified_claims", return_value=None
        ):
            public = get_album.handler({"pathParameters": {"albumId": ALBUM_ID}}, None)
        self.assertNotIn("cookies", public)
        self.assertTrue(response_body(public)["images"][0]["url"].startswith("https://media.example.test/"))
        with patch.dict(os.environ, {"PRIVATE_MEDIA_DELIVERY": "false"}):
            disabled = self.owner_get_album(album())
        self.assertNotIn("cookies", disabled)
        self.assertTrue(response_body(disabled)["images"][0]["url"].startswith("https://signed.example/"))

    def test_get_album_signing_failure_falls_back_to_presigned_urls(self):
        self.enable(PRIVATE_MEDIA_SIGNING_KEY="")
        with self.assertLogs("photography_api.media_signing", level="WARNING"):
            response = self.owner_get_album(album())
        self.assertEqual(response["statusCode"], 200)
        self.assertNotIn("cookies", response)
        image = response_body(response)["images"][0]
        self.assertTrue(image["url"].startswith("https://signed.example/"))
        self.assertNotIn("hlsUrl", image)

    def test_get_album_denied_viewer_never_receives_cookies(self):
        self.enable()
        with patch.object(get_album.table, "get_item", return_value={"Item": album()}), patch.object(
            get_album, "get_verified_claims", return_value=None
        ):
            response = get_album.handler({"pathParameters": {"albumId": ALBUM_ID}}, None)
        self.assertEqual(response["statusCode"], 401)
        self.assertNotIn("cookies", response)

    def test_shared_album_attaches_cookies_after_share_authorization(self):
        self.enable()
        record = album("unlisted", isShared=True, shareCode=SHARE_CODE)
        table = Mock()
        table.query.return_value = {"Items": [record]}
        table.get_item.return_value = {"Item": record}
        with patch.object(get_shared_album, "table", table), patch.object(
            get_shared_album, "verify_turnstile", return_value=True
        ), patch.object(get_shared_album, "check_rate_limit", return_value=True), patch.object(
            get_shared_album, "_audit"
        ):
            response = get_shared_album.handler({
                "pathParameters": {"shareCode": SHARE_CODE},
                "headers": {"X-Turnstile-Token": "token"},
                "requestContext": {"http": {"sourceIp": "192.0.2.8"}},
            }, None)
        self.assertEqual(response["statusCode"], 200)
        self.assert_album_cookies(response, (f"albums/{ALBUM_ID}/",))
        self.assertTrue(response_body(response)["images"][0]["url"].startswith(f"{BASE_URL}/"))

    def test_admin_media_page_attaches_cookies_for_protected_albums(self):
        self.enable()
        for visibility, expected in (("private", 3), ("public", 0)):
            with self.subTest(visibility=visibility), patch.object(
                get_album_media.albums_table, "get_item", return_value={"Item": album(visibility)}
            ):
                response = get_album_media.handler(gateway_event(
                    claims(groups=["Admins"]), pathParameters={"albumId": ALBUM_ID}, queryStringParameters={},
                ), None)
            self.assertEqual(response["statusCode"], 200)
            self.assertEqual(len(response.get("cookies", [])), expected)
            if expected:
                self.assertTrue(response_body(response)["items"][0]["url"].startswith(f"{BASE_URL}/"))

    def test_add_images_response_carries_cookies_for_protected_albums(self):
        self.enable()
        case = write_cases.AddImagesBranchTests()
        case.setUp()
        case.table.get_item.return_value = {"Item": write_cases.album(visibility="private")}
        response = case._call({"images": [{"rawKey": write_cases.RAW_KEY}]})
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(len(response["cookies"]), 3)
        self.assertTrue(response_body(response)["items"][0]["url"].startswith(f"{BASE_URL}/albums/"))
        case.table.get_item.return_value = {"Item": write_cases.album()}
        self.assertNotIn("cookies", case._call({"images": [{"rawKey": write_cases.RAW_KEY}]}))

    def test_update_image_response_carries_cookies_for_protected_albums(self):
        self.enable()
        case = write_cases.UpdateImageBranchTests()
        record = write_cases.album(
            visibility="unlisted",
            images=[{"rawKey": write_cases.RAW_KEY, "thumbKey": write_cases.THUMB_KEY}],
        )
        response, _table = case._call({"rawKey": write_cases.RAW_KEY, "blurhash": "new"}, record)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(len(response["cookies"]), 3)
        self.assertTrue(response_body(response)["item"]["url"].startswith(f"{BASE_URL}/albums/"))


if __name__ == "__main__":
    unittest.main()
