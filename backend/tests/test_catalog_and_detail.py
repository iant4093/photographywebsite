import unittest
from decimal import Decimal
from unittest.mock import patch

from boto3.dynamodb.conditions import ConditionExpressionBuilder

from test_support import claims, gateway_event, response_body

import get_album
import get_albums


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


def album(visibility="public", **overrides):
    record = {
        "albumId": ALBUM_ID,
        "status": "active",
        "visibility": visibility,
        "type": "photo",
        "title": "Portfolio",
        "description": "Description",
        "category": "Portraits",
        "createdAt": "2026-01-01T00:00:00Z",
        "ownerEmail": "owner@example.com",
        "ownerSub": "owner-sub",
        "shareCode": "not-for-public",
        "s3Prefix": f"albums/{ALBUM_ID}/",
        "coverImageUrl": f"albums/{ALBUM_ID}/original/cover.jpg",
        "images": [{"rawKey": f"albums/{ALBUM_ID}/original/photo.jpg"}],
    }
    record.update(overrides)
    return record


class CatalogTests(unittest.TestCase):
    def test_photo_filter_includes_legacy_records_without_type(self):
        built = ConditionExpressionBuilder().build_expression(get_albums._type_filter("photo"))

        self.assertIn("attribute_not_exists", built.condition_expression)
        self.assertEqual(set(built.attribute_name_placeholders.values()), {"type"})
        self.assertEqual(set(built.attribute_value_placeholders.values()), {"photo"})

    def test_video_filter_does_not_include_records_without_type(self):
        built = ConditionExpressionBuilder().build_expression(get_albums._type_filter("video"))

        self.assertNotIn("attribute_not_exists", built.condition_expression)
        self.assertEqual(set(built.attribute_value_placeholders.values()), {"video"})

    def test_anonymous_private_query_is_forced_public(self):
        captured = {}

        def fetch(**kwargs):
            captured.update(kwargs)
            return [album("public")], None

        event = {"queryStringParameters": {"visibility": "private", "limit": "10"}}
        with patch.object(get_albums, "get_verified_claims", return_value=None), patch.object(
            get_albums, "_fetch_page", side_effect=fetch
        ):
            response = get_albums.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(captured["visibility"], "public")
        item = response_body(response)["items"][0]
        self.assertNotIn("ownerEmail", item)
        self.assertNotIn("shareCode", item)

    def test_non_admin_owner_email_filter_is_forbidden(self):
        event = {
            "queryStringParameters": {
                "visibility": "private",
                "ownerEmail": "attacker@example.com",
                "limit": "10",
            }
        }
        with patch.object(
            get_albums, "get_verified_claims", return_value=claims(subject="owner-sub", email="owner@example.com")
        ), patch.object(get_albums, "_fetch_page") as fetch:
            response = get_albums.handler(event, None)
        self.assertEqual(response["statusCode"], 403)
        fetch.assert_not_called()

    def test_admin_owner_email_filter_is_exact_and_not_in_cursor_scope(self):
        captured = {}

        def fetch(**kwargs):
            captured.update(kwargs)
            return [album("private")], None

        event = {"queryStringParameters": {"ownerEmail": "OWNER@Example.com", "limit": "10"}}
        with patch.object(get_albums, "get_verified_claims", return_value=claims(groups=["Admins"])), patch.object(
            get_albums, "_fetch_page", side_effect=fetch
        ), patch.object(get_albums, "decode_cursor", return_value=None) as decode:
            response = get_albums.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(captured["admin_owner_email"], "owner@example.com")
        self.assertTrue(captured["admin_all"])
        self.assertNotIn("owner@example.com", decode.call_args.args[1])

    def test_non_admin_cannot_list_unlisted(self):
        event = {"queryStringParameters": {"visibility": "unlisted"}}
        with patch.object(get_albums, "get_verified_claims", return_value=claims()):
            response = get_albums.handler(event, None)
        self.assertEqual(response["statusCode"], 403)

    def test_admin_all_includes_admin_fields(self):
        event = {"queryStringParameters": {"visibility": "all", "limit": "10"}}
        with patch.object(get_albums, "get_verified_claims", return_value=claims(groups=["Admins"])), patch.object(
            get_albums, "_fetch_page", return_value=([album("private")], None)
        ):
            response = get_albums.handler(event, None)
        item = response_body(response)["items"][0]
        self.assertEqual(item["ownerSub"], "owner-sub")

    def test_pending_and_malformed_records_are_not_listed(self):
        records = [album(status="pending"), album(visibility="unknown")]
        with patch.object(get_albums, "get_verified_claims", return_value=None), patch.object(
            get_albums, "_fetch_page", return_value=(records, None)
        ):
            response = get_albums.handler({"queryStringParameters": {"limit": "10"}}, None)
        self.assertEqual(response_body(response)["items"], [])

    def test_legacy_anonymous_shape_is_safe_array(self):
        with patch.object(get_albums, "get_verified_claims", return_value=None), patch.object(
            get_albums, "_fetch_page", return_value=([album()], None)
        ):
            response = get_albums.handler({"queryStringParameters": {}}, None)
        self.assertIsInstance(response_body(response), list)


class AlbumDetailTests(unittest.TestCase):
    def _event(self):
        return {"pathParameters": {"albumId": ALBUM_ID}}

    def test_public_detail_uses_minimal_dto(self):
        stored_album = album(
            images=[{
                "rawKey": f"albums/{ALBUM_ID}/original/photo.jpg",
                "width": Decimal("6000"),
                "thumbnailTime": Decimal("1.25"),
            }]
        )
        with patch.object(get_album.table, "get_item", return_value={"Item": stored_album}), patch.object(
            get_album, "get_verified_claims", return_value=None
        ):
            response = get_album.handler(self._event(), None)
        body = response_body(response)
        self.assertEqual(response["statusCode"], 200)
        self.assertNotIn("ownerEmail", body["album"])
        self.assertNotIn("rawKey", body["images"][0])
        self.assertEqual(body["images"][0]["width"], 6000)
        self.assertEqual(body["images"][0]["thumbnailTime"], 1.25)

    def test_private_detail_requires_owner(self):
        private = album("private")
        with patch.object(get_album.table, "get_item", return_value={"Item": private}), patch.object(
            get_album, "get_verified_claims", return_value=None
        ):
            response = get_album.handler(self._event(), None)
        self.assertEqual(response["statusCode"], 401)

    def test_private_owner_gets_presigned_media_without_internal_keys(self):
        private = album("private")
        with patch.object(get_album.table, "get_item", return_value={"Item": private}), patch.object(
            get_album, "get_verified_claims", return_value=claims(subject="owner-sub")
        ), patch("media_access.presigned_get_url", return_value="https://signed.example"):
            response = get_album.handler(self._event(), None)
        image = response_body(response)["images"][0]
        self.assertEqual(image["url"], "https://signed.example")
        self.assertNotIn("rawKey", image)
        self.assertNotIn("downloadUrl", image)
        self.assertTrue(image["freshDownloadRequired"])

    def test_admin_detail_may_receive_management_keys(self):
        private = album("private")
        with patch.object(get_album.table, "get_item", return_value={"Item": private}), patch.object(
            get_album, "get_verified_claims", return_value=claims(groups=["Admins"])
        ), patch("media_access.presigned_get_url", return_value="https://signed.example"):
            response = get_album.handler(self._event(), None)
        self.assertEqual(response_body(response)["images"][0]["rawKey"], private["images"][0]["rawKey"])


if __name__ == "__main__":
    unittest.main()
