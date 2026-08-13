import json
import os
from unittest.mock import Mock, mock_open, patch
import unittest

from test_support import DEFAULT_ENV

import google_drive_sync


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
RAW_KEY = f"albums/{ALBUM_ID}/original/photo.jpg"


class GoogleCredentialTests(unittest.TestCase):
    def setUp(self):
        google_drive_sync._credentials_cache = None

    def tearDown(self):
        google_drive_sync._credentials_cache = None

    def test_secure_parameter_is_cached_and_must_be_an_object(self):
        client = Mock()
        client.get_parameter.return_value = {
            "Parameter": {"Value": json.dumps({"oauth": {"refresh_token": "token"}})}
        }
        with patch.dict(os.environ, {"GOOGLE_OAUTH_PARAMETER": "/google"}), patch.object(
            google_drive_sync, "ssm_client", client
        ):
            first = google_drive_sync._credential_payload()
            second = google_drive_sync._credential_payload()
        self.assertIs(first, second)
        client.get_parameter.assert_called_once_with(Name="/google", WithDecryption=True)

        google_drive_sync._credentials_cache = None
        client.get_parameter.return_value = {"Parameter": {"Value": "[]"}}
        with patch.dict(os.environ, {"GOOGLE_OAUTH_PARAMETER": "/google"}), patch.object(
            google_drive_sync, "ssm_client", client
        ), self.assertRaises(RuntimeError):
            google_drive_sync._credential_payload()

    def test_legacy_file_requires_explicit_opt_in(self):
        with patch.dict(
            os.environ,
            {"GOOGLE_OAUTH_PARAMETER": "", "ALLOW_LEGACY_GOOGLE_CREDENTIAL_FILE": "true"},
        ), patch("builtins.open", mock_open(read_data='{"refresh_token":"legacy"}')) as handle:
            self.assertEqual(google_drive_sync._credential_payload()["refresh_token"], "legacy")
        handle.assert_called_once_with("google_oauth_token.json", "r", encoding="utf-8")

        with patch.dict(
            os.environ,
            {"GOOGLE_OAUTH_PARAMETER": "", "ALLOW_LEGACY_GOOGLE_CREDENTIAL_FILE": "false"},
        ), self.assertRaises(RuntimeError):
            google_drive_sync._credential_payload()

    def test_all_supported_credential_shapes_and_unsupported_shape(self):
        shapes = (
            ({"oauth": {"refresh_token": "nested"}}, "oauth"),
            ({"service_account": {"type": "service_account"}}, "service"),
            ({"type": "service_account"}, "service"),
            ({"refresh_token": "flat"}, "oauth"),
        )
        for payload, kind in shapes:
            oauth_credentials = Mock(name="oauth-credentials")
            service_credentials = Mock(name="service-credentials")
            with self.subTest(kind=kind, payload=payload), patch.object(
                google_drive_sync, "_credential_payload", return_value=payload
            ), patch.object(
                google_drive_sync.Credentials,
                "from_authorized_user_info",
                return_value=oauth_credentials,
            ) as oauth, patch.object(
                google_drive_sync.service_account.Credentials,
                "from_service_account_info",
                return_value=service_credentials,
            ) as service, patch.object(
                google_drive_sync, "build", return_value="drive-service"
            ) as build:
                self.assertEqual(google_drive_sync.get_drive_service(), "drive-service")
            if kind == "oauth":
                oauth.assert_called_once()
                service.assert_not_called()
                expected = oauth_credentials
            else:
                service.assert_called_once()
                oauth.assert_not_called()
                expected = service_credentials
            self.assertIs(build.call_args.kwargs["credentials"], expected)
            self.assertFalse(build.call_args.kwargs["cache_discovery"])

        with patch.object(google_drive_sync, "_credential_payload", return_value={"client_id": "only"}):
            with self.assertRaises(RuntimeError):
                google_drive_sync.get_drive_service()


