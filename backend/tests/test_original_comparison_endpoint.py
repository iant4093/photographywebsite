import json
import os
import unittest
from copy import deepcopy
from unittest.mock import Mock, call, patch

from test_support import claims, response_body

import get_download_url
import media_access
import original_comparison_access as originals


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ALBUM_ID = "22222222-2222-4222-8222-222222222222"
RAW_KEY = f"albums/{ALBUM_ID}/original/photo.jpg"
MEDIA_ID = media_access.media_id_for_key(RAW_KEY)
IMAGE = {"rawKey": RAW_KEY}
SHARE_CODE = "share-code-12345678"
ALBUM = {
    "albumId": ALBUM_ID, "type": "photo", "visibility": "public", "status": "active",
    "images": [IMAGE, {"rawKey": f"albums/{ALBUM_ID}/original/other.jpg"}],
}
CHECKSUM = "a" * 32
READY = {
    "albumId": ALBUM_ID, "mediaId": MEDIA_ID, "rawKey": RAW_KEY, "status": "ready",
    "sourceChecksum": CHECKSUM, "width": 6000, "height": 4000,
    "driveFileId": "private-drive-id", "sourcePath": "private/archive/path",
    "previews": {
        str(width): f"before/{ALBUM_ID}/{MEDIA_ID}/{CHECKSUM}/w{width}.webp"
        for width in (640, 960, 1440, 1920)
    },
}


def event(*, shared=False, media_id=MEDIA_ID):
    prefix = f"/shared/{SHARE_CODE}" if shared else f"/albums/{ALBUM_ID}"
    return {
        "rawPath": f"{prefix}/original-comparison",
        "pathParameters": {"shareCode": SHARE_CODE} if shared else {"albumId": ALBUM_ID},
        "body": json.dumps({"mediaId": media_id}),
        "requestContext": {"http": {"sourceIp": "192.0.2.10"}},
    }


