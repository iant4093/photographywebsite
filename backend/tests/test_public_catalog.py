import base64
import json
import os
import unittest
from decimal import Decimal
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError

from test_support import response_body

import get_public_album
import get_public_albums
import cursor_helpers
from media_access import media_id_for_key


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


def public_album(**overrides):
    record = {
        "albumId": ALBUM_ID,
        "status": "active",
        "visibility": "public",
        "type": "photo",
        "title": "Portfolio",
        "description": "Description",
        "category": "Portraits",
        "createdAt": "2026-01-01T00:00:00Z",
        "imageCount": Decimal("1"),
        "images": [{"rawKey": f"albums/{ALBUM_ID}/original/photo.jpg"}],
    }
    record.update(overrides)
    return record


class PublicCatalogListTests(unittest.TestCase):
    def setUp(self):
        self.gallery_order = patch.object(
            get_public_albums, "load_gallery_settings", return_value={}
        )
        self.gallery_order.start()
        self.addCleanup(self.gallery_order.stop)

    def test_valid_base64_json_nonobjects_are_rejected_as_invalid_cursors(self):
        for payload in ([], None, 1, "x"):
            encoded = base64.urlsafe_b64encode(
                json.dumps(payload).encode("utf-8")
            ).rstrip(b"=").decode("ascii")
            with self.subTest(payload=payload), self.assertRaisesRegex(
                cursor_helpers.ValidationError, "Invalid cursor"
            ):
                cursor_helpers.decode_cursor(encoded, "public:*")

    def test_upload_timestamp_join_adds_only_the_small_recency_field(self):
        records = [public_album()]
        with patch.object(
            get_public_albums.dynamodb,
            "batch_get_item",
            return_value={
                "Responses": {
                    get_public_albums.table.name: [
                        {"albumId": ALBUM_ID, "uploadedAt": "2026-08-24T12:00:00Z"}
                    ]
                }
            },
        ) as batch_get:
            self.assertIs(get_public_albums._hydrate_upload_times(records), records)
        self.assertEqual(records[0]["uploadedAt"], "2026-08-24T12:00:00Z")
        self.assertEqual(
            batch_get.call_args.kwargs["RequestItems"][get_public_albums.table.name]["ProjectionExpression"],
            "albumId, uploadedAt",
        )

    def test_provider_invalid_cursor_key_names_and_values_are_rejected(self):
        invalid_keys = (
            {"unknown": "value"},
            {"albumId": True},
            {"albumId": 1},
            {"albumId": float("nan")},
            {"albumId": float("inf")},
            {"albumId": ""},
        )
        for key in invalid_keys:
            payload = {"v": 1, "scope": "public:*", "key": key}
            encoded = base64.urlsafe_b64encode(
                json.dumps(payload).encode("utf-8")
            ).rstrip(b"=").decode("ascii")
            with self.subTest(key=key), self.assertRaisesRegex(
                cursor_helpers.ValidationError, "Invalid cursor"
            ):
                cursor_helpers.decode_cursor(encoded, "public:*")

    def test_summary_query_is_public_only_and_falls_back_when_aggregate_is_missing(self):
        projected = public_album(images=None)
        projected.pop("images")
        projected.pop("imageCount")
        full = public_album()
        with patch.dict(
            os.environ,
            {
                "ALBUM_INDEX_DEPLOYMENT_PHASE": "both",
                "PUBLIC_SUMMARY_INDEX": "VisibilityCreatedAtSummaryIndex",
                "VISIBILITY_CREATED_AT_INDEX": "VisibilityCreatedAtIndex",
            },
        ), patch.object(
            get_public_albums.table,
            "query",
            side_effect=[{"Items": [projected]}, {"Items": [full]}],
        ) as query:
            records, cursor = get_public_albums._fetch_page(
                album_type="photo", limit=100, start_key=None
            )
        self.assertEqual(records, [full])
        self.assertIsNone(cursor)
        self.assertEqual(query.call_args_list[0].kwargs["IndexName"], "VisibilityCreatedAtSummaryIndex")
        self.assertEqual(query.call_args_list[1].kwargs["IndexName"], "VisibilityCreatedAtIndex")

    def test_summary_fallback_resumes_without_repeating_completed_pages(self):
        first = public_album(
            albumId="11111111-1111-4111-8111-111111111110",
            createdAt="2026-03-01T00:00:00Z",
            images=None,
        )
        first.pop("images")
        second = public_album(
            albumId="11111111-1111-4111-8111-111111111109",
            createdAt="2026-02-01T00:00:00Z",
            images=None,
        )
        second.pop("images")
        legacy_projected = public_album(
            albumId="11111111-1111-4111-8111-111111111108",
            createdAt="2026-01-01T00:00:00Z",
            images=None,
        )
        legacy_projected.pop("images")
        legacy_projected.pop("imageCount")
        legacy_full = public_album(
            albumId=legacy_projected["albumId"],
            createdAt=legacy_projected["createdAt"],
        )
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
            get_public_albums.table,
            "query",
            side_effect=[
                {"Items": [first, second], "LastEvaluatedKey": resume_key},
                {"Items": [legacy_projected]},
                {"Items": [legacy_full]},
            ],
        ) as query:
            records, cursor = get_public_albums._fetch_page(
                album_type="photo", limit=3, start_key=None
            )

        self.assertEqual(records, [first, second, legacy_full])
        self.assertIsNone(cursor)
        self.assertEqual(query.call_args_list[2].kwargs["IndexName"], "VisibilityCreatedAtIndex")
        self.assertEqual(query.call_args_list[2].kwargs["ExclusiveStartKey"], resume_key)

    def test_missing_indexes_fall_back_to_a_filtered_scan(self):
        unavailable = ClientError(
            {"Error": {"Code": "ResourceNotFoundException", "Message": "missing"}},
            "Query",
        )
        with patch.dict(
            os.environ,
            {
                "ALBUM_INDEX_DEPLOYMENT_PHASE": "summary",
                "PUBLIC_SUMMARY_INDEX": "VisibilityCreatedAtSummaryIndex",
                "VISIBILITY_CREATED_AT_INDEX": "VisibilityCreatedAtIndex",
            },
        ), patch.object(get_public_albums.table, "query", side_effect=unavailable), patch.object(
            get_public_albums.table,
            "scan",
            return_value={"Items": [public_album()]},
        ) as scan:
            records, _ = get_public_albums._fetch_page(
                album_type=None,
                limit=100,
                start_key={"albumId": ALBUM_ID},
            )
        self.assertEqual(records, [public_album()])
        self.assertNotIn("ExclusiveStartKey", scan.call_args.kwargs)

    def test_handler_returns_only_allowlisted_public_dtos_and_accepts_limit_100(self):
        stored = public_album(
            ownerEmail="private@example.test",
            ownerSub="private-sub",
            shareCode="private-share-code",
            s3Prefix=f"albums/{ALBUM_ID}/",
        )
        with patch.object(
            get_public_albums,
            "_fetch_page",
            return_value=([stored], None),
        ) as fetch:
            response = get_public_albums.handler(
                {
                    "headers": {"authorization": "Bearer ignored"},
                    "queryStringParameters": {"type": "photo", "limit": "100"},
                },
                None,
            )
        self.assertEqual(response["statusCode"], 200)
        self.assertIn("s-maxage=300", response["headers"]["Cache-Control"])
        body = response_body(response)
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["items"][0]["imageCount"], 1)
        for private_field in ("ownerEmail", "ownerSub", "shareCode", "s3Prefix", "images"):
            self.assertNotIn(private_field, body["items"][0])
        fetch.assert_called_once_with(album_type="photo", limit=100, start_key=None)

    def test_handler_applies_configured_photo_gallery_order(self):
        photo = public_album()
        with patch.object(
            get_public_albums, "_fetch_page", return_value=([photo], None)
        ), patch.object(
            get_public_albums,
            "load_gallery_settings",
            return_value={
                "photo": {
                    "albums": {ALBUM_ID: 2},
                    "categories": {"Portraits": 3},
                }
            },
        ):
            response = get_public_albums.handler(
                {"queryStringParameters": {"type": "photo"}}, None
            )
        self.assertEqual(response_body(response)["items"][0]["galleryOrder"], 2)
        self.assertEqual(response_body(response)["items"][0]["galleryCategoryOrder"], 3)

    def test_handler_applies_independent_video_gallery_order(self):
        video = public_album(type="video", category="Films")
        with patch.object(
            get_public_albums, "_fetch_page", return_value=([video], None)
        ), patch.object(
            get_public_albums,
            "load_gallery_settings",
            return_value={
                "video": {
                    "albums": {ALBUM_ID: 1},
                    "categories": {"Films": 4},
                }
            },
        ):
            response = get_public_albums.handler(
                {"queryStringParameters": {"type": "video"}}, None
            )
        item = response_body(response)["items"][0]
        self.assertEqual(item["galleryOrder"], 1)
        self.assertEqual(item["galleryCategoryOrder"], 4)

    def test_handler_rejects_mixed_boundary_parameters_and_redacts_provider_errors(self):
        for params in ({"visibility": "private"}, {"ownerEmail": "owner@example.test"}, ["bad"]):
            with self.subTest(params=params):
                response = get_public_albums.handler({"queryStringParameters": params}, None)
                self.assertEqual(response["statusCode"], 400)
        with patch.object(get_public_albums, "_fetch_page", side_effect=RuntimeError("sensitive")):
            response = get_public_albums.handler({"queryStringParameters": None}, None)
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("sensitive", response["body"])

    def test_malformed_records_fail_closed_without_losing_the_next_cursor(self):
        last_key = {"albumId": ALBUM_ID, "visibility": "public", "createdAt": "now"}
        records = [
            public_album(status="pending"),
            public_album(visibility="private"),
            public_album(visibility="corrupt"),
        ]
        with patch.object(get_public_albums, "_fetch_page", return_value=(records, last_key)):
            response = get_public_albums.handler({"queryStringParameters": {}}, None)
        body = response_body(response)
        self.assertEqual(body["items"], [])
        self.assertIsInstance(body["nextCursor"], str)