class GoogleDriveProviderHelperTests(unittest.TestCase):
    def test_drive_literal_escapes_query_metacharacters(self):
        self.assertEqual(google_drive_sync._drive_literal("a\\b'c"), "a\\\\b\\'c")

    def test_folder_lookup_existing_and_creation_with_parent(self):
        service = Mock()
        files = service.files.return_value
        files.list.return_value.execute.return_value = {"files": [{"id": "existing"}]}
        self.assertEqual(
            google_drive_sync.find_or_create_folder(service, "Owner's Photos", "parent'id"),
            "existing",
        )
        query = files.list.call_args.kwargs["q"]
        self.assertIn("Owner\\'s Photos", query)
        self.assertIn("parent\\'id", query)
        files.create.assert_not_called()

        files.list.return_value.execute.return_value = {"files": []}
        files.create.return_value.execute.return_value = {"id": "created"}
        self.assertEqual(google_drive_sync.find_or_create_folder(service, "Album"), "created")
        self.assertNotIn("parents", files.create.call_args.kwargs["body"])

        files.create.return_value.execute.return_value = {"id": "child"}
        self.assertEqual(
            google_drive_sync.find_or_create_folder(
                service,
                "Album",
                "parent",
                app_properties={google_drive_sync.APP_KIND_KEY: "category"},
            ),
            "child",
        )
        self.assertEqual(files.create.call_args.kwargs["body"]["parents"], ["parent"])
        self.assertEqual(
            files.create.call_args.kwargs["body"]["appProperties"],
            {google_drive_sync.APP_KIND_KEY: "category"},
        )
        self.assertIn("appProperties has", files.list.call_args.kwargs["q"])

    def test_existing_legacy_album_folder_is_moved_and_given_stable_identity(self):
        service = Mock()
        files = service.files.return_value
        files.list.return_value.execute.side_effect = [
            {"files": []},
            {"files": []},
            {"files": [{"id": "legacy", "name": "Album", "parents": ["photos"]}]},
        ]
        files.update.return_value.execute.return_value = {"id": "legacy", "parents": ["category"]}

        result = google_drive_sync.find_or_create_album_folder(
            service,
            ALBUM_ID,
            "Album",
            "photos",
            "category",
        )

        self.assertEqual(result, "legacy")
        files.update.assert_called_once_with(
            fileId="legacy",
            body={
                "name": "Album",
                "appProperties": {
                    google_drive_sync.APP_KIND_KEY: "album",
                    google_drive_sync.APP_ALBUM_ID_KEY: ALBUM_ID,
                },
            },
            fields="id,parents",
            supportsAllDrives=True,
            addParents="category",
            removeParents="photos",
        )

    def test_album_identity_prevents_duplicate_folders_and_handles_renames(self):
        service = Mock()
        files = service.files.return_value
        files.list.return_value.execute.return_value = {
            "files": [{"id": "identified", "name": "Old title", "parents": ["old-category"]}]
        }
        files.update.return_value.execute.return_value = {"id": "identified", "parents": ["new-category"]}

        result = google_drive_sync.find_or_create_album_folder(
            service,
            ALBUM_ID,
            "New title",
            "photos",
            "new-category",
        )

        self.assertEqual(result, "identified")
        files.create.assert_not_called()
        self.assertEqual(files.update.call_args.kwargs["addParents"], "new-category")
        self.assertEqual(files.update.call_args.kwargs["removeParents"], "old-category")

    def test_existing_file_lookup(self):
        service = Mock()
        files = service.files.return_value
        files.list.return_value.execute.return_value = {"files": [{"id": "file"}]}
        self.assertEqual(google_drive_sync._existing_file_id(service, "a.jpg", "folder"), "file")
        files.list.return_value.execute.return_value = {}
        self.assertIsNone(google_drive_sync._existing_file_id(service, "a.jpg", "folder"))


