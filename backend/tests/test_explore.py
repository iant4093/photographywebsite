import unittest
from unittest.mock import Mock, patch

from test_support import response_body

import get_public_album
from media_access import expected_preview_keys, media_id_for_key


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
RAW_KEY = f"albums/{ALBUM_ID}/original/photo.jpg"
MEDIA_ID = media_id_for_key(RAW_KEY)


def album(visibility="public"):
    return {
        "albumId": ALBUM_ID,
        "status": "active",
        "visibility": visibility,
        "type": "photo",
        "title": "Blue Mountain",
        "category": "Hikes",
        "createdAt": "2026-08-15T00:00:00Z",
        "images": [{"rawKey": RAW_KEY, "width": 3000, "height": 2000}],
    }


def metadata():
    return {
        "albumId": ALBUM_ID,
        "mediaId": MEDIA_ID,
        "status": "ready",
        "previewVersion": 3,
        "previewKeys": expected_preview_keys(ALBUM_ID, RAW_KEY),
        "dimensions": {
            str(width): {"width": width, "height": int(width * 2 / 3)}
            for width in (640, 960, 1440, 1920)
        },
        "exploreVersion": 1,
        "palette": ["#123456", "#456789"],
        "colorFamilies": ["blue"],
        "lens": "Sigma 18-50mm F2.8",
        "lensKey": "sigma 18-50mm f2.8",
    }


class ExploreApiTests(unittest.TestCase):
    def test_color_results_use_public_previews_and_allowlisted_metadata(self):
        with patch.object(
            get_public_album,
            "_preview_table",
            return_value=Mock(scan=Mock(return_value={"Items": [metadata()]})),
        ), patch.object(
            get_public_album,
            "_batch_albums",
            return_value={ALBUM_ID: album()},
        ):
            response = get_public_album.handler({
                "requestContext": {"routeKey": "GET /public/explore"},
                "rawPath": "/public/explore",
                "queryStringParameters": {"mode": "color", "value": "blue"},
            }, None)

        self.assertEqual(response["statusCode"], 200)
        self.assertIn("s-maxage=300", response["headers"]["Cache-Control"])
        item = response_body(response)["items"][0]
        self.assertEqual(item["albumTitle"], "Blue Mountain")
        self.assertEqual(item["lens"], "Sigma 18-50mm F2.8")
        self.assertEqual(item["imageIndex"], 0)
        self.assertIn("/public-previews/", item["url"])
        self.assertNotIn("rawKey", item)
        self.assertNotIn("downloadUrl", item)

    def test_current_album_visibility_is_authoritative(self):
        with patch.object(
            get_public_album,
            "_preview_table",
            return_value=Mock(scan=Mock(return_value={"Items": [metadata()]})),
        ), patch.object(
            get_public_album,
            "_batch_albums",
            return_value={ALBUM_ID: album("private")},
        ):
            response = get_public_album._explore_response({
                "queryStringParameters": {"mode": "lens", "value": "Sigma 18-50mm F2.8"},
            })
        self.assertEqual(response_body(response)["items"], [])

    def test_lens_options_are_aggregated_only_from_current_public_media(self):
        with patch.object(
            get_public_album,
            "_preview_table",
            return_value=Mock(scan=Mock(return_value={"Items": [metadata()]})),
        ), patch.object(
            get_public_album,
            "_batch_albums",
            return_value={ALBUM_ID: album()},
        ):
            response = get_public_album._explore_response({
                "queryStringParameters": {"mode": "lenses"},
            })
        self.assertEqual(response_body(response)["items"], [
            {"name": "Sigma 18-50mm F2.8", "photos": 1},
        ])
        self.assertIn("s-maxage=86400", response["headers"]["Cache-Control"])

    def test_invalid_filters_are_rejected_without_provider_details(self):
        for params in (
            {"mode": "color", "value": "chartreuse"},
            {"mode": "lens", "value": ""},
            {"mode": "camera", "value": "R7"},
            {"mode": "lenses", "cursor": "x"},
        ):
            with self.subTest(params=params):
                response = get_public_album.handler({
                    "requestContext": {"routeKey": "GET /public/explore"},
                    "rawPath": "/public/explore",
                    "queryStringParameters": params,
                }, None)
                self.assertEqual(response["statusCode"], 400)
                self.assertEqual(response_body(response)["code"], "invalid_request")


if __name__ == "__main__":
    unittest.main()
