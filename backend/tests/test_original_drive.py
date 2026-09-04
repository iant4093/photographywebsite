import hashlib
import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import test_support  # noqa: F401
import original_drive


def folder(file_id="root", parent=None, **updates):
    return {"id": file_id, "name": file_id, "mimeType": original_drive.FOLDER_MIME_TYPE, "parents": [parent] if parent else [], **updates}


def jpg(file_id="jpg", parent="root", body=b"jpeg", **updates):
    return {
        "id": file_id, "name": "4K1A1019.JPG", "mimeType": "image/jpeg", "parents": [parent],
        "size": str(len(body)), "md5Checksum": hashlib.md5(body).hexdigest(), "version": "1",
        "imageMediaMetadata": {"time": "2026:03:14 14:40:46", "cameraModel": "Canon EOS R7"},
        "capabilities": {"canDownload": True}, **updates,
    }


def response(document):
    value = io.BytesIO(document if isinstance(document, bytes) else json.dumps(document).encode())
    value.status = 200
    return value


class OriginalDriveScopeTests(unittest.TestCase):
    def test_existing_full_access_service_account_only_mints_readonly_tokens(self):
        info = {"type": "service_account", "token_uri": "https://oauth2.googleapis.com/token"}
        payload = {"service_account": info, "oauth": {"refresh_token": "writer-token"}, "raw_photo_backup_folder_id": "root"}
        ssm = Mock()
        ssm.get_parameter.return_value = {"Parameter": {"Value": json.dumps(payload)}}
        with patch.object(original_drive.boto3, "client", return_value=ssm), patch.object(original_drive.service_account.Credentials, "from_service_account_info") as credentials:
            client = original_drive.OriginalDrive.from_environment()
        self.assertEqual(client.root_id, "root")
        credentials.assert_called_once_with(info, scopes=("https://www.googleapis.com/auth/drive.readonly",))
        ssm.get_parameter.assert_called_once_with(Name=test_support.DEFAULT_ENV["GOOGLE_OAUTH_PARAMETER"], WithDecryption=True)

    def test_oauth_only_bad_roots_and_non_google_token_endpoints_fail_closed(self):
        base = {"service_account": {"type": "service_account", "token_uri": "https://oauth2.googleapis.com/token"}, "raw_photo_backup_folder_id": "root"}
        cases = [
            {"oauth": {"refresh_token": "secret"}, "raw_photo_backup_folder_id": "root"},
            {**base, "raw_photo_backup_folder_id": "../outside"},
            {**base, "service_account": {"type": "service_account", "token_uri": "https://example.test/token"}},
        ]
        for payload in cases:
            with self.subTest(payload=payload):
                ssm = Mock()
                ssm.get_parameter.return_value = {"Parameter": {"Value": json.dumps(payload)}}
                with patch.object(original_drive.boto3, "client", return_value=ssm), patch.object(original_drive.service_account.Credentials, "from_service_account_info") as credentials, self.assertRaises(original_drive.OriginalDriveError) as raised:
                    original_drive.OriginalDrive.from_environment()
                credentials.assert_not_called()
                self.assertNotIn("secret", str(raised.exception))