class GoogleDriveHandlerTests(unittest.TestCase):
    def setUp(self):
        self.album = {
            "albumId": ALBUM_ID,
            "status": "active",
            "backupToGoogleDrive": True,
            "type": "photo",
            "title": "Album",
            "category": "Portraits",
        }
        self.event = {
            "albumType": "photo",
            "albumId": ALBUM_ID,
            "albumTitle": "Album",
            "bucket": DEFAULT_ENV["IMAGES_BUCKET"],
            "keys": [RAW_KEY],
        }

    def test_destination_and_album_eligibility_fail_closed(self):
        with patch.dict(os.environ, {"GOOGLE_DRIVE_FOLDER_ID": ""}):
            with self.assertRaises(RuntimeError):
                google_drive_sync.handler(self.event, None)
        for record in (
            None,
            {**self.album, "status": "pending"},
            {**self.album, "backupToGoogleDrive": False},
        ):
            table = Mock()
            table.get_item.return_value = {"Item": record} if record else {}
            with self.subTest(record=record), patch.dict(
                os.environ, {"GOOGLE_DRIVE_FOLDER_ID": "root"}
            ), patch.object(google_drive_sync, "table", table), self.assertRaises(
                google_drive_sync.ValidationError
            ):
                google_drive_sync.handler(self.event, None)

    def test_unexpected_bucket_is_rejected_before_drive_provider(self):
        table = Mock()
        table.get_item.return_value = {"Item": self.album}
        event = {**self.event, "bucket": "attacker-bucket"}
        with patch.dict(os.environ, {"GOOGLE_DRIVE_FOLDER_ID": "root"}), patch.object(
            google_drive_sync, "table", table
        ), patch.object(google_drive_sync, "get_drive_service") as drive, self.assertRaises(
            google_drive_sync.ValidationError
        ):
            google_drive_sync.handler(event, None)
        drive.assert_not_called()

    def _temporary_file(self, name="/tmp/fake-drive-photo.jpg"):
        handle = Mock()
        handle.name = name
        handle.__enter__ = Mock(return_value=handle)
        handle.__exit__ = Mock(return_value=False)
        return handle

    def test_new_file_upload_chunks_and_cleans_temporary_path(self):
        table = Mock()
        table.get_item.return_value = {"Item": self.album}
        s3 = Mock()
        s3.head_object.return_value = {"ContentType": "image/jpeg"}
        service = Mock()
        request = Mock()
        request.next_chunk.side_effect = [(None, None), (None, {"id": "uploaded"})]
        service.files.return_value.create.return_value = request
        temporary = self._temporary_file()
        with patch.dict(os.environ, {"GOOGLE_DRIVE_FOLDER_ID": "root"}), patch.object(
            google_drive_sync, "table", table
        ), patch.object(google_drive_sync, "s3", s3), patch.object(
            google_drive_sync, "get_drive_service", return_value=service
        ), patch.object(
            google_drive_sync, "find_or_create_folder", side_effect=["photos", "category"]
        ) as folder, patch.object(
            google_drive_sync, "find_or_create_album_folder", return_value="album"
        ) as album_folder, patch.object(
            google_drive_sync, "_existing_file_id", return_value=None
        ), patch.object(
            google_drive_sync.tempfile, "NamedTemporaryFile", return_value=temporary
        ), patch.object(
            google_drive_sync, "MediaFileUpload", return_value="media"
        ) as media, patch.object(
            google_drive_sync.os.path, "exists", return_value=True
        ), patch.object(
            google_drive_sync.os, "remove"
        ) as remove:
            result = google_drive_sync.handler(self.event, None)
        self.assertEqual(result, {"status": "success", "uploadedCount": 1})
        self.assertEqual(folder.call_args_list[0].args, (service, "Photos", "root"))
        self.assertEqual(
            folder.call_args_list[1].args,
            (service, "Portraits", "photos"),
        )
        self.assertEqual(
            folder.call_args_list[1].kwargs,
            {"app_properties": {google_drive_sync.APP_KIND_KEY: "category"}},
        )
        album_folder.assert_called_once_with(
            service,
            ALBUM_ID,
            "Album",
            "photos",
            "category",
        )
        s3.download_file.assert_called_once_with(DEFAULT_ENV["IMAGES_BUCKET"], RAW_KEY, temporary.name)
        self.assertEqual(media.call_args.kwargs["mimetype"], "image/jpeg")
        self.assertTrue(media.call_args.kwargs["resumable"])
        self.assertEqual(request.next_chunk.call_count, 2)
        remove.assert_called_once_with(temporary.name)

    def test_existing_video_file_is_updated_and_missing_temp_is_not_removed(self):
        album = {**self.album, "albumId": ALBUM_ID, "type": "video"}
        table = Mock()
        table.get_item.return_value = {"Item": album}
        service = Mock()
        request = Mock()
        request.next_chunk.return_value = (None, {"id": "updated"})
        service.files.return_value.update.return_value = request
        temporary = self._temporary_file("/tmp/video.mp4")
        event = {**self.event, "albumType": "video"}
        with patch.dict(os.environ, {"GOOGLE_DRIVE_FOLDER_ID": "root"}), patch.object(
            google_drive_sync, "table", table
        ), patch.object(google_drive_sync, "s3", Mock(head_object=Mock(return_value={}))), patch.object(
            google_drive_sync, "get_drive_service", return_value=service
        ), patch.object(
            google_drive_sync, "find_or_create_folder", side_effect=["videos", "category"]
        ) as folder, patch.object(
            google_drive_sync, "find_or_create_album_folder", return_value="album"
        ), patch.object(
            google_drive_sync, "_existing_file_id", return_value="existing"
        ), patch.object(
            google_drive_sync.tempfile, "NamedTemporaryFile", return_value=temporary
        ), patch.object(google_drive_sync, "MediaFileUpload", return_value="media"), patch.object(
            google_drive_sync.os.path, "exists", return_value=False
        ), patch.object(google_drive_sync.os, "remove") as remove:
            result = google_drive_sync.handler(event, None)
        self.assertEqual(result["uploadedCount"], 1)
        self.assertEqual(folder.call_args_list[0].args[1], "Videos")
        service.files.return_value.update.assert_called_once_with(
            fileId="existing", media_body="media", fields="id"
        )
        remove.assert_not_called()

    def test_provider_failure_after_temp_creation_still_cleans_up(self):
        table = Mock()
        table.get_item.return_value = {"Item": self.album}
        s3 = Mock()
        s3.head_object.return_value = {}
        s3.download_file.side_effect = RuntimeError("provider failure")
        temporary = self._temporary_file()
        with patch.dict(os.environ, {"GOOGLE_DRIVE_FOLDER_ID": "root"}), patch.object(
            google_drive_sync, "table", table
        ), patch.object(google_drive_sync, "s3", s3), patch.object(
            google_drive_sync, "get_drive_service", return_value=Mock()
        ), patch.object(
            google_drive_sync, "find_or_create_folder", side_effect=["photos", "category"]
        ), patch.object(
            google_drive_sync, "find_or_create_album_folder", return_value="album"
        ), patch.object(
            google_drive_sync.tempfile, "NamedTemporaryFile", return_value=temporary
        ), patch.object(
            google_drive_sync.os.path, "exists", return_value=True
        ), patch.object(google_drive_sync.os, "remove") as remove, self.assertRaisesRegex(
            RuntimeError, "provider failure"
        ):
            google_drive_sync.handler(self.event, None)
        remove.assert_called_once_with(temporary.name)

    def test_empty_key_list_reconciles_folders_without_uploading(self):
        table = Mock()
        table.get_item.return_value = {"Item": self.album}
        service = Mock()
        event = {**self.event, "keys": []}
        with patch.dict(os.environ, {"GOOGLE_DRIVE_FOLDER_ID": "root"}), patch.object(
            google_drive_sync, "table", table
        ), patch.object(
            google_drive_sync, "get_drive_service", return_value=service
        ), patch.object(
            google_drive_sync, "find_or_create_folder", side_effect=["photos", "category"]
        ), patch.object(
            google_drive_sync, "find_or_create_album_folder", return_value="album"
        ) as album_folder, patch.object(google_drive_sync, "s3") as s3:
            result = google_drive_sync.handler(event, None)
        self.assertEqual(result, {"status": "success", "uploadedCount": 0})
        album_folder.assert_called_once()
        s3.head_object.assert_not_called()

    def test_opted_out_legacy_album_only_reconciles_an_identified_folder(self):
        table = Mock()
        table.get_item.return_value = {
            "Item": {**self.album, "backupToGoogleDrive": False}
        }
        service = Mock()
        event = {**self.event, "keys": []}
        with patch.dict(os.environ, {"GOOGLE_DRIVE_FOLDER_ID": "root"}), patch.object(
            google_drive_sync, "table", table
        ), patch.object(
            google_drive_sync, "get_drive_service", return_value=service
        ), patch.object(
            google_drive_sync, "_album_folder_by_id", return_value=None
        ), patch.object(
            google_drive_sync, "find_or_create_folder"
        ) as folder:
            result = google_drive_sync.handler(event, None)
        self.assertEqual(
            result,
            {"status": "success", "uploadedCount": 0, "folderReconciled": False},
        )
        folder.assert_not_called()

        identified = {"id": "legacy", "parents": ["photos"]}
        with patch.dict(os.environ, {"GOOGLE_DRIVE_FOLDER_ID": "root"}), patch.object(
            google_drive_sync, "table", table
        ), patch.object(
            google_drive_sync, "get_drive_service", return_value=service
        ), patch.object(
            google_drive_sync, "_album_folder_by_id", return_value=identified
        ), patch.object(
            google_drive_sync, "find_or_create_folder", side_effect=["photos", "category"]
        ), patch.object(
            google_drive_sync, "find_or_create_album_folder", return_value="legacy"
        ) as album_folder:
            result = google_drive_sync.handler(event, None)
        self.assertEqual(result, {"status": "success", "uploadedCount": 0})
        album_folder.assert_called_once()


if __name__ == "__main__":
    unittest.main()
