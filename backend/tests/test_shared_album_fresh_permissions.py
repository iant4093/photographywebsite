"""A stale sharing index must never grant access using an obsolete manifest."""

import unittest
from unittest.mock import Mock, patch

from test_support import response_body
import get_shared_album


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
SHARE_CODE = "share-code-123"


class SharedAlbumFreshPermissionTests(unittest.TestCase):
    def setUp(self):
        self.stale = {"albumId": ALBUM_ID, "visibility": "unlisted", "status": "active",
                      "isShared": True, "shareCode": SHARE_CODE,
                      "title": "Old title", "images": [{"rawKey": "old"}]}
        self.fresh = {**self.stale, "title": "Current title", "images": [{"rawKey": "current"}]}
        self.table = Mock()
        self.table.query.return_value = {"Items": [self.stale]}
        self.table.get_item.return_value = {"Item": self.fresh}
        self.enterContext(patch.object(get_shared_album, "table", self.table))
        self.enterContext(patch.object(get_shared_album, "is_rate_limit_denied", return_value=False))
        self.enterContext(patch.object(get_shared_album, "verify_turnstile", return_value=True))
        self.enterContext(patch.object(get_shared_album, "check_rate_limit", return_value=True))
        self.enterContext(patch.object(get_shared_album, "_audit"))
        self.detail = self.enterContext(patch.object(get_shared_album, "serialize_album_detail", side_effect=lambda album: {"title": album["title"]}))
        self.images = self.enterContext(patch.object(get_shared_album, "serialize_images", side_effect=lambda album: album["images"]))

    def call(self):
        return get_shared_album.handler({"pathParameters": {"shareCode": SHARE_CODE},
                                         "headers": {"x-turnstile-token": "token"}}, None)

    def test_active_share_uses_current_manifest_with_existing_response_shape(self):
        response = self.call()
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response["headers"]["Cache-Control"], "private, no-store")
        self.assertEqual(response_body(response), {"title": "Current title", "images": [{"rawKey": "current"}]})
        self.table.get_item.assert_called_once_with(Key={"albumId": ALBUM_ID}, ConsistentRead=True)
        self.detail.assert_called_once_with(self.fresh)
        self.images.assert_called_once_with(self.fresh)

    def test_revoked_rotated_private_deleted_and_missing_records_issue_no_media_urls(self):
        candidates = [None, {}, {**self.fresh, "isShared": False}, {**self.fresh, "shareCode": "new-share-code"},
                      {**self.fresh, "visibility": "private"}, {**self.fresh, "status": "deleted"},
                      {**self.fresh, "visibility": "public", "isShared": False}]
        for record in candidates:
            with self.subTest(record=record):
                self.table.get_item.return_value = {"Item": record}
                response = self.call()
                self.assertEqual(response["statusCode"], 404)
                self.assertEqual(response_body(response)["error"], "Shared album not found")
        self.detail.assert_not_called()
        self.images.assert_not_called()

    def test_empty_ambiguous_or_malformed_index_never_triggers_extra_read(self):
        for rows in ([], [self.stale, self.stale], [{"albumId": "bad"}], [{}]):
            with self.subTest(rows=rows):
                self.table.query.return_value = {"Items": rows}
                self.assertEqual(self.call()["statusCode"], 404)
        self.table.get_item.assert_not_called()
        self.images.assert_not_called()

    def test_authoritative_read_failure_never_falls_back_to_stale_grant(self):
        self.table.get_item.side_effect = RuntimeError("private provider details")
        response = self.call()
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("private provider details", response["body"])
        self.detail.assert_not_called()
        self.images.assert_not_called()

    def test_public_album_still_works_with_an_active_matching_share(self):
        self.table.get_item.return_value = {"Item": {**self.fresh, "visibility": "public"}}
        self.assertEqual(self.call()["statusCode"], 200)
