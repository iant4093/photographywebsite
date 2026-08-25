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
        "images": [{
            "rawKey": RAW_KEY,
            "width": 3000,
            "height": 2000,
            "exif": {
                "model": "Canon EOS R7",
                "lens": "Sigma 18-50mm F2.8",
                "focalLength": "18mm",
                "focalRatio": "f/4",
                "shutterSpeed": "1/250s",
                "iso": "ISO 100",
                "gps": "must never be public",
            },
        }],
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
        "exploreVersion": 2,
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
        self.assertEqual(item["exif"]["model"], "Canon EOS R7")
        self.assertEqual(item["exif"]["shutterSpeed"], "1/250s")
        self.assertNotIn("gps", item["exif"])
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
        self.assertIn("s-maxage=300", response["headers"]["Cache-Control"])

    def test_color_options_only_include_populated_current_public_facets(self):
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
                "queryStringParameters": {"mode": "colors"},
            })
        self.assertEqual(response_body(response)["items"], [{"id": "blue", "photos": 1}])
        self.assertIn("s-maxage=300", response["headers"]["Cache-Control"])

    def test_randomized_result_cursor_is_stable_and_has_no_duplicates(self):
        raw_keys = [f"albums/{ALBUM_ID}/original/photo-{index}.jpg" for index in range(3)]
        full_album = album()
        full_album["images"] = [{"rawKey": key, "width": 3000, "height": 2000} for key in raw_keys]
        records = []
        for key in raw_keys:
            record = metadata()
            record.update({
                "mediaId": media_id_for_key(key),
                "previewKeys": expected_preview_keys(ALBUM_ID, key),
            })
            records.append(record)
        preview_table = Mock(scan=Mock(return_value={"Items": records}))

        with patch.object(get_public_album, "_preview_table", return_value=preview_table), patch.object(
            get_public_album, "_batch_albums", return_value={ALBUM_ID: full_album},
        ), patch.object(get_public_album.secrets, "token_hex", return_value="0123456789abcdef"):
            first = response_body(get_public_album._explore_response({
                "queryStringParameters": {"mode": "color", "value": "blue", "limit": "2"},
            }))
            second = response_body(get_public_album._explore_response({
                "queryStringParameters": {
                    "mode": "color", "value": "blue", "limit": "2", "cursor": first["nextCursor"],
                },
            }))

        first_ids = [item["mediaId"] for item in first["items"]]
        second_ids = [item["mediaId"] for item in second["items"]]
        self.assertEqual(len(first_ids), 2)
        self.assertEqual(len(second_ids), 1)
        self.assertEqual(len(set(first_ids + second_ids)), 3)
        self.assertIsNone(second["nextCursor"])

    def test_invalid_filters_are_rejected_without_provider_details(self):
        for params in (
            {"mode": "color", "value": "chartreuse"},
            {"mode": "lens", "value": ""},
            {"mode": "camera", "value": "R7"},
            {"mode": "lenses", "cursor": "x"},
            {"mode": "colors", "cursor": "x"},
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
