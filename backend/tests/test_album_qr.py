import unittest
import json
from unittest.mock import Mock, patch

from test_support import DEFAULT_ENV  # noqa: F401

import album_qr
import create_album
import update_album


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


def record(**overrides):
    value = {
        "albumId": ALBUM_ID,
        "type": "photo",
        "status": "active",
        "visibility": "public",
        "title": "Album",
    }
    value.update(overrides)
    return value


class AlbumQrContractTests(unittest.TestCase):
    def test_targets_and_versioned_keys_cover_photo_video_and_shared_routes(self):
        photo = record()
        video = record(type="video")
        shared = record(visibility="unlisted", isShared=True, shareCode="valid-share-code")
        self.assertEqual(
            album_qr.album_qr_target_url(photo),
            f"https://iantruongphotography.com/album/{ALBUM_ID}",
        )
        self.assertEqual(
            album_qr.album_qr_target_url(video),
            f"https://iantruongphotography.com/video/{ALBUM_ID}",
        )
        self.assertEqual(
            album_qr.album_qr_target_url(shared),
            "https://iantruongphotography.com/sharedalbum/valid-share-code",
        )
        key = album_qr.album_qr_key(photo)
        self.assertRegex(key, rf"^albums/{ALBUM_ID}/qr/v1/[a-f0-9]{{24}}\.svg$")
        self.assertNotEqual(key, album_qr.album_qr_key(video))

    def test_ineligible_and_invalid_inputs_fail_closed(self):
        self.assertIsNone(album_qr.album_qr_target_url(record(visibility="private")))
        self.assertIsNone(album_qr.album_qr_target_url(record(visibility="unlisted", isShared=False)))
        self.assertIsNone(album_qr.album_qr_target_url(record(visibility="unlisted", isShared=True, shareCode="bad")))
        self.assertIsNone(album_qr.album_qr_target_url(record(status="pending"), require_active=True))
        for origin in (
            "http://iantruongphotography.com",
            "https://user@example.com",
            "https://example.com/path",
            "https://example.com?query=1",
            "https://example.com:8443",
        ):
            with self.subTest(origin=origin), self.assertRaises(album_qr.ValidationError):
                album_qr.frontend_origin(origin)
        with self.assertRaises(album_qr.ValidationError):
            album_qr.album_qr_target_url(record(type="audio"))

    def test_svg_is_fixed_safe_markup_and_upload_starts_pending(self):
        target = f"https://iantruongphotography.com/album/{ALBUM_ID}"
        svg = album_qr.render_album_qr_svg(target)
        self.assertTrue(svg.startswith(b"<svg"))
        self.assertNotIn(b"<script", svg.lower())
        s3 = Mock()
        key = album_qr.write_album_qr(record(), s3_client=s3, bucket="media-test")
        self.assertEqual(key, album_qr.album_qr_key(record()))
        request = s3.put_object.call_args.kwargs
        self.assertEqual(request["Tagging"], "visibility=pending")
        self.assertEqual(request["ContentType"], "image/svg+xml")
        self.assertIn("immutable", request["CacheControl"])

        s3.reset_mock()
        shared = record(visibility="unlisted", isShared=True, shareCode="valid-share-code")
        album_qr.write_album_qr(shared, s3_client=s3, bucket="media-test")
        self.assertEqual(s3.put_object.call_args.kwargs["CacheControl"], "private, max-age=300")


class AlbumQrLifecycleTests(unittest.TestCase):
    def test_create_persists_qr_key_under_creator_guard(self):
        table = Mock()
        item = record(status="pending", createdBySub="creator")
        expected = f"albums/{ALBUM_ID}/qr/v1/{'c' * 24}.svg"
        with patch("album_qr.write_album_qr", return_value=expected), patch.object(
            create_album, "table", table
        ), patch.object(create_album, "ensure_album_item_budget") as budget:
            self.assertEqual(create_album._ensure_album_qr(item, "creator"), expected)
        self.assertEqual(item["qrCodeKey"], expected)
        budget.assert_called_once()
        self.assertIn("createdBySub = :creator", table.update_item.call_args.kwargs["ConditionExpression"])

    def test_create_private_album_has_no_qr_metadata(self):
        item = record(visibility="private", qrCodeKey="old")
        with patch("album_qr.write_album_qr", return_value=None), patch.object(create_album, "table") as table:
            self.assertIsNone(create_album._ensure_album_qr(item, "creator"))
        self.assertNotIn("qrCodeKey", item)
        table.update_item.assert_not_called()

    def test_update_reconciles_changed_and_revoked_links(self):
        updated = record()
        desired = album_qr.album_qr_key(updated)
        with patch.object(update_album, "write_album_qr", return_value=desired) as write:
            self.assertEqual(update_album._reconcile_album_qr(updated), desired)
        self.assertEqual(updated["qrCodeKey"], desired)
        write.assert_called_once()

        with patch.object(update_album, "write_album_qr") as write:
            self.assertEqual(update_album._reconcile_album_qr(updated), desired)
        write.assert_not_called()

        revoked = record(visibility="unlisted", isShared=False, qrCodeKey=desired)
        self.assertIsNone(update_album._reconcile_album_qr(revoked))
        self.assertNotIn("qrCodeKey", revoked)

    def test_public_to_private_transition_restricts_superseded_qr_before_commit(self):
        old = record(qrCodeKey=album_qr.album_qr_key(record()), images=[])
        updated = record(
            visibility="private",
            ownerEmail="owner@example.com",
            ownerSub="owner-sub",
            images=[],
        )
        table = Mock()
        table.get_item.return_value = {"Item": old}
        event = {
            "pathParameters": {"albumId": ALBUM_ID},
            "body": json.dumps({"visibility": "private"}),
        }
        ordering = Mock()
        ordering.commit.return_value = {}
        with patch.object(update_album, "verify_front_door_request", return_value=None), patch.object(
            update_album, "require_admin", return_value=None
        ), patch.object(update_album, "table", table), patch.object(
            update_album, "_updated_album", return_value=updated
        ), patch.object(update_album, "_reconcile_album_qr", return_value=None), patch.object(
            update_album, "tag_keys_visibility", side_effect=ordering.restrict_qr
        ) as restrict, patch.object(
            update_album, "tag_album_visibility", side_effect=ordering.restrict_album
        ), patch.object(update_album, "invalidate_public_previews"), patch.object(
            update_album, "tag_preview_visibility"
        ), patch.object(update_album, "request_public_api_invalidation"), patch.object(update_album, "_audit"):
            table.update_item.side_effect = ordering.commit
            response = update_album.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        restrict.assert_called_once_with([old["qrCodeKey"]], "private")
        self.assertLess(
            ordering.mock_calls.index(unittest.mock.call.restrict_qr([old["qrCodeKey"]], "private")),
            ordering.mock_calls.index(unittest.mock.call.commit(**table.update_item.call_args.kwargs)),
        )


if __name__ == "__main__":
    unittest.main()
