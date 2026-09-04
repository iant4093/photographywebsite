import copy
import json
import os
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

from test_support import DEFAULT_ENV, response_body
from botocore.exceptions import ClientError

import album_media_store
import create_album
import get_public_album
import media_access
import original_comparison_access as originals


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ALBUM = "22222222-2222-4222-8222-222222222222"
RAW_KEY = f"albums/{ALBUM_ID}/original/random.jpg"
MEDIA_ID = media_access.media_id_for_key(RAW_KEY)
CHECKSUM = "a" * 32
IMAGE = {"rawKey": RAW_KEY, "originalFilename": "DSC_0001.JPG"}
ALBUM = {"albumId": ALBUM_ID, "type": "photo", "visibility": "public", "images": [IMAGE]}
ENV = {"ORIGINAL_COMPARISON_TABLE": "comparison-test", "ORIGINAL_PREVIEW_BUCKET": "before-test"}


class OriginalRegionalSigningTests(unittest.TestCase):
    def test_signed_url_uses_bucket_region_without_global_endpoint_redirects(self):
        create_client = originals.boto3.client
        def offline_client(service, *, config):
            return create_client(service, config=config, region_name="us-west-2",
                                 aws_access_key_id="test", aws_secret_access_key="test")
        with patch.object(originals, "_s3", None), patch.object(originals.boto3, "client", side_effect=offline_client):
            client = originals._get_s3_client()
            self.assertIs(originals._get_s3_client(), client)
            url = client.generate_presigned_url("get_object", Params={
                "Bucket": "before-test", "Key": "before/example.webp",
            }, ExpiresIn=1800)
        self.assertEqual(urlsplit(url).hostname, "before-test.s3.us-west-2.amazonaws.com")


def ready_record(**updates):
    result = {
        "albumId": ALBUM_ID, "mediaId": MEDIA_ID, "rawKey": RAW_KEY,
        "status": "ready", "sourceChecksum": CHECKSUM,
        "width": 6000, "height": 4000,
        "driveFileId": "private-drive-id", "sourcePath": "private/archive/path",
        "previews": {
            str(width): f"before/{ALBUM_ID}/{MEDIA_ID}/{CHECKSUM}/w{width}.webp"
            for width in (640, 960, 1440, 1920)
        },
    }
    result.update(updates)
    return result


class OriginalComparisonAccessTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, ENV)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.s3 = Mock()
        self.s3.generate_presigned_url.side_effect = lambda _op, **kwargs: f'https://before-test.s3.amazonaws.com/{kwargs["Params"]["Key"]}?signature=test'
        self.signer = patch.object(originals, "_get_s3_client", return_value=self.s3)
        self.signer.start()
        self.addCleanup(self.signer.stop)

    def test_read_batches_deduplicate_images_and_exclude_videos_and_invalid_keys(self):
        photos = [{"rawKey": f"albums/{ALBUM_ID}/{index}.jpg"} for index in range(101)]
        photo_album = {**ALBUM, "images": photos}
        resource = Mock()
        resource.batch_get_item.return_value = {"Responses": {"comparison-test": []}}
        result = originals.load_original_comparisons_for_albums([
            (photo_album, photos + photos),
            ({**ALBUM, "type": "video"}, None),
            (ALBUM, [{"rawKey": f"albums/{OTHER_ALBUM}/other.jpg"}]),
        ], resource=resource)
        self.assertEqual(len(result[ALBUM_ID]), 101)
        self.assertEqual([len(call.kwargs["RequestItems"]["comparison-test"]["Keys"]) for call in resource.batch_get_item.call_args_list], [100, 1])
        self.assertEqual({item["status"] for item in result[ALBUM_ID].values()}, {"pending"})
        self.assertEqual(set(resource.method_calls[0].kwargs), {"RequestItems"})

    def test_read_failure_and_unprocessed_keys_are_failed_instead_of_missing(self):
        resource = Mock()
        resource.batch_get_item.side_effect = ClientError({"Error": {"Code": "AccessDenied"}}, "BatchGetItem")
        result = originals.load_original_comparisons_for_albums([(ALBUM, None)], resource=resource)
        self.assertEqual(result[ALBUM_ID][MEDIA_ID]["status"], "failed")
        resource.batch_get_item.side_effect = None
        resource.batch_get_item.return_value = {"UnprocessedKeys": {"comparison-test": {"Keys": [{"albumId": ALBUM_ID, "mediaId": MEDIA_ID}]}}}
        result = originals.load_original_comparisons_for_albums([(ALBUM, None)], resource=resource)
        self.assertEqual(result[ALBUM_ID][MEDIA_ID]["status"], "failed")
        self.assertEqual(resource.batch_get_item.call_count, 4)

    def test_ready_record_is_signed_in_private_bucket_and_evidence_is_not_serialized(self):
        with patch.object(originals.time, "time", return_value=1800000000):
            result = originals.serialize_original_comparison(IMAGE, ALBUM, ready_record())
        self.assertEqual(set(result), {"status", "url", "srcSet", "width", "height", "expiresAt"})
        self.assertEqual(result["expiresAt"], 1800001800000)
        self.assertEqual(result["url"], result["srcSet"][-1]["url"])
        self.assertNotIn("private-drive-id", json.dumps(result))
        self.assertNotIn("private/archive/path", json.dumps(result))
        self.assertEqual(self.s3.generate_presigned_url.call_count, 4)
        for call in self.s3.generate_presigned_url.call_args_list:
            self.assertEqual(call.args, ("get_object",))
            self.assertEqual(call.kwargs["ExpiresIn"], 1800)
            self.assertEqual(call.kwargs["Params"]["Bucket"], "before-test")

    def test_mismatched_identity_cross_album_and_invalid_key_paths_never_sign(self):
        corruptions = [
            {"albumId": OTHER_ALBUM}, {"mediaId": "b" * 24}, {"rawKey": RAW_KEY + "x"},
            {"sourceChecksum": "../bad"}, {"width": 0}, {"height": True},
            {"width": 100.5}, {"previews": {}},
            {"previews": {"1920": f"before/{OTHER_ALBUM}/{MEDIA_ID}/{CHECKSUM}/w1920.webp"}},
            {"previews": {"1920": f"before/{ALBUM_ID}/{MEDIA_ID}/{CHECKSUM}/../w1920.webp"}},
            {"previews": {"1920": "https://elsewhere.test/before.webp"}},
            {"previews": {"2560": f"before/{ALBUM_ID}/{MEDIA_ID}/{CHECKSUM}/w2560.webp"}},
        ]
        for updates in corruptions:
            with self.subTest(updates=updates):
                self.assertEqual(originals.serialize_original_comparison(IMAGE, ALBUM, ready_record(**updates)), {"status": "failed"})
        self.s3.generate_presigned_url.assert_not_called()

    def test_small_original_never_requires_upscaled_previews(self):
        record = ready_record(width=500, height=333, previews={"500": f"before/{ALBUM_ID}/{MEDIA_ID}/{CHECKSUM}/w500.webp"})
        result = originals.serialize_original_comparison(IMAGE, ALBUM, record)
        self.assertEqual([item["width"] for item in result["srcSet"]], [500])

    def test_rollout_videos_and_state_only_dtos(self):
        self.assertIsNone(originals.serialize_original_comparison(IMAGE, {**ALBUM, "type": "video"}, ready_record()))
        with patch.dict(os.environ, {"ORIGINAL_COMPARISON_TABLE": ""}):
            self.assertIsNone(originals.serialize_original_comparison(IMAGE, ALBUM, ready_record()))
            self.assertEqual(originals.load_original_comparisons_for_albums([(ALBUM, None)]), {})
        self.assertEqual(originals.serialize_original_comparison(IMAGE, ALBUM), {"status": "pending"})
        for status in ("pending", "unavailable", "ambiguous", "failed"):
            result = originals.serialize_original_comparison(IMAGE, ALBUM, ready_record(status=status))
            self.assertEqual(result, {"status": "unavailable" if status == "ambiguous" else status})
        self.s3.generate_presigned_url.assert_not_called()

    def test_comparisons_load_even_without_edited_preview_table(self):
        resource = Mock()
        resource.batch_get_item.return_value = {"Responses": {"comparison-test": [ready_record()]}}
        with patch.dict(os.environ, {"PREVIEW_METADATA_TABLE": ""}), patch.object(media_access, "get_dynamodb_resource", return_value=resource):
            metadata = media_access.load_preview_metadata(ALBUM)
            result = media_access.serialize_images(ALBUM, preview_metadata_by_id=metadata)[0]
        self.assertEqual(result["before"]["status"], "ready")
        self.assertNotIn("originalFilename", result)
        self.assertNotIn("driveFileId", json.dumps(result))
        admin = media_access.serialize_images(ALBUM, include_internal=True, preview_metadata_by_id=metadata)[0]
        self.assertEqual(admin["originalFilename"], "DSC_0001.JPG")
        self.assertNotIn("driveFileId", json.dumps(admin))

    def test_explore_enriches_only_requested_page_and_rechecks_public_album(self):
        item = {"albumId": ALBUM_ID, "mediaId": MEDIA_ID, "url": "https://media.test/edited.webp"}
        cached = copy.deepcopy(item)
        resource = Mock()
        resource.batch_get_item.return_value = {"Responses": {"comparison-test": [ready_record()]}}
        with patch.object(get_public_album, "_batch_albums", return_value={ALBUM_ID: ALBUM}), patch.object(media_access, "get_dynamodb_resource", return_value=resource):
            body = response_body(get_public_album._explore_json_response(200, {"items": [{"id": "wide", "photos": 1}], "initialPage": {"items": [item]}}))
        self.assertEqual(body["initialPage"]["items"][0]["before"]["status"], "ready")
        self.assertEqual(body["items"], [{"id": "wide", "photos": 1}])
        self.assertEqual(item, cached)
        with patch.object(get_public_album, "_batch_albums", return_value={ALBUM_ID: {**ALBUM, "visibility": "private"}}):
            body = response_body(get_public_album._explore_json_response(200, {"items": [item]}))
        self.assertEqual(body["items"], [])

    def test_csp_allows_private_original_bucket(self):
        csp = get_public_album._html_response("shell")["headers"]["Content-Security-Policy"]
        self.assertIn("https://before-test.s3.amazonaws.com", csp)
        self.assertIn("https://before-test.s3.us-west-2.amazonaws.com", csp)


class OriginalFilenamePreservationTests(unittest.TestCase):
    def test_upload_normalizes_basename_and_preserves_it_in_media_rows(self):
        image = {"rawKey": RAW_KEY, "originalFilename": "C:\\camera\\ DSC_0001.JPG\n"}
        normalized = create_album._normalize_images([image], ALBUM_ID, "photo")[0]
        self.assertEqual(normalized["rawKey"], RAW_KEY)
        self.assertEqual(normalized["originalFilename"], "DSC_0001.JPG")
        self.assertEqual(album_media_store.normalized_media_item(ALBUM_ID, normalized, 0)["originalFilename"], "DSC_0001.JPG")
        self.assertNotIn("originalFilename", create_album._normalize_images([image], ALBUM_ID, "video")[0])
        long_name = {**image, "originalFilename": "x" * 300}
        self.assertEqual(len(create_album._normalize_images([long_name], ALBUM_ID, "photo")[0]["originalFilename"]), 255)
        with self.assertRaises(create_album.ValidationError):
            create_album._normalize_images([{**image, "originalFilename": {"nested": "bad"}}], ALBUM_ID, "photo")


if __name__ == "__main__":
    unittest.main()