class OriginalDriveTests(unittest.TestCase):
    def setUp(self):
        self.opener = Mock()
        self.client = original_drive.OriginalDrive(SimpleNamespace(valid=True, token="secret-token"), "root", opener=self.opener)

    def test_complete_inventory_and_projection_exclude_unrelated_backup_raws_and_shortcuts(self):
        files = [folder(), folder("shoot", "root"), jpg(parent="shoot"), folder("website"), jpg("edited", "website"), {**jpg("raw", "shoot"), "mimeType": "image/x-canon-cr3"}, {**folder("shortcut", "root"), "mimeType": original_drive.SHORTCUT_MIME_TYPE}]
        self.opener.open.side_effect = [response({"files": files[:3], "nextPageToken": "page-two", "incompleteSearch": False}), response({"files": files[3:]})]
        inventory = self.client.list_inventory()
        candidates = original_drive.project_archive(inventory, "root")
        self.assertEqual([item["id"] for item in candidates], ["jpg"])
        requests = [call.args[0] for call in self.opener.open.call_args_list]
        self.assertTrue(all(request.get_method() == "GET" and request.data is None for request in requests))
        self.assertTrue(all(urlsplit(request.full_url).netloc == "www.googleapis.com" for request in requests))
        self.assertEqual(parse_qs(urlsplit(requests[1].full_url).query)["pageToken"], ["page-two"])
        self.assertNotIn("webContentLink", candidates[0])

    def test_inventory_requires_complete_pages_and_rejects_duplicates_and_cycles(self):
        for pages in (
            [{"files": [folder()], "incompleteSearch": True}],
            [{"files": [folder()], "nextPageToken": "repeat"}, {"files": [], "nextPageToken": "repeat"}],
            [{"files": [folder(), folder()]}],
            [{"files": [folder(), folder("a", "b"), folder("b", "a")]}],
        ):
            with self.subTest(pages=pages):
                self.opener.open.side_effect = [response(page) for page in pages]
                with self.assertRaises(original_drive.OriginalDriveError):
                    self.client.list_inventory()

    def test_unlisted_shared_root_is_explicitly_verified(self):
        self.opener.open.side_effect = [response({"files": [jpg()]}), response(folder())]
        self.assertEqual(len(self.client.list_inventory()), 2)
        with self.assertRaises(original_drive.OriginalDriveError):
            original_drive.project_archive([jpg()], "root")

    def test_projection_excludes_inaccessible_outside_ancestors_and_trashed_folders(self):
        files = [folder(), jpg(), jpg("outside", "unknown"), folder("trash", "root", trashed=True), jpg("trashed-child", "trash")]
        self.assertEqual([item["id"] for item in original_drive.project_archive(files, "root")], ["jpg"])
        with self.assertRaises(original_drive.OriginalDriveError):
            original_drive.project_archive([folder(), jpg(), jpg("invalid-child", "jpg")], "root")

    def test_download_checks_capability_live_root_size_and_checksum_using_only_get(self):
        self.opener.open.side_effect = [response(jpg(parent="shoot")), response(folder("shoot", "root")), response(folder()), response(b"jpeg")]
        # This is the worker's 100 MiB source budget, including the exact cap.
        self.assertEqual(self.client.download("jpg", 100 * 1024 * 1024, expected_md5=hashlib.md5(b"jpeg").hexdigest()), b"jpeg")
        self.assertTrue(all(call.args[0].get_method() == "GET" for call in self.opener.open.call_args_list))
        self.assertEqual(parse_qs(urlsplit(self.opener.open.call_args.args[0].full_url).query)["alt"], ["media"])

    def test_download_fails_before_content_for_outside_source_or_changed_checksum(self):
        for metadata, parents in (
            (jpg(parent="outside"), [folder("outside")]),
            (jpg(capabilities={"canDownload": False}), []),
            (jpg(size="999"), []),
            (jpg(md5Checksum="a" * 32), []),
            (jpg(mimeType=original_drive.SHORTCUT_MIME_TYPE), []),
        ):
            with self.subTest(metadata=metadata):
                self.opener.open.reset_mock()
                self.opener.open.side_effect = [response(metadata), *[response(parent) for parent in parents]]
                with self.assertRaises(original_drive.OriginalDriveError):
                    self.client.download("jpg", 10, expected_md5=hashlib.md5(b"jpeg").hexdigest())
                self.assertTrue(all("alt=media" not in call.args[0].full_url for call in self.opener.open.call_args_list))

    def test_download_rejects_truncated_oversized_and_corrupted_content(self):
        for body in (b"jpe", b"wrong", b"jpeg" * 3):
            self.opener.open.side_effect = [response(jpg()), response(folder()), response(body)]
            with self.subTest(body=body), self.assertRaises(original_drive.OriginalDriveError):
                self.client.download("jpg", 10)

    def test_ids_cannot_escape_fixed_urls_and_redirects_are_never_followed(self):
        for file_id in ("../files", "jpg?alt=media", "https://example.test", "x\r\nAuthorization: attacker"):
            with self.subTest(file_id=file_id), self.assertRaises(original_drive.OriginalDriveError):
                self.client.file(file_id)
        self.opener.open.assert_not_called()
        redirect = original_drive._NoRedirectHandler()
        self.assertIsNone(redirect.redirect_request(None, None, 302, "", {}, "https://example.test"))
        self.opener.open.side_effect = HTTPError("https://www.googleapis.com/drive/v3/files/jpg", 302, "secret redirect", {}, None)
        with self.assertRaises(original_drive.OriginalDriveError) as raised:
            self.client.file("jpg")
        self.assertEqual(self.opener.open.call_count, 1)
        self.assertNotIn("secret", str(raised.exception))

    def test_transient_reads_retry_but_exceptions_never_expose_provider_details(self):
        self.opener.open.side_effect = [HTTPError("https://example.test", 503, "secret response", {}, None), response(jpg())]
        with patch.object(original_drive.time, "sleep"):
            self.assertEqual(self.client.file("jpg")["id"], "jpg")
        self.assertEqual(self.opener.open.call_count, 2)
        self.opener.open.side_effect = RuntimeError("secret body and access token")
        with self.assertRaises(original_drive.OriginalDriveError) as raised:
            self.client.file("jpg")
        self.assertNotIn("secret", str(raised.exception))

    def test_metadata_ids_and_numeric_values_are_validated(self):
        for updates in ({"id": "different"}, {"size": True}, {"parents": ["root", "other"]}, {"md5Checksum": "wrong"}, {"version": "-1"}, {"capabilities": {"canDownload": "true"}}):
            self.opener.open.side_effect = [response(jpg(**updates))]
            with self.subTest(updates=updates), self.assertRaises(original_drive.OriginalDriveError):
                self.client.file("jpg")

    def test_changes_return_ordered_updates_removals_and_final_cursor(self):
        self.opener.open.side_effect = [
            response({"startPageToken": "start"}),
            response({"changes": [{"fileId": "jpg", "file": jpg()}], "nextPageToken": "next"}),
            response({"changes": [{"fileId": "gone", "removed": True}], "newStartPageToken": "end"}),
        ]
        self.assertEqual(self.client.start_page_token(), "start")
        changes, token = self.client.changes("start")
        self.assertEqual(token, "end")
        self.assertEqual(changes[0]["file"]["id"], "jpg")
        self.assertEqual(changes[1], {"fileId": "gone", "removed": True})
        self.assertTrue(all(call.args[0].get_method() == "GET" for call in self.opener.open.call_args_list))

    def test_changes_reject_missing_final_cursor_repeated_pages_and_expired_cursor(self):
        cases = [
            [response({"changes": []})],
            [response({"changes": [], "nextPageToken": "start"})],
            [response({"changes": [{"fileId": "different", "file": jpg()}], "newStartPageToken": "end"})],
        ]
        for pages in cases:
            self.opener.open.side_effect = pages
            with self.assertRaises(original_drive.OriginalDriveError):
                self.client.changes("start")
        self.opener.open.side_effect = HTTPError("https://example.test", 410, "secret cursor", {}, None)
        with self.assertRaises(original_drive.DriveCursorExpired):
            self.client.changes("expired")


if __name__ == "__main__":
    unittest.main()
