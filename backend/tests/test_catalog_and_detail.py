import unittest
import os
from decimal import Decimal
from unittest.mock import patch

from boto3.dynamodb.conditions import ConditionExpressionBuilder
from botocore.exceptions import ClientError

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
    def setUp(self):
        self.gallery_order = patch.object(get_albums, "load_gallery_settings", return_value={})
        self.gallery_order.start()
        self.addCleanup(self.gallery_order.stop)

    def test_public_summary_query_uses_additive_include_index(self):
        projected = album()
        projected.pop("images")
        projected["imageCount"] = Decimal("12")
        with patch.dict(
            os.environ,
            {
                "ALBUM_INDEX_DEPLOYMENT_PHASE": "both",
                "PUBLIC_SUMMARY_INDEX": "VisibilityCreatedAtSummaryIndex",
                "VISIBILITY_CREATED_AT_INDEX": "VisibilityCreatedAtIndex",
            },
        ), patch.object(
            get_albums.table,
            "query",
            return_value={"Items": [projected]},
        ) as query:
            records, cursor = get_albums._fetch_page(
                visibility="public",
                album_type="photo",
                limit=10,
                start_key=None,
                public_summary_only=True,
            )

        self.assertEqual(records, [projected])
        self.assertIsNone(cursor)
        params = query.call_args.kwargs
        self.assertEqual(params["IndexName"], "VisibilityCreatedAtSummaryIndex")
        self.assertFalse(params["ScanIndexForward"])
        built = ConditionExpressionBuilder().build_expression(params["FilterExpression"])
        self.assertIn("attribute_not_exists", built.condition_expression)

    def test_missing_summary_index_falls_back_to_existing_visibility_index(self):
        unavailable = ClientError(
            {"Error": {"Code": "ResourceNotFoundException", "Message": "not active"}},
            "Query",
        )
        with patch.dict(
            os.environ,
            {
                "ALBUM_INDEX_DEPLOYMENT_PHASE": "both",
                "PUBLIC_SUMMARY_INDEX": "VisibilityCreatedAtSummaryIndex",
                "VISIBILITY_CREATED_AT_INDEX": "VisibilityCreatedAtIndex",
            },
        ), patch.object(
            get_albums.table,
            "query",
            side_effect=[unavailable, {"Items": [album()]}],
        ) as query:
            records, _ = get_albums._fetch_page(
                visibility="public",
                album_type=None,
                limit=10,
                start_key={"albumId": "cursor", "visibility": "public", "createdAt": "now"},
                public_summary_only=True,
            )

        self.assertEqual(records, [album()])
        self.assertEqual(query.call_args_list[0].kwargs["IndexName"], "VisibilityCreatedAtSummaryIndex")
        self.assertEqual(query.call_args_list[1].kwargs["IndexName"], "VisibilityCreatedAtIndex")
        self.assertEqual(
            query.call_args_list[1].kwargs["ExclusiveStartKey"],
            {"albumId": "cursor", "visibility": "public", "createdAt": "now"},
        )

    def test_legacy_missing_image_count_falls_back_without_count_regression(self):
        projected_legacy = album()
        projected_legacy.pop("images")
        full_legacy = album(images=[
            {"rawKey": f"albums/{ALBUM_ID}/original/{index}.jpg"}
            for index in range(3)
        ])
        with patch.dict(
            os.environ,
            {
                "ALBUM_INDEX_DEPLOYMENT_PHASE": "both",
                "PUBLIC_SUMMARY_INDEX": "VisibilityCreatedAtSummaryIndex",
                "VISIBILITY_CREATED_AT_INDEX": "VisibilityCreatedAtIndex",
            },
        ), patch.object(
            get_albums.table,
            "query",
            side_effect=[{"Items": [projected_legacy]}, {"Items": [full_legacy]}],
        ) as query:
            records, _ = get_albums._fetch_page(
                visibility="public",
                album_type="photo",
                limit=10,
                start_key=None,
                public_summary_only=True,
            )

        self.assertEqual(records, [full_legacy])
        self.assertEqual(query.call_args_list[0].kwargs["IndexName"], "VisibilityCreatedAtSummaryIndex")
        self.assertEqual(query.call_args_list[1].kwargs["IndexName"], "VisibilityCreatedAtIndex")

    def test_summary_fallback_keeps_prior_items_and_resumes_at_page_boundary(self):
        first = album(
            albumId="11111111-1111-4111-8111-111111111110",
            createdAt="2026-03-01T00:00:00Z",
            imageCount=Decimal("1"),
        )
        first.pop("images")
        second = album(
            albumId="11111111-1111-4111-8111-111111111109",
            createdAt="2026-02-01T00:00:00Z",
            imageCount=Decimal("1"),
        )
        second.pop("images")
        incomplete = album(
            albumId="11111111-1111-4111-8111-111111111108",
            createdAt="2026-01-01T00:00:00Z",
        )
        incomplete.pop("images")
        full = album(albumId=incomplete["albumId"], createdAt=incomplete["createdAt"])
        resume_key = {
            "albumId": second["albumId"],
            "visibility": "public",
            "createdAt": second["createdAt"],
        }
        with patch.dict(
            os.environ,
            {
                "ALBUM_INDEX_DEPLOYMENT_PHASE": "both",
                "PUBLIC_SUMMARY_INDEX": "VisibilityCreatedAtSummaryIndex",
                "VISIBILITY_CREATED_AT_INDEX": "VisibilityCreatedAtIndex",
            },
        ), patch.object(
            get_albums.table,
            "query",
            side_effect=[
                {"Items": [first, second], "LastEvaluatedKey": resume_key},
                {"Items": [incomplete]},
                {"Items": [full]},
            ],
        ) as query:
            records, cursor = get_albums._fetch_page(
                visibility="public",
                album_type="photo",
                limit=3,
                start_key=None,
                public_summary_only=True,
            )

        self.assertEqual(records, [first, second, full])
        self.assertIsNone(cursor)
        self.assertEqual(query.call_args_list[2].kwargs["IndexName"], "VisibilityCreatedAtIndex")
        self.assertEqual(query.call_args_list[2].kwargs["ExclusiveStartKey"], resume_key)

    def test_projected_image_count_preserves_public_response_without_manifest(self):
        projected = album()
        projected.pop("images")
        projected["imageCount"] = Decimal("37")
        captured = {}

        def fetch(**kwargs):
            captured.update(kwargs)
            return [projected], None

        with patch.object(get_albums, "get_verified_claims", return_value=None), patch.object(
            get_albums, "_fetch_page", side_effect=fetch
        ):
            response = get_albums.handler({"queryStringParameters": {"limit": "10", "type": "photo"}}, None)

        self.assertTrue(captured["public_summary_only"])
        self.assertEqual(response_body(response)["items"][0]["imageCount"], 37)

    def test_admin_public_query_uses_summary_index_path(self):
        captured = {}

        def fetch(**kwargs):
            captured.update(kwargs)
            return [album()], None

        event = {"queryStringParameters": {"visibility": "public", "limit": "10"}}
        with patch.object(get_albums, "get_verified_claims", return_value=claims(groups=["Admins"])), patch.object(
            get_albums, "_fetch_page", side_effect=fetch
        ):
            response = get_albums.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        self.assertTrue(captured["public_summary_only"])

    def test_public_photo_response_includes_configured_gallery_order(self):
        with patch.object(get_albums, "get_verified_claims", return_value=None), patch.object(
            get_albums, "_fetch_page", return_value=([album()], None)
        ), patch.object(
            get_albums,
            "load_gallery_settings",
            return_value={
                "photo": {
                    "albums": {ALBUM_ID: 4},
                    "categories": {"Portraits": 2},
                }
            },
        ):
            response = get_albums.handler(
                {"queryStringParameters": {"limit": "10", "type": "photo"}}, None
            )
        self.assertEqual(response_body(response)["items"][0]["galleryOrder"], 4)
        self.assertEqual(response_body(response)["items"][0]["galleryCategoryOrder"], 2)

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

    def test_admin_private_owner_sub_uses_owner_index_scope(self):
        captured = {}

        def fetch(**kwargs):
            captured.update(kwargs)
            return [album("private", ownerSub=ALBUM_ID)], None

        event = {
            "queryStringParameters": {
                "visibility": "private",
                "ownerSub": ALBUM_ID,
                "limit": "40",
            }
        }
        with patch.object(
            get_albums,
            "get_verified_claims",
            return_value=claims(groups=["Admins"]),
        ), patch.object(get_albums, "_fetch_page", side_effect=fetch):
            response = get_albums.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(captured["owner_sub"], ALBUM_ID)
        self.assertFalse(captured["admin_all"])
        self.assertIsNone(captured["admin_owner_email"])

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

    def test_verified_admin_public_detail_includes_management_keys_and_is_not_cacheable(self):
        stored_album = album()
        with patch.object(get_album.table, "get_item", return_value={"Item": stored_album}), patch.object(
            get_album, "get_verified_claims", return_value=claims(groups=["Admins"])
        ):
            response = get_album.handler(self._event(), None)
        body = response_body(response)
        self.assertEqual(body["images"][0]["rawKey"], stored_album["images"][0]["rawKey"])
        self.assertEqual(response["headers"]["Cache-Control"], "private, no-store")

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
