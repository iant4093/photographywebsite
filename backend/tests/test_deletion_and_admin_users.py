import json
import unittest
from unittest.mock import Mock, call, patch

from test_support import response_body

import delete_album
import delete_images
import deletion_helpers
import edit_user
import owner_helpers
import update_image


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


class DeletionHelperTests(unittest.TestCase):
    def test_canonical_album_prefix_ignores_stored_data(self):
        self.assertEqual(deletion_helpers.canonical_album_prefix(ALBUM_ID), f"albums/{ALBUM_ID}/")

    def test_prefix_delete_includes_versions_and_delete_markers(self):
        paginator = Mock()
        paginator.paginate.return_value = [
            {
                "Versions": [{"Key": "albums/a/photo.jpg", "VersionId": "v1"}],
                "DeleteMarkers": [{"Key": "albums/a/photo.jpg", "VersionId": "m1"}],
            }
        ]
        fake_s3 = Mock()
        fake_s3.get_paginator.return_value = paginator
        fake_s3.delete_objects.return_value = {}
        with patch.object(deletion_helpers, "s3", fake_s3):
            deleted = deletion_helpers.delete_prefix_all_versions("albums/a/")
        self.assertEqual(deleted, 2)
        objects = fake_s3.delete_objects.call_args.kwargs["Delete"]["Objects"]
        self.assertIn({"Key": "albums/a/photo.jpg", "VersionId": "v1"}, objects)
        self.assertIn({"Key": "albums/a/photo.jpg", "VersionId": "m1"}, objects)

    def test_exact_key_delete_does_not_delete_similar_prefix(self):
        paginator = Mock()
        paginator.paginate.return_value = [
            {
                "Versions": [
                    {"Key": "albums/a/photo.jpg", "VersionId": "v1"},
                    {"Key": "albums/a/photo.jpg.backup", "VersionId": "v2"},
                ]
            }
        ]
        fake_s3 = Mock()
        fake_s3.get_paginator.return_value = paginator
        fake_s3.delete_objects.return_value = {}
        with patch.object(deletion_helpers, "s3", fake_s3):
            deletion_helpers.delete_keys_all_versions(["albums/a/photo.jpg"])
        self.assertEqual(
            fake_s3.delete_objects.call_args.kwargs["Delete"]["Objects"],
            [{"Key": "albums/a/photo.jpg", "VersionId": "v1"}],
        )

    def test_preflight_rejects_over_limit_before_any_delete(self):
        paginator = Mock()
        paginator.paginate.return_value = [{
            "Versions": [
                {"Key": "albums/a/one.jpg", "VersionId": "v1"},
                {"Key": "albums/a/two.jpg", "VersionId": "v2"},
            ]
        }]
        fake_s3 = Mock()
        fake_s3.get_paginator.return_value = paginator
        with patch.object(deletion_helpers, "s3", fake_s3):
            with self.assertRaises(deletion_helpers.DeletionTooLargeError):
                deletion_helpers.preflight_deletion(prefixes=["albums/a/"], max_versions=1)
        fake_s3.delete_objects.assert_not_called()


