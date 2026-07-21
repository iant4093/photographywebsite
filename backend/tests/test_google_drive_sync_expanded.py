import base64
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

    def test_secret_string_is_cached_and_must_be_an_object(self):
        client = Mock()
        client.get_secret_value.return_value = {
            "SecretString": json.dumps({"oauth": {"refresh_token": "token"}})
        }
        with patch.dict(os.environ, {"GOOGLE_OAUTH_SECRET_ARN": "arn:secret"}), patch.object(
            google_drive_sync, "secrets_client", client
        ):
            first = google_drive_sync._credential_payload()
            second = google_drive_sync._credential_payload()
        self.assertIs(first, second)
        client.get_secret_value.assert_called_once_with(SecretId="arn:secret")

        google_drive_sync._credentials_cache = None
        client.get_secret_value.return_value = {"SecretString": "[]"}
        with patch.dict(os.environ, {"GOOGLE_OAUTH_SECRET_ARN": "arn:secret"}), patch.object(
            google_drive_sync, "secrets_client", client
        ), self.assertRaises(RuntimeError):
            google_drive_sync._credential_payload()

    def test_binary_secret_accepts_bytes_and_base64_string(self):
        payload = {"type": "service_account", "private_key": "redacted"}
        raw = json.dumps(payload).encode()
        for binary in (raw, base64.b64encode(raw).decode()):
            google_drive_sync._credentials_cache = None
            client = Mock()
            client.get_secret_value.return_value = {"SecretBinary": binary}
            with self.subTest(kind=type(binary).__name__), patch.dict(
                os.environ, {"GOOGLE_OAUTH_SECRET_ARN": "arn:secret"}
            ), patch.object(google_drive_sync, "secrets_client", client):
                self.assertEqual(google_drive_sync._credential_payload(), payload)

    def test_legacy_file_requires_explicit_opt_in(self):
        with patch.dict(
            os.environ,
            {"GOOGLE_OAUTH_SECRET_ARN": "", "ALLOW_LEGACY_GOOGLE_CREDENTIAL_FILE": "true"},
        ), patch("builtins.open", mock_open(read_data='{"refresh_token":"legacy"}')) as handle:
            self.assertEqual(google_drive_sync._credential_payload()["refresh_token"], "legacy")
        handle.assert_called_once_with("google_oauth_token.json", "r", encoding="utf-8")

        with patch.dict(
            os.environ,
            {"GOOGLE_OAUTH_SECRET_ARN": "", "ALLOW_LEGACY_GOOGLE_CREDENTIAL_FILE": "false"},
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
        self.assertEqual(google_drive_sync.find_or_create_folder(service, "Album", "parent"), "child")
        self.assertEqual(files.create.call_args.kwargs["body"]["parents"], ["parent"])

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
            google_drive_sync, "find_or_create_folder", side_effect=["photos", "album"]
        ) as folder, patch.object(
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
        s3.download_file.assert_called_once_with(DEFAULT_ENV["IMAGES_BUCKET"], RAW_KEY, temporary.name)
        self.assertEqual(media.call_args.kwargs["mimetype"], "image/jpeg")
        self.assertTrue(media.call_args.kwargs["resumable"])
        self.assertEqual(request.next_chunk.call_count, 2)
        remove.assert_called_once_with(temporary.name)

    def test_existing_video_file_is_updated_and_missing_temp_is_not_removed(self):
        album = {**self.album, "albumId": ALBUM_ID}
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
            google_drive_sync, "find_or_create_folder", side_effect=["videos", "album"]
        ) as folder, patch.object(
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
            google_drive_sync, "find_or_create_folder", side_effect=["photos", "album"]
        ), patch.object(
            google_drive_sync.tempfile, "NamedTemporaryFile", return_value=temporary
        ), patch.object(
            google_drive_sync.os.path, "exists", return_value=True
        ), patch.object(google_drive_sync.os, "remove") as remove, self.assertRaisesRegex(
            RuntimeError, "provider failure"
        ):
            google_drive_sync.handler(self.event, None)
        remove.assert_called_once_with(temporary.name)


if __name__ == "__main__":
    unittest.main()