class PublicAlbumDetailTests(unittest.TestCase):
    SHELL = """<!doctype html><html><head>
    <meta name="description" content="generic">
    <link rel="canonical" href="https://iantruongphotography.com/">
    <meta property="og:title" content="Old">
    <meta property="og:image" content="https://media.example.test/old.jpg">
    <meta name="twitter:title" content="Old">
    <title>Ian Truong Photography</title>
    </head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>"""

    def setUp(self):
        get_public_album._shell_cache.update(html=None, expires_at=0.0)

    def tearDown(self):
        get_public_album._shell_cache.update(html=None, expires_at=0.0)

    def test_social_shell_fetch_is_bounded_cached_and_uses_the_current_document(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.headers.get_content_type.return_value = "text/html"
        response.read.return_value = self.SHELL.encode("utf-8")
        with patch.object(
            get_public_album.urllib.request, "urlopen", return_value=response
        ) as urlopen, patch.object(
            get_public_album.time, "monotonic", side_effect=[100.0, 101.0]
        ):
            self.assertEqual(get_public_album._base_shell(), self.SHELL)
            self.assertEqual(get_public_album._base_shell(), self.SHELL)
        urlopen.assert_called_once()
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://iantruongphotography.com/index.html")
        response.read.assert_called_once_with(get_public_album.MAX_SHELL_BYTES + 1)

    def test_social_shell_refresh_failure_uses_only_a_previously_valid_shell(self):
        get_public_album._shell_cache.update(html=self.SHELL, expires_at=0.0)
        with patch.object(
            get_public_album.urllib.request, "urlopen", side_effect=RuntimeError("provider detail")
        ):
            self.assertEqual(get_public_album._base_shell(), self.SHELL)

        get_public_album._shell_cache.update(html=None, expires_at=0.0)
        with patch.object(
            get_public_album, "_base_shell", side_effect=RuntimeError("provider detail")
        ):
            response = get_public_album.handler(
                {"pathParameters": {"albumType": "album", "albumId": ALBUM_ID}},
                None,
            )
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("provider detail", response["body"])

    def test_public_detail_returns_cacheable_allowlisted_body(self):
        stored = public_album(ownerEmail="private@example.test", shareCode="private-code")
        with patch.object(
            get_public_album.table, "get_item", return_value={"Item": stored}
        ), patch.object(
            get_public_album, "serialize_album_detail", return_value={"albumId": ALBUM_ID}
        ), patch.object(
            get_public_album, "serialize_images", return_value=[{"url": "https://media.example.test/photo"}]
        ):
            response = get_public_album.handler(
                {"pathParameters": {"albumId": ALBUM_ID}}, None
            )
        self.assertEqual(response["statusCode"], 200)
        self.assertIn("s-maxage=300", response["headers"]["Cache-Control"])
        self.assertEqual(
            response_body(response),
            {"album": {"albumId": ALBUM_ID}, "images": [{"url": "https://media.example.test/photo"}]},
        )

    def test_random_photos_are_sampled_only_from_public_photo_albums(self):
        second_id = "22222222-2222-4222-8222-222222222222"
        albums = [
            public_album(),
            public_album(
                albumId=second_id,
                title="Second album",
                images=[{"rawKey": f"albums/{second_id}/original/second.jpg"}],
            ),
        ]

        def serialize(album, **_kwargs):
            return [{"mediaId": album["images"][0]["rawKey"], "url": "https://media.example.test/photo.jpg"}]

        with patch.object(get_public_album, "_random_photo_albums", return_value=albums), patch.object(
            get_public_album, "serialize_images", side_effect=serialize
        ), patch.object(
            get_public_album,
            "load_preview_metadata_for_albums",
            return_value={ALBUM_ID: {}, second_id: {}},
        ) as load_previews:
            response = get_public_album.handler(
                {
                    "rawPath": "/public/random-photos",
                    "requestContext": {"routeKey": "GET /public/random-photos"},
                    "queryStringParameters": None,
                },
                None,
            )

        self.assertEqual(response["statusCode"], 200)
        self.assertIn("s-maxage=300", response["headers"]["Cache-Control"])
        self.assertIn("stale-while-revalidate=600", response["headers"]["Cache-Control"])
        body = response_body(response)
        self.assertEqual(body["totalPhotos"], 2)
        self.assertEqual({item["albumId"] for item in body["images"]}, {ALBUM_ID, second_id})
        self.assertEqual({item["albumTitle"] for item in body["images"]}, {"Portfolio", "Second album"})
        load_previews.assert_called_once()

    def test_random_photos_use_the_materialized_pool_without_scanning_albums(self):
        album = public_album()
        raw_key = album["images"][0]["rawKey"]
        reference = {
            "albumId": ALBUM_ID,
            "mediaId": media_id_for_key(raw_key),
        }
        with patch.object(
            get_public_album,
            "load_pool_references",
            return_value={"references": [reference], "totalPhotos": 3026},
        ), patch.object(
            get_public_album, "_preview_table", return_value=MagicMock()
        ), patch.object(
            get_public_album, "_batch_albums", return_value={ALBUM_ID: album}
        ), patch.object(
            get_public_album, "_random_photo_albums"
        ) as scan_albums, patch.object(
            get_public_album,
            "load_preview_metadata_for_albums",
            return_value={ALBUM_ID: {}},
        ), patch.object(
            get_public_album,
            "serialize_images",
            return_value=[{"id": reference["mediaId"], "url": "https://media.example.test/photo.jpg"}],
        ):
            response = get_public_album.handler(
                {
                    "rawPath": "/public/random-photos",
                    "requestContext": {"routeKey": "GET /public/random-photos"},
                    "queryStringParameters": None,
                },
                None,
            )

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["totalPhotos"], 3026)
        scan_albums.assert_not_called()

    def test_random_photos_reject_query_parameters(self):
        invalid = (
            {"limit": "500"},
            {"mode": "album", "value": "Birding"},
            {"mode": "category", "value": ""},
            {"mode": "category", "value": "Birding", "extra": "no"},
        )
        for params in invalid:
            with self.subTest(params=params):
                response = get_public_album.handler(
                    {
                        "rawPath": "/public/random-photos",
                        "requestContext": {"routeKey": "GET /public/random-photos"},
                        "queryStringParameters": params,
                    },
                    None,
                )
                self.assertEqual(response["statusCode"], 400)

    def test_random_photos_can_be_scoped_to_one_category(self):
        album = public_album(category="Birding")
        with patch.object(
            get_public_album, "_random_photo_albums", return_value=[album]
        ) as load_albums, patch.object(
            get_public_album,
            "load_preview_metadata_for_albums",
            return_value={ALBUM_ID: {}},
        ), patch.object(
            get_public_album,
            "serialize_images",
            return_value=[{"id": "bird", "url": "https://media.example.test/bird.jpg"}],
        ):
            response = get_public_album.handler(
                {
                    "rawPath": "/public/random-photos",
                    "requestContext": {"routeKey": "GET /public/random-photos"},
                    "queryStringParameters": {"mode": "category", "value": "Birding"},
                },
                None,
            )

        self.assertEqual(response["statusCode"], 200)
        self.assertIn("s-maxage=300", response["headers"]["Cache-Control"])
        self.assertEqual(response_body(response)["category"], "Birding")
        self.assertEqual(response_body(response)["images"][0]["albumCategory"], "Birding")
        load_albums.assert_called_once_with("Birding")

    def test_nonpublic_missing_and_inactive_records_are_indistinguishable(self):
        records = [None, public_album(visibility="private"), public_album(status="pending")]
        for stored in records:
            with self.subTest(stored=stored), patch.object(
                get_public_album.table,
                "get_item",
                return_value={} if stored is None else {"Item": stored},
            ), patch.object(get_public_album, "serialize_images") as serialize:
                response = get_public_album.handler(
                    {"pathParameters": {"albumId": ALBUM_ID}}, None
                )
                self.assertEqual(response["statusCode"], 404)
                serialize.assert_not_called()

    def test_social_document_uses_escaped_public_album_metadata_and_cover(self):
        stored = public_album(
            title='Misty <script>alert("x")</script>',
            description='Portraits & friends',
            coverImageUrl=f"albums/{ALBUM_ID}/original/photo.jpg",
            coverThumbKey=f"albums/{ALBUM_ID}/thumbnail/photo.jpg",
        )
        event = {
            "pathParameters": {"albumType": "album", "albumId": ALBUM_ID},
            "queryStringParameters": None,
        }
        with patch.object(get_public_album, "_base_shell", return_value=self.SHELL), patch.object(
            get_public_album.table, "get_item", return_value={"Item": stored}
        ):
            response = get_public_album.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response["headers"]["Content-Type"], "text/html; charset=utf-8")
        self.assertIn("default-src 'self'", response["headers"]["Content-Security-Policy"])
        self.assertIn("Portraits &amp; friends", response["body"])
        self.assertIn("Misty &lt;script&gt;", response["body"])
        self.assertNotIn('<script>alert("x")</script>', response["body"])
        self.assertIn(
            f"https://media.example.test/albums/{ALBUM_ID}/thumbnail/photo.jpg",
            response["body"],
        )
        self.assertIn(
            f'<link rel="canonical" href="https://iantruongphotography.com/album/{ALBUM_ID}"',
            response["body"],
        )
        self.assertEqual(response["body"].count('property="og:title"'), 1)
        self.assertEqual(response["body"].count('name="twitter:title"'), 1)
        self.assertEqual(response["body"].count('name="description"'), 1)

    def test_social_document_never_uses_a_large_original_when_thumbnail_is_missing(self):
        stored = public_album(
            coverImageUrl=f"albums/{ALBUM_ID}/original/photo.jpg",
            coverThumbKey="",
        )
        with patch.object(get_public_album, "_base_shell", return_value=self.SHELL), patch.object(
            get_public_album.table, "get_item", return_value={"Item": stored}
        ):
            response = get_public_album.handler(
                {"pathParameters": {"albumType": "album", "albumId": ALBUM_ID}},
                None,
            )
        self.assertNotIn(f"albums/{ALBUM_ID}/original/photo.jpg", response["body"])
        self.assertIn("/site/hero/current/hero.jpg", response["body"])

    def test_social_document_falls_back_without_disclosing_nonpublic_or_wrong_type_records(self):
        records = (
            public_album(visibility="private", title="Private title"),
            public_album(type="video", title="Wrong type title"),
            None,
        )
        for stored in records:
            with self.subTest(stored=stored), patch.object(
                get_public_album, "_base_shell", return_value=self.SHELL
            ), patch.object(
                get_public_album.table,
                "get_item",
                return_value={} if stored is None else {"Item": stored},
            ):
                response = get_public_album.handler(
                    {"pathParameters": {"albumType": "album", "albumId": ALBUM_ID}},
                    None,
                )
            self.assertEqual(response["statusCode"], 200)
            self.assertIn("Ian Truong Photography portfolio cover", response["body"])
            self.assertNotIn("Private title", response["body"])
            self.assertNotIn("Wrong type title", response["body"])
            self.assertIn('href="https://iantruongphotography.com/"', response["body"])

    def test_social_document_invalid_id_and_lookup_failure_remain_generic(self):
        events = [
            ({"albumType": "album", "albumId": "bad"}, None),
            ({"albumType": "unsupported", "albumId": ALBUM_ID}, None),
            ({"albumType": "video", "albumId": ALBUM_ID}, RuntimeError("sensitive")),
        ]
        for params, failure in events:
            with self.subTest(params=params), patch.object(
                get_public_album, "_base_shell", return_value=self.SHELL
            ), patch.object(
                get_public_album.table,
                "get_item",
                side_effect=failure,
            ) as get_item:
                response = get_public_album.handler({"pathParameters": params}, None)
            self.assertEqual(response["statusCode"], 200)
            self.assertIn("Ian Truong Photography portfolio cover", response["body"])
            self.assertNotIn("sensitive", response["body"])
            if params["albumId"] == "bad" or params["albumType"] == "unsupported":
                get_item.assert_not_called()

    def test_legacy_listing_filters_derivatives_duplicates_and_empty_keys(self):
        album = public_album(images=[])
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                "Contents": [
                    {"Key": ""},
                    {"Key": f"albums/{ALBUM_ID}/original/"},
                    {"Key": f"albums/{ALBUM_ID}/thumbnail/thumb.jpg"},
                    {"Key": f"albums/{ALBUM_ID}/preview/v2/photo.webp"},
                    {"Key": f"albums/{ALBUM_ID}/preview/v3/photo.webp"},
                    {"Key": f"albums/{ALBUM_ID}/original/thumb_legacy.jpg"},
                    {"Key": f"albums/{ALBUM_ID}/original/photo.jpg"},
                    {"Key": f"albums/{ALBUM_ID}/original/photo.jpg"},
                ]
            }
        ]
        with patch.object(get_public_album.s3, "get_paginator", return_value=paginator):
            images = get_public_album._legacy_images(album)
        self.assertEqual(
            images,
            [{"rawKey": f"albums/{ALBUM_ID}/original/photo.jpg"}],
        )

    def test_detail_rejects_queries_and_invalid_ids_and_redacts_failures(self):
        response = get_public_album.handler(
            {
                "pathParameters": {"albumId": ALBUM_ID},
                "queryStringParameters": {"visibility": "private"},
            },
            None,
        )
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(
            get_public_album.handler({"pathParameters": {"albumId": "bad"}}, None)["statusCode"],
            400,
        )
        with patch.object(get_public_album.table, "get_item", side_effect=RuntimeError("secret")):
            response = get_public_album.handler(
                {"pathParameters": {"albumId": ALBUM_ID}}, None
            )
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("secret", response["body"])


if __name__ == "__main__":
    unittest.main()