class DeleteAlbumTests(unittest.TestCase):
    def test_handler_never_uses_untrusted_stored_prefix(self):
        record = {"albumId": ALBUM_ID, "s3Prefix": "albums/other-user/"}
        with patch.object(delete_album, "require_admin", return_value=None), patch.object(
            delete_album.table, "get_item", return_value={"Item": record}
        ), patch.object(delete_album.table, "delete_item"), patch.object(
            delete_album, "preflight_deletion", return_value=0
        ), patch.object(
            delete_album, "delete_prefix_all_versions", return_value=0
        ) as delete_prefix:
            response = delete_album.handler({"pathParameters": {"albumId": ALBUM_ID}}, None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(
            delete_prefix.call_args_list,
            [call(f"albums/{ALBUM_ID}/"), call(f"temp-zips/{ALBUM_ID}/")],
        )

    def test_handler_deletes_only_canonical_and_separately_approved_legacy_prefix(self):
        legacy = "albums/summer-portraits-a1b2c3d4/"
        record = {"albumId": ALBUM_ID, "s3Prefix": "albums/untrusted/", "legacyS3Prefix": legacy}
        with patch.object(delete_album, "require_admin", return_value=None), patch.object(
            delete_album.table, "get_item", return_value={"Item": record}
        ), patch.object(delete_album.table, "delete_item"), patch.object(
            delete_album, "preflight_deletion", return_value=0
        ) as preflight, patch.object(
            delete_album, "delete_prefix_all_versions", return_value=0
        ) as delete_prefix:
            response = delete_album.handler({"pathParameters": {"albumId": ALBUM_ID}}, None)
        self.assertEqual(response["statusCode"], 200)
        expected = (f"albums/{ALBUM_ID}/", legacy, f"temp-zips/{ALBUM_ID}/")
        self.assertEqual(preflight.call_args.kwargs["prefixes"], expected)
        self.assertEqual(delete_prefix.call_args_list, [call(prefix) for prefix in expected])


class DeleteImagesTests(unittest.TestCase):
    def test_request_can_delete_only_manifest_keys(self):
        raw_key = f"albums/{ALBUM_ID}/original/photo.jpg"
        record = {
            "albumId": ALBUM_ID,
            "visibility": "private",
            "images": [{"rawKey": raw_key}],
        }
        event = {
            "pathParameters": {"albumId": ALBUM_ID},
            "body": json.dumps({"keys": [raw_key, f"albums/{ALBUM_ID}/original/not-in-manifest.jpg"]}),
        }
        with patch.object(delete_images, "require_admin", return_value=None), patch.object(
            delete_images.table, "get_item", return_value={"Item": record}
        ), patch.object(delete_images, "delete_keys_all_versions") as delete:
            response = delete_images.handler(event, None)
        self.assertEqual(response["statusCode"], 400)
        delete.assert_not_called()

    def test_success_updates_manifest_count_after_s3_delete(self):
        first = f"albums/{ALBUM_ID}/original/one.jpg"
        second = f"albums/{ALBUM_ID}/original/two.jpg"
        record = {"albumId": ALBUM_ID, "images": [{"rawKey": first}, {"rawKey": second}]}
        event = {"pathParameters": {"albumId": ALBUM_ID}, "body": json.dumps({"keys": [first]})}
        with patch.object(delete_images, "require_admin", return_value=None), patch.object(
            delete_images.table, "get_item", return_value={"Item": record}
        ), patch.object(delete_images, "delete_keys_all_versions", return_value=1), patch.object(
            delete_images, "delete_prefix_all_versions", return_value=0
        ), patch.object(delete_images, "preflight_deletion", return_value=0), patch.object(
            delete_images.table, "update_item"
        ) as update:
            response = delete_images.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        values = update.call_args.kwargs["ExpressionAttributeValues"]
        self.assertEqual(values[":count"], 1)
        self.assertEqual(values[":images"], [{"rawKey": second}])

    def test_deleting_cover_selects_retained_image_atomically(self):
        first = f"albums/{ALBUM_ID}/original/one.jpg"
        first_thumb = f"albums/{ALBUM_ID}/thumbnail/one.jpg"
        second = f"albums/{ALBUM_ID}/original/two.jpg"
        second_thumb = f"albums/{ALBUM_ID}/thumbnail/two.jpg"
        record = {
            "albumId": ALBUM_ID,
            "coverImageUrl": first,
            "coverThumbKey": first_thumb,
            "coverBlurhash": "old",
            "images": [
                {"rawKey": first, "thumbKey": first_thumb, "blurhash": "old"},
                {"rawKey": second, "thumbKey": second_thumb, "blurhash": "new"},
            ],
        }
        event = {"pathParameters": {"albumId": ALBUM_ID}, "body": json.dumps({"keys": [first]})}
        with patch.object(delete_images, "require_admin", return_value=None), patch.object(
            delete_images.table, "get_item", return_value={"Item": record}
        ), patch.object(delete_images, "preflight_deletion", return_value=0), patch.object(
            delete_images, "delete_keys_all_versions", return_value=2
        ), patch.object(delete_images, "delete_prefix_all_versions", return_value=0), patch.object(
            delete_images.table, "update_item"
        ) as update:
            response = delete_images.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        values = update.call_args.kwargs["ExpressionAttributeValues"]
        self.assertEqual(values[":cover"], second)
        self.assertEqual(values[":coverThumb"], second_thumb)
        self.assertEqual(values[":coverBlurhash"], "new")


class AdminUserTests(unittest.TestCase):
    def test_administrator_cannot_assign_password(self):
        event = {
            "pathParameters": {"email": "user@example.com"},
            "body": json.dumps({"email": "user@example.com", "password": "AdminChosenPassword123!"}),
        }
        with patch.object(edit_user, "require_admin", return_value=None):
            response = edit_user.handler(event, None)
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(response_body(response)["code"], "password_not_allowed")

    def test_target_guard_blocks_self_and_exact_admins_group(self):
        cognito = Mock()
        cognito.admin_list_groups_for_user.return_value = {"Groups": []}
        with patch.object(owner_helpers, "get_caller_claims", return_value={"sub": "same"}):
            with self.assertRaises(owner_helpers.AuthError):
                owner_helpers.assert_admin_target_mutable({}, cognito, "pool", "user", "same")
        cognito.admin_list_groups_for_user.return_value = {"Groups": [{"GroupName": "Admins"}]}
        with patch.object(owner_helpers, "get_caller_claims", return_value={"sub": "caller"}):
            with self.assertRaises(owner_helpers.AuthError):
                owner_helpers.assert_admin_target_mutable({}, cognito, "pool", "user", "target")

    def test_target_guard_does_not_substring_match_admin_group(self):
        cognito = Mock()
        cognito.admin_list_groups_for_user.return_value = {"Groups": [{"GroupName": "SuperAdmins"}]}
        with patch.object(owner_helpers, "get_caller_claims", return_value={"sub": "caller"}):
            owner_helpers.assert_admin_target_mutable({}, cognito, "pool", "user", "target")


class UpdateImageTests(unittest.TestCase):
    def test_cover_thumbnail_tracks_update_and_obsolete_version_is_deleted(self):
        raw = f"albums/{ALBUM_ID}/original/photo.jpg"
        old_thumb = f"albums/{ALBUM_ID}/thumbnail/old.jpg"
        new_thumb = f"albums/{ALBUM_ID}/thumbnail/new.jpg"
        record = {
            "albumId": ALBUM_ID,
            "visibility": "private",
            "coverImageUrl": raw,
            "coverThumbKey": old_thumb,
            "images": [{"rawKey": raw, "thumbKey": old_thumb}],
        }
        event = {
            "pathParameters": {"albumId": ALBUM_ID},
            "body": json.dumps({"rawKey": raw, "thumbKey": new_thumb, "blurhash": "new-hash"}),
        }
        with patch.object(update_image, "require_admin", return_value=None), patch.object(
            update_image.table, "get_item", return_value={"Item": record}
        ), patch.object(update_image, "preflight_deletion", return_value=1), patch.object(
            update_image, "tag_keys_visibility", return_value=1
        ), patch.object(update_image.table, "update_item") as update, patch.object(
            update_image, "delete_keys_all_versions", return_value=1
        ) as delete:
            response = update_image.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        expression = update.call_args.kwargs["UpdateExpression"]
        self.assertIn("coverThumbKey = :thumbKey", expression)
        self.assertIn("coverBlurhash = :blurhash", expression)
        delete.assert_called_once_with([old_thumb])


if __name__ == "__main__":
    unittest.main()
