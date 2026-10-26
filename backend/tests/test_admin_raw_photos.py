import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from test_support import claims, response_body

import admin_raw_photos
import original_drive


FOLDER = original_drive.FOLDER_MIME_TYPE
THUMB = "https://lh3.googleusercontent.com/drive-storage/AJQWtBexample-token_1=s220"


def admin_event(folder=None, groups=("Admins",)):
    event = {"requestContext": {"authorizer": {"jwt": {"claims": claims(groups=list(groups))}}}, "headers": {}}
    if folder is not None:
        event["queryStringParameters"] = {"folder": folder}
    return event


def child(file_id, name, mime="image/jpeg", thumbnail=THUMB, **metadata):
    item = {"id": file_id, "name": name, "mimeType": mime}
    if thumbnail:
        item["thumbnailLink"] = thumbnail
    if metadata:
        item["imageMediaMetadata"] = metadata
    return item


def folder(file_id, name):
    return {"id": file_id, "name": name, "mimeType": FOLDER}


class FakeDrive:
    root_id = "root"

    def __init__(self, listings, paths=None):
        self.listings = listings
        self.paths = paths or {}
        self.known_arguments = []

    def folder_path(self, folder_id, known=None):
        self.known_arguments.append(dict(known or {}))
        if folder_id not in self.paths:
            raise original_drive.DriveItemNotFound("outside")
        return self.paths[folder_id]

    def list_folder(self, folder_id):
        return self.listings[folder_id]


ROOT_PATH = [{"id": "root", "name": "Raw Photo Backup"}]
ALBUM_PATH = [*ROOT_PATH, {"id": "2026", "name": "2026"}, {"id": "hikes", "name": "Hikes"}, {"id": "album", "name": "Lake Hike 8-10"}]


class BrowseTests(unittest.TestCase):
    def setUp(self):
        admin_raw_photos._path_cache.clear()

    def test_album_folders_show_only_jpegs_and_hide_raw_and_video_folders(self):
        drive = FakeDrive({
            "album": ([folder("jpeg", "JPEG"), folder("raw", "RAW"), folder("vid", "VID"), folder("extra", "Edits"), child("clip", "MVI_1.MP4", "video/mp4")], False),
            "jpeg": ([child("a", "4K1A0001.JPG", width=4800, height=3200, rotation=0, time="2026:08:10 10:00:00"),
                      child("b", "4K1A0002.JPG", width=4800, height=3200, rotation=3)], False),
        }, {"album": ALBUM_PATH})
        result = admin_raw_photos.browse(drive, "album", 100)
        self.assertTrue(result["album"])
        self.assertFalse(result["isRoot"])
        self.assertEqual(result["folder"], {"id": "album", "name": "Lake Hike 8-10"})
        self.assertEqual(result["folders"], [{"id": "extra", "name": "Edits"}])
        self.assertEqual([photo["id"] for photo in result["photos"]], ["a", "b"])
        self.assertEqual(result["photos"][0], {
            "id": "a", "name": "4K1A0001.JPG", "thumbnail": "https://lh3.googleusercontent.com/drive-storage/AJQWtBexample-token_1",
            "width": 4800, "height": 3200, "capturedAt": "2026:08:10 10:00:00",
        })
        # Rotated portrait frames report sensor dimensions; swap them.
        self.assertEqual((result["photos"][1]["width"], result["photos"][1]["height"]), (3200, 4800))
        self.assertNotIn("capturedAt", result["photos"][1])
        # Child folder paths are remembered for the next navigation.
        self.assertEqual(admin_raw_photos._path_cache["extra"][1][-1], {"id": "extra", "name": "Edits"})

    def test_empty_jpeg_folder_keeps_every_subfolder_reachable(self):
        drive = FakeDrive({
            "album": ([folder("jpeg", "jpeg"), folder("raw", "RAW")], False),
            "jpeg": ([], False),
        }, {"album": ALBUM_PATH})
        result = admin_raw_photos.browse(drive, "album", 100)
        self.assertFalse(result["album"])
        self.assertEqual([entry["name"] for entry in result["folders"]], ["jpeg", "RAW"])
        self.assertEqual(result["photos"], [])

    def test_loose_mixed_folders_skip_raws_with_jpgs_and_keep_raw_only_previews(self):
        drive = FakeDrive({"root": ([
            folder("year", "2025"),
            child("j1", "IMG_0001.JPG"), child("r1", "IMG_0001.CR2", "image/x-canon-cr2"),
            child("r2", "IMG_0002.CR3", "application/octet-stream"),
            child("h1", "IMG_0003.HIF", "image/heif"),
            child("doc", "notes.txt", "text/plain"),
            child("noext", "README", "application/octet-stream"),
            child("nothumb", "IMG_0004.JPG", thumbnail=None),
            child("badthumb", "IMG_0005.JPG", thumbnail="https://evil.example/x=s220"),
            child("baddims", "IMG_0006.JPG", width=True, height=0),
        ], True)}, {"root": ROOT_PATH})
        result = admin_raw_photos.browse(drive, None, 100)
        self.assertTrue(result["isRoot"])
        self.assertTrue(result["truncated"])
        self.assertFalse(result["album"])
        self.assertEqual([photo["id"] for photo in result["photos"]], ["j1", "r2", "h1", "baddims"])
        self.assertNotIn("width", result["photos"][-1])
        self.assertEqual(result["folders"], [{"id": "year", "name": "2025"}])

    def test_thumbnail_bases_are_normalized_google_image_urls_only(self):
        base = admin_raw_photos._thumbnail_base
        self.assertEqual(base("https://lh5.googleusercontent.com/drive-storage/abc=s220"), "https://lh3.googleusercontent.com/drive-storage/abc")
        self.assertEqual(base("https://lh3.googleusercontent.com/drive-storage/abc"), "https://lh3.googleusercontent.com/drive-storage/abc")
        for link in (
            None, 12, "", "http://lh3.googleusercontent.com/a=s220", "https://lh3.googleusercontent.com.evil.test/a",
            "https://lh3.googleusercontent.com/a?x=1", "https://lh3.googleusercontent.com/a#x", "https://lh3.googleusercontent.com/a,b",
            "https://lh3.googleusercontent.com:8443/a", "https://lh3.googleusercontent.com:bad/a", "https://user@lh3.googleusercontent.com/a",
            "https://lh3.googleusercontent.com/=s220", "https://lh3.googleusercontent.com/" + "a" * 2100,
        ):
            with self.subTest(link=link):
                self.assertIsNone(base(link))

    def test_verified_paths_are_cached_until_expiry_and_bounded(self):
        drive = FakeDrive({"root": ([folder("year", "2026")], False), "year": ([], False)},
                          {"root": ROOT_PATH, "year": [*ROOT_PATH, {"id": "year", "name": "2026"}]})
        admin_raw_photos.browse(drive, "root", 100)
        admin_raw_photos.browse(drive, "year", 200)
        self.assertIn("year", drive.known_arguments[1])
        admin_raw_photos.browse(drive, "year", 100 + admin_raw_photos.PATH_CACHE_SECONDS + 1)
        self.assertNotIn("root", drive.known_arguments[2])
        with patch.object(admin_raw_photos, "PATH_CACHE_LIMIT", 1):
            admin_raw_photos._remember_path("other", ROOT_PATH, 1)
            self.assertEqual(list(admin_raw_photos._path_cache), ["other"])