class OriginalComparisonEndpointTests(unittest.TestCase):
    def setUp(self):
        self.patch(patch.dict(os.environ, {
            "ORIGINAL_COMPARISON_TABLE": "comparison-test", "ORIGINAL_PREVIEW_BUCKET": "before-test",
        }))
        self.lookup = self.patch(patch.object(get_download_url, "get_album_record", return_value=deepcopy(ALBUM)))
        self.claims = self.patch(patch.object(get_download_url, "get_verified_claims", return_value=None))
        self.rate = self.patch(patch.object(get_download_url, "check_rate_limit", return_value=True))
        self.audit = self.patch(patch.object(get_download_url, "emit_audit_event"))
        self.raw_signer = self.patch(patch.object(get_download_url, "presigned_get_url"))
        self.resource = Mock()
        self.resource.batch_get_item.return_value = {"Responses": {"comparison-test": [READY]}}
        self.patch(patch.object(media_access, "get_dynamodb_resource", return_value=self.resource))
        self.s3 = Mock()
        self.s3.generate_presigned_url.side_effect = lambda _operation, **kwargs: (
            f"https://before-test.s3.us-west-2.amazonaws.com/{kwargs['Params']['Key']}?signature=test"
        )
        self.patch(patch.object(originals, "_get_s3_client", return_value=self.s3))

    def patch(self, patcher):
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def assert_not_read_or_signed(self):
        self.resource.batch_get_item.assert_not_called()
        self.s3.generate_presigned_url.assert_not_called()
        self.raw_signer.assert_not_called()

    def test_public_access_reads_and_signs_only_requested_image_after_rate_limit(self):
        def read(**_kwargs):
            self.rate.assert_called_once_with(
                f"192.0.2.10:{ALBUM_ID}", "album_original_comparison", 100, 300, fail_closed=True,
            )
            return {"Responses": {"comparison-test": [READY]}}
        self.resource.batch_get_item.side_effect = read
        response = get_download_url.handler(event(), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        before = response_body(response)["before"]
        self.assertEqual(before["status"], "ready")
        self.assertEqual(len(before["srcSet"]), 4)
        self.assertEqual(self.s3.generate_presigned_url.call_count, 4)
        self.resource.batch_get_item.assert_called_once_with(RequestItems={
            "comparison-test": {"Keys": [{"albumId": ALBUM_ID, "mediaId": MEDIA_ID}], "ConsistentRead": False},
        })
        self.raw_signer.assert_not_called()
        for private in ("private-drive-id", "private/archive/path", RAW_KEY):
            self.assertNotIn(private, response["body"])
        audit = self.audit.call_args.kwargs
        self.assertEqual(audit["event_name"], "media.original_authorized")
        self.assertEqual(audit["action"], "media.original.authorize")
        self.assertEqual(audit["resource_type"], "media")

    def test_private_owner_and_admin_are_authorized(self):
        self.lookup.return_value = {**ALBUM, "visibility": "private", "ownerSub": "owner"}
        for identity in (claims(subject="owner"), claims(subject="admin", groups=["Admins"])):
            with self.subTest(identity=identity):
                self.claims.return_value = identity
                response = get_download_url.handler(event(), None)
                self.assertEqual(response["statusCode"], 200)
                self.assertEqual(response_body(response)["before"]["status"], "ready")

    def test_private_anonymous_and_non_owner_cannot_read_or_sign(self):
        self.lookup.return_value = {**ALBUM, "visibility": "private", "ownerSub": "owner"}
        for identity, status in ((None, 401), (claims(subject="someone-else"), 403)):
            with self.subTest(status=status):
                self.claims.return_value = identity
                self.assertEqual(get_download_url.handler(event(), None)["statusCode"], status)
        self.assert_not_read_or_signed()
        self.rate.assert_not_called()

    def test_active_share_rechecks_current_record_and_has_separate_rate_limit(self):
        self.lookup.return_value = {**ALBUM, "visibility": "unlisted", "isShared": True, "shareCode": SHARE_CODE}
        response = get_download_url.handler(event(shared=True), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["before"]["status"], "ready")
        self.assertEqual(self.lookup.call_args_list, [call(share_code=SHARE_CODE), call(album_id=ALBUM_ID)])
        self.rate.assert_called_once_with(
            f"192.0.2.10:{ALBUM_ID}", "shared_original_comparison", 40, 300, fail_closed=True,
        )
        self.assertEqual(self.audit.call_args.kwargs["auth_method"], "share_grant")

    def test_stale_share_index_cannot_bypass_revocation_or_rotation(self):
        stale = {**ALBUM, "visibility": "unlisted", "isShared": True, "shareCode": SHARE_CODE}
        for current in (
            {**stale, "isShared": False}, {**stale, "shareCode": "new-share-code"},
            {**stale, "visibility": "private"}, {**stale, "status": "deleted"}, None,
        ):
            with self.subTest(current=current):
                self.lookup.side_effect = [stale, current]
                self.assertEqual(get_download_url.handler(event(shared=True), None)["statusCode"], 404)
        self.assert_not_read_or_signed()

    def test_visibility_is_rechecked_on_subsequent_requests(self):
        self.lookup.side_effect = [ALBUM, {**ALBUM, "visibility": "private", "ownerSub": "owner"}]
        self.assertEqual(get_download_url.handler(event(), None)["statusCode"], 200)
        self.resource.batch_get_item.reset_mock()
        self.s3.generate_presigned_url.reset_mock()
        self.assertEqual(get_download_url.handler(event(), None)["statusCode"], 401)
        self.assert_not_read_or_signed()

    def test_unknown_album_media_and_invalid_ids_are_not_found_without_reads(self):
        for request in (event(media_id="0" * 24), event(media_id="not-hex"), event(media_id="a" * 25)):
            self.assertEqual(get_download_url.handler(request, None)["statusCode"], 404)
        self.lookup.return_value = None
        self.assertEqual(get_download_url.handler(event(), None)["statusCode"], 404)
        self.assertEqual(get_download_url.handler(event(shared=True), None)["statusCode"], 404)
        self.assert_not_read_or_signed()

    def test_cross_album_manifest_key_cannot_be_signed(self):
        bad_key = f"albums/{OTHER_ALBUM_ID}/original/photo.jpg"
        self.lookup.return_value = {**ALBUM, "images": [{"rawKey": bad_key}]}
        response = get_download_url.handler(event(media_id=media_access.media_id_for_key(bad_key)), None)
        self.assertEqual(response["statusCode"], 404)
        self.assert_not_read_or_signed()

    def test_feature_disabled_and_video_return_null_without_reads_or_signing(self):
        with patch.dict(os.environ, {"ORIGINAL_COMPARISON_TABLE": ""}):
            response = get_download_url.handler(event(), None)
            self.assertEqual(response_body(response), {"before": None})
        self.lookup.return_value = {**ALBUM, "type": "video"}
        response = get_download_url.handler(event(), None)
        self.assertEqual(response_body(response), {"before": None})
        self.assert_not_read_or_signed()

    def test_missing_comparison_returns_pending_without_signing(self):
        self.resource.batch_get_item.return_value = {"Responses": {"comparison-test": []}}
        response = get_download_url.handler(event(), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response), {"before": {"status": "pending"}})
        self.s3.generate_presigned_url.assert_not_called()

    def test_rate_limit_rejects_before_reading_or_signing(self):
        self.rate.return_value = False
        response = get_download_url.handler(event(), None)
        self.assertEqual(response["statusCode"], 429)
        self.assertEqual(response_body(response)["code"], "rate_limited")
        self.assertEqual(self.audit.call_args.kwargs["event_name"], "media.original_authorized")
        self.assertEqual(self.audit.call_args.kwargs["reason_code"], "rate_limited")
        self.assert_not_read_or_signed()

    def test_route_key_is_supported_when_raw_path_is_absent(self):
        for top_level in (True, False):
            request = event()
            request.pop("rawPath")
            target = request if top_level else request["requestContext"]
            target["routeKey"] = "POST /albums/{albumId}/original-comparison"
            response = get_download_url.handler(request, None)
            self.assertEqual(response_body(response)["before"]["status"], "ready")
        self.raw_signer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
