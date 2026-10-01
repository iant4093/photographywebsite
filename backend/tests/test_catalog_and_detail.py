import json
import unittest
import os
from decimal import Decimal
from unittest.mock import Mock, patch

import boto3
from boto3.dynamodb.conditions import ConditionExpressionBuilder
from botocore.exceptions import ClientError
from moto import mock_aws

from test_support import claims, gateway_event, response_body

import get_album
import get_albums
import media_access


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
        # Summary responses hydrate optional hover fields independently of the
        # mocked query; these catalog unit tests must not call live DynamoDB.
        self.enterContext(patch.object(get_albums.dynamodb, "batch_get_item", return_value={"Responses": {}}))

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
                start_key={"albumId": ALBUM_ID, "visibility": "public", "createdAt": "now"},
                public_summary_only=True,
            )

        self.assertEqual(records, [album()])
        self.assertEqual(query.call_args_list[0].kwargs["IndexName"], "VisibilityCreatedAtSummaryIndex")
        self.assertEqual(query.call_args_list[1].kwargs["IndexName"], "VisibilityCreatedAtIndex")
        self.assertEqual(
            query.call_args_list[1].kwargs["ExclusiveStartKey"],
            {"albumId": ALBUM_ID, "visibility": "public", "createdAt": "now"},
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

        with patch.object(get_albums, "get_verified_claims", return_value=claims()), patch.object(
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
        with patch.object(get_albums, "get_verified_claims", return_value=claims()), patch.object(
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
        event = {"queryStringParameters": {"visibility": "private", "limit": "10"}}
        with patch.object(get_albums, "get_verified_claims", return_value=None), patch.object(get_albums, "_fetch_page") as fetch:
            response = get_albums.handler(event, None)
        self.assertEqual(response["statusCode"], 307)
        self.assertEqual(response["headers"]["Location"], "/api/public/albums?limit=10")
        fetch.assert_not_called()

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
        with patch.object(get_albums, "get_verified_claims", return_value=claims()), patch.object(
            get_albums, "_fetch_page", return_value=(records, None)
        ):
            response = get_albums.handler({"queryStringParameters": {"limit": "10"}}, None)
        self.assertEqual(response_body(response)["items"], [])

    def test_legacy_anonymous_shape_is_safe_array(self):
        with patch.object(get_albums, "get_verified_claims", return_value=None), patch.object(
            get_albums, "_legacy_public_items", return_value=[{"albumId": ALBUM_ID}]
        ):
            response = get_albums.handler({"queryStringParameters": {}}, None)
        self.assertIsInstance(response_body(response), list)


class AdminCatalogProjectionTests(unittest.TestCase):
    """The admin scan omits `images` yet returns exactly today's summaries."""

    PHOTO_ID = "11111111-1111-4111-8111-111111111111"
    UNCOUNTED_ID = "22222222-2222-4222-8222-222222222222"
    VIDEO_ID = "33333333-3333-4333-8333-333333333333"
    OTHER_OWNER_ID = "44444444-4444-4444-8444-444444444444"
    OWNER_SUB = "55555555-5555-4555-8555-555555555555"

    def records(self):
        def photo(album_id, visibility, created, **extra):
            raw = f"albums/{album_id}/original/{'a' * 32}.jpg"
            return {
                "albumId": album_id, "status": "active", "visibility": visibility, "type": "photo",
                "title": f"Album {album_id[:2]}", "description": "Description", "category": "Travel",
                "createdAt": created, "uploadedAt": created, "ownerEmail": "owner@example.com",
                "ownerSub": self.OWNER_SUB, "isShared": False, "shareCode": "",
                "coverImageUrl": raw, "coverThumbKey": f"albums/{album_id}/thumbnail/{'b' * 32}.jpg",
                "coverBlurhash": "hash",
                "images": [{"rawKey": raw, "exif": {"lens": "x" * 2000}}, {"rawKey": f"albums/{album_id}/original/two.jpg"}],
                **extra,
            }
        video_raw = f"albums/{self.VIDEO_ID}/original/{'c' * 32}.mp4"
        return [
            photo(self.PHOTO_ID, "public", "2026-03-01T00:00:00Z", imageCount=Decimal("2")),
            photo(self.UNCOUNTED_ID, "private", "2026-02-01T00:00:00Z"),
            {
                **photo(self.VIDEO_ID, "public", "2026-01-01T00:00:00Z", imageCount=Decimal("1")),
                "type": "video", "coverImageUrl": video_raw, "coverThumbKey": f"albums/{self.VIDEO_ID}/thumbnail/v.jpg",
                "images": [{"rawKey": video_raw, "thumbKey": f"albums/{self.VIDEO_ID}/thumbnail/v.jpg",
                            "hlsUrl": f"albums/{self.VIDEO_ID}/original/{'c' * 32}_hls/{'c' * 32}.m3u8",
                            "thumbnailTime": Decimal("2")}],
            },
            {**photo(self.OTHER_OWNER_ID, "unlisted", "2026-04-01T00:00:00Z", imageCount=Decimal("2")),
             "ownerSub": "66666666-6666-4666-8666-666666666666", "ownerEmail": "other@example.com"},
        ]

    def setUp(self):
        self.enterContext(mock_aws())
        self.enterContext(patch.dict(os.environ, {"ALBUM_INDEX_DEPLOYMENT_PHASE": "none"}))
        resource = boto3.resource("dynamodb", region_name="us-west-2")
        table = resource.create_table(
            TableName="albums-projection-test",
            KeySchema=[{"AttributeName": "albumId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "albumId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        for record in self.records():
            table.put_item(Item=record)
        self.enterContext(patch.object(get_albums, "dynamodb", resource))
        self.enterContext(patch.object(get_albums, "table", table))
        self.enterContext(patch.object(get_albums, "load_gallery_settings", return_value={}))
        self.enterContext(patch.object(media_access, "presigned_get_url", side_effect=lambda key, **_: f"https://signed.example/{key}"))
        self.enterContext(patch.object(media_access, "url_expiry_metadata", return_value={"expiresIn": 600, "expiresAt": "fixed"}))

    def admin(self, query):
        with patch.object(get_albums, "get_verified_claims", return_value=claims(groups=["Admins"])):
            response = get_albums.handler({"queryStringParameters": query}, None)
        self.assertEqual(response["statusCode"], 200)
        return response_body(response)["items"]

    def expected(self, records):
        ordered = sorted(records, key=lambda item: item["createdAt"], reverse=True)
        return json.loads(json.dumps(
            [media_access.serialize_album_summary(record, include_admin=True) for record in ordered],
            default=str,
        ))

    def test_admin_scan_projects_summary_fields_and_matches_full_records(self):
        original_scan = get_albums.table.scan
        with patch.object(get_albums.table, "scan", side_effect=original_scan) as scan, patch.object(
            get_albums.dynamodb, "batch_get_item", wraps=get_albums.dynamodb.batch_get_item
        ) as batch:
            items = self.admin({"visibility": "all", "limit": "10"})
        params = scan.call_args.kwargs
        self.assertNotIn("images", params["ProjectionExpression"])
        self.assertNotIn("#images", params["ExpressionAttributeNames"])
        self.assertEqual(params["ExpressionAttributeNames"]["#status"], "status")
        self.assertEqual(params["ExpressionAttributeNames"]["#type"], "type")
        self.assertIn("#imageCount", params["ProjectionExpression"])
        # Only the uncounted photo and the video need their full item.
        requested = sorted(key["albumId"] for key in batch.call_args.kwargs["RequestItems"][get_albums.table.name]["Keys"])
        self.assertEqual(requested, [self.UNCOUNTED_ID, self.VIDEO_ID])
        self.assertEqual(json.dumps(items, sort_keys=False), json.dumps(self.expected(self.records()), sort_keys=False))
        video = next(item for item in items if item["albumId"] == self.VIDEO_ID)
        self.assertIn("coverHlsUrl", video)
        self.assertEqual(next(item for item in items if item["albumId"] == self.UNCOUNTED_ID)["imageCount"], 2)

    def test_projection_shares_attribute_names_with_a_type_and_owner_filter(self):
        original_scan = get_albums.table.scan
        with patch.object(get_albums.table, "scan", side_effect=original_scan) as scan:
            items = self.admin({"visibility": "all", "type": "photo", "ownerEmail": "owner@example.com", "limit": "10"})
        self.assertIn("FilterExpression", scan.call_args.kwargs)
        self.assertEqual(
            [item["albumId"] for item in items], [self.PHOTO_ID, self.UNCOUNTED_ID],
        )
        self.assertEqual(json.dumps(items), json.dumps(self.expected(self.records()[:2])))

    def test_each_scan_gets_a_fresh_attribute_name_map(self):
        first = get_albums._admin_summary_names()
        first["#n0"] = "mutated-by-boto3"
        self.assertNotIn("#n0", get_albums._admin_summary_names())

    def test_completion_retries_unprocessed_keys_and_fails_closed(self):
        projected = {"albumId": self.UNCOUNTED_ID, "type": "photo"}
        full = {**projected, "images": []}
        name = get_albums.table.name
        responses = [
            {"Responses": {name: []}, "UnprocessedKeys": {name: {"Keys": [{"albumId": self.UNCOUNTED_ID}]}}},
            {"Responses": {name: [full]}},
        ]
        with patch.object(get_albums.dynamodb, "batch_get_item", side_effect=responses):
            self.assertEqual(get_albums._complete_admin_records([projected]), [full])
        stuck = {"Responses": {name: []}, "UnprocessedKeys": {name: {"Keys": [{"albumId": self.UNCOUNTED_ID}]}}}
        with patch.object(get_albums.dynamodb, "batch_get_item", return_value=stuck), self.assertRaises(RuntimeError):
            get_albums._complete_admin_records([projected])
        # Records that already carry the manifest, or a valid count, are never re-read.
        with patch.object(get_albums.dynamodb, "batch_get_item") as batch:
            kept = [{"albumId": self.PHOTO_ID, "imageCount": Decimal("3")}, {"albumId": self.VIDEO_ID, "type": "video", "images": []}]
            self.assertEqual(get_albums._complete_admin_records(kept), kept)
        batch.assert_not_called()

    def test_admin_owner_sub_with_default_visibility_returns_every_visibility(self):
        for phase in ("none", "both"):
            with self.subTest(phase=phase):
                table = Mock()
                table.name = "albums"
                owned = [record for record in self.records() if record["ownerSub"] == self.OWNER_SUB]
                table.query.return_value = {"Items": owned}
                table.scan.return_value = {"Items": owned}
                with patch.object(get_albums, "table", table), patch.dict(os.environ, {
                    "ALBUM_INDEX_DEPLOYMENT_PHASE": phase,
                    "OWNER_SUB_CREATED_AT_INDEX": "OwnerSubCreatedAtIndex",
                }):
                    items = self.admin({"ownerSub": self.OWNER_SUB, "limit": "10"})
                self.assertEqual(
                    sorted(item["visibility"] for item in items), ["private", "public", "public"],
                )
                call = (table.query if phase == "both" else table.scan).call_args.kwargs
                if phase == "both":
                    self.assertEqual(call["IndexName"], "OwnerSubCreatedAtIndex")
                    self.assertNotIn("FilterExpression", call)
                else:
                    built = ConditionExpressionBuilder().build_expression(call["FilterExpression"])
                    self.assertNotIn("all", json.dumps(built.attribute_value_placeholders, default=str))
                    self.assertIn(self.OWNER_SUB, built.attribute_value_placeholders.values())
                    self.assertNotIn("visibility", built.attribute_name_placeholders.values())

    def test_owner_sub_type_filter_omits_the_visibility_condition(self):
        built = ConditionExpressionBuilder().build_expression(get_albums._filter_for("all", "video"))
        self.assertNotIn("visibility", built.attribute_name_placeholders.values())
        self.assertIsNone(get_albums._filter_for("all"))
        specific = ConditionExpressionBuilder().build_expression(get_albums._filter_for("private", owner_sub="sub"))
        self.assertIn("visibility", specific.attribute_name_placeholders.values())

    def test_owner_sub_with_explicit_visibility_still_filters(self):
        table = Mock()
        table.query.return_value = {"Items": self.records()}
        with patch.object(get_albums, "table", table), patch.dict(os.environ, {
            "ALBUM_INDEX_DEPLOYMENT_PHASE": "both", "OWNER_SUB_CREATED_AT_INDEX": "OwnerSubCreatedAtIndex",
        }):
            items = self.admin({"ownerSub": self.OWNER_SUB, "visibility": "private", "limit": "10"})
        self.assertEqual([item["albumId"] for item in items], [self.UNCOUNTED_ID])
        self.assertIn("FilterExpression", table.query.call_args.kwargs)


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