class HandlerTests(unittest.TestCase):
    def setUp(self):
        admin_raw_photos._path_cache.clear()
        self.drive = FakeDrive({"root": ([folder("year", "2026")], False)}, {"root": ROOT_PATH})
        self.enterContext(patch.object(admin_raw_photos, "_drive", self.drive))

    def test_front_door_and_admin_checks_run_before_drive_access(self):
        denied = {"statusCode": 403}
        with patch.object(admin_raw_photos, "verify_front_door_request", return_value=denied), \
                patch.object(admin_raw_photos, "browse") as browse:
            self.assertIs(admin_raw_photos.handler(admin_event(), None), denied)
        browse.assert_not_called()
        with patch.object(admin_raw_photos, "browse") as browse:
            response = admin_raw_photos.handler(admin_event(groups=()), None)
        self.assertIn(response["statusCode"], {401, 403})
        browse.assert_not_called()

    def test_lists_root_without_a_folder_and_audits_the_view(self):
        with patch.object(admin_raw_photos, "emit_audit_event") as audit:
            response = admin_raw_photos.handler(admin_event(), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        body = response_body(response)
        self.assertEqual(body["path"], ROOT_PATH)
        self.assertEqual(body["folders"], [{"id": "year", "name": "2026"}])
        self.assertEqual(audit.call_args.kwargs["action"], "provider.raw_photos.view")
        self.assertEqual(audit.call_args.kwargs["details"], {"media_count": 0})

    def test_invalid_outside_and_failed_folders_fail_closed_without_details(self):
        for value in ("../root", "a b", "x" * 300, ["root"]):
            with self.subTest(value=value):
                response = admin_raw_photos.handler(admin_event(value), None)
                self.assertEqual(response["statusCode"], 400)
        self.assertEqual(admin_raw_photos.handler(admin_event("outside"), None)["statusCode"], 404)
        self.assertEqual(admin_raw_photos.handler(admin_event(""), None)["statusCode"], 200)
        with patch.object(admin_raw_photos, "browse", side_effect=original_drive.OriginalDriveError("secret provider detail")), \
                patch.object(admin_raw_photos, "emit_audit_event") as audit, \
                self.assertLogs("photography_api.raw_photos", level="ERROR") as logs:
            response = admin_raw_photos.handler(admin_event(), SimpleNamespace(aws_request_id="request-1"))
        self.assertEqual(response["statusCode"], 503)
        self.assertNotIn("secret", response["body"] + "\n".join(logs.output))
        self.assertEqual(audit.call_args.kwargs["outcome"], "failure")

    def test_drive_client_is_created_once_from_read_only_environment(self):
        with patch.object(admin_raw_photos, "_drive", None), \
                patch.object(admin_raw_photos.OriginalDrive, "from_environment", return_value=self.drive) as create:
            self.assertIs(admin_raw_photos._client(), self.drive)
            self.assertIs(admin_raw_photos._client(), self.drive)
        create.assert_called_once_with()


def response(document):
    value = io.BytesIO(json.dumps(document).encode())
    value.status = 200
    return value


def metadata(file_id, parent=None, mime=FOLDER, **updates):
    return {"id": file_id, "name": file_id, "mimeType": mime, "parents": [parent] if parent else [], **updates}


class OriginalDriveFolderTests(unittest.TestCase):
    def setUp(self):
        self.opener = Mock()
        self.client = original_drive.OriginalDrive(SimpleNamespace(valid=True, token="token"), "root", opener=self.opener)

    def test_folder_path_walks_to_root_or_uses_known_paths(self):
        self.opener.open.side_effect = [response(metadata("album", "hikes")), response(metadata("hikes", "root")), response(metadata("root"))]
        self.assertEqual([entry["id"] for entry in self.client.folder_path("album")], ["root", "hikes", "album"])
        self.opener.open.side_effect = [response(metadata("album", "hikes"))]
        known = {"hikes": [{"id": "root", "name": "root"}, {"id": "hikes", "name": "hikes"}]}
        self.assertEqual([entry["id"] for entry in self.client.folder_path("album", known)], ["root", "hikes", "album"])
        self.opener.open.side_effect = []
        self.assertEqual(self.client.folder_path("hikes", known), known["hikes"])

    def test_folder_path_rejects_files_trash_outside_cycles_and_depth(self):
        cases = (
            [metadata("photo", "root", "image/jpeg")],
            [metadata("trash", "root", trashed=True)],
            [metadata("outside")],
            [metadata("a", "b"), metadata("b", "a")],
        )
        for pages in cases:
            with self.subTest(pages=pages):
                self.opener.open.side_effect = [response(page) for page in pages]
                with self.assertRaises(original_drive.DriveItemNotFound):
                    self.client.folder_path(pages[0]["id"])
        self.opener.open.side_effect = [response(metadata(f"f{index}", f"f{index + 1}")) for index in range(64)]
        with self.assertRaises(original_drive.DriveItemNotFound):
            self.client.folder_path("f0")

    def test_missing_items_raise_not_found_and_other_errors_stay_generic(self):
        self.opener.open.side_effect = HTTPError("https://www.googleapis.com/drive/v3/files/x", 404, "missing", {}, None)
        with self.assertRaises(original_drive.DriveItemNotFound):
            self.client.file("x")
        self.opener.open.side_effect = HTTPError("https://www.googleapis.com/drive/v3/files", 404, "missing", {}, None)
        with self.assertRaises(original_drive.OriginalDriveError) as raised:
            self.client.list_folder("x")
        self.assertNotIsInstance(raised.exception, original_drive.DriveItemNotFound)

    def test_list_folder_pages_in_name_order_with_get_only_requests(self):
        first = {"id": "a", "name": "A.JPG", "mimeType": "image/jpeg", "thumbnailLink": THUMB, "imageMediaMetadata": {"width": 1}}
        self.opener.open.side_effect = [
            response({"files": [first], "nextPageToken": "next", "incompleteSearch": False}),
            response({"files": [{"id": "b", "name": "B", "mimeType": FOLDER, "thumbnailLink": 5}]}),
        ]
        items, truncated = self.client.list_folder("album")
        self.assertFalse(truncated)
        self.assertEqual(items, [first, {"id": "b", "name": "B", "mimeType": FOLDER}])
        requests = [call.args[0] for call in self.opener.open.call_args_list]
        self.assertTrue(all(request.get_method() == "GET" and request.data is None for request in requests))
        query = parse_qs(urlsplit(requests[0].full_url).query)
        self.assertEqual(query["q"], ["'album' in parents and trashed=false"])
        self.assertEqual(query["orderBy"], ["folder,name_natural"])
        self.assertEqual(parse_qs(urlsplit(requests[1].full_url).query)["pageToken"], ["next"])

    def test_list_folder_truncates_at_limit_and_rejects_bad_pages(self):
        self.opener.open.side_effect = [response({"files": [], "nextPageToken": "next"})]
        self.assertEqual(self.client.list_folder("album", maximum_items=1000), ([], True))
        for pages in (
            [{"files": [], "incompleteSearch": True}],
            [{"files": "bad"}],
            [{"files": ["bad"]}],
            [{"files": [{"id": "a", "name": "a", "mimeType": FOLDER}, {"id": "a", "name": "a", "mimeType": FOLDER}]}],
            [{"files": [], "nextPageToken": "same"}, {"files": [], "nextPageToken": "same"}],
        ):
            with self.subTest(pages=pages):
                self.opener.open.side_effect = [response(page) for page in pages]
                with self.assertRaises(original_drive.OriginalDriveError):
                    self.client.list_folder("album")
        with self.assertRaises(original_drive.OriginalDriveError):
            self.client.list_folder("../album")


if __name__ == "__main__":
    unittest.main()
