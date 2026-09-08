"""Safe legacy matching: inventory only; no provider writes in dry run."""
import hashlib
import os
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from ops import migrate_drive_backup_links as migration

KIND = 'kind'
ALBUM_ID = 'albumId'
MEDIA_ID = 'mediaId'
FOLDER = 'application/vnd.google-apps.folder'
ALBUM = {'albumId': 'one', 'title': 'Hike', 'type': 'photo', 'images': [{'rawKey': 'albums/one/photo.jpg'}], 'backupToGoogleDrive': False}


def folder(id, name, properties=None):
    return {'id': id, 'name': name, 'mimeType': FOLDER, 'appProperties': properties or {}}


class DriveLinkInventoryTests(unittest.TestCase):
    def inventory(self, albums=None, tree=None, pages=None, s3=None):
        table = Mock()
        table.scan.side_effect = pages or [{'Items': albums if albums is not None else [ALBUM]}]
        default = {'root': [folder('photos', 'Photos')], 'photos': [folder('album-folder', 'Hike')], 'album-folder': [{'id': 'file', 'name': 'photo.jpg'}]}
        tree = default if tree is None else tree
        provider = SimpleNamespace(APP_KIND_KEY=KIND, APP_ALBUM_ID_KEY=ALBUM_ID, FOLDER_MIME_TYPE=FOLDER)
        modules = {'drive_backup_reconcile': SimpleNamespace(children=lambda _service, id: tree.get(id, []), MEDIA_ID=MEDIA_ID), 'google_drive_sync': provider, 'media_access': SimpleNamespace(media_id_for_key=lambda key: hashlib.sha256(key.encode()).hexdigest())}
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {'IMAGES_BUCKET': 'test-bucket'}), patch.object(migration.boto3, 'client', return_value=s3 or Mock()):
            return migration.inventory(table, Mock(), 'root')

    def test_false_upload_flag_with_existing_folder_is_linked(self):
        links, summary = self.inventory()
        self.assertEqual(summary['linkedBackupCount'], 1)
        self.assertEqual(summary['albumsToLink'], 1)
        self.assertEqual(summary['filesToTag'], 1)
        self.assertEqual(links[0]['folderId'], 'album-folder')

    def test_gallery_only_album_without_folder_is_not_opted_in(self):
        links, summary = self.inventory(tree={'root': [folder('photos', 'Photos')], 'photos': []})
        self.assertEqual(links, [])
        self.assertEqual(summary['albumCount'], 1)

    def test_pagination_active_filter_and_unrelated_roots(self):
        links, summary = self.inventory(pages=[{'Items': [{**ALBUM, 'status': 'deleted'}], 'LastEvaluatedKey': {'albumId': 'cursor'}}, {'Items': [ALBUM]}], tree={'root': [folder('archive', 'Raw Archive'), {'id': 'document', 'name': 'Photos'}]})
        self.assertEqual(summary['albumCount'], 1)
        self.assertEqual(links, [])

    def test_tagged_folder_survives_title_change_and_nested_category(self):
        tree = {'root': [folder('photos', 'Photos')], 'photos': [folder('category', 'Old category', {KIND: 'category'})], 'category': [folder('album-folder', 'Old title', {ALBUM_ID: 'one'})], 'album-folder': [{'id': 'file', 'name': 'photo.jpg'}]}
        links, _ = self.inventory(tree=tree)
        self.assertTrue(links[0]['folderTagged'])

    def test_missing_album_tag_is_archived_instead_of_reassigned_by_title(self):
        links, summary = self.inventory(tree={'root': [folder('photos', 'Photos')], 'photos': [folder('archive', 'Hike', {ALBUM_ID: 'deleted-album'})]})
        self.assertEqual(links, [])
        self.assertEqual(summary['retainedArchiveCount'], 1)

    def test_ambiguous_untagged_folder_and_duplicate_album_id_fail_closed(self):
        with self.assertRaises(RuntimeError): self.inventory(albums=[ALBUM, {**ALBUM, 'albumId': 'two'}])
        with self.assertRaises(RuntimeError): self.inventory(tree={'root': [folder('photos', 'Photos')], 'photos': [folder('a', 'Hike', {ALBUM_ID: 'one'}), folder('b', 'Hike', {ALBUM_ID: 'one'})]})

    def test_wrong_type_and_conflicting_file_identity_fail_closed(self):
        with self.assertRaises(RuntimeError): self.inventory(tree={'root': [folder('videos', 'Videos')], 'videos': [folder('a', 'Hike', {ALBUM_ID: 'one'})]})
        with self.assertRaises(RuntimeError): self.inventory(tree={'root': [folder('photos', 'Photos')], 'photos': [folder('album-folder', 'Hike')], 'album-folder': [{'id': 'file', 'name': 'photo.jpg', 'appProperties': {ALBUM_ID: 'someone-else'}}]})

    def test_existing_tags_and_link_make_second_pass_noop(self):
        media_id = hashlib.sha256(b'albums/one/photo.jpg').hexdigest()
        tree = {'root': [folder('photos', 'Photos')], 'photos': [folder('album-folder', 'Renamed', {ALBUM_ID: 'one'})], 'album-folder': [{'id': 'file', 'name': 'photo.jpg', 'appProperties': {ALBUM_ID: 'one', MEDIA_ID: media_id}}]}
        _, summary = self.inventory(albums=[{**ALBUM, 'driveFolderId': 'album-folder'}], tree=tree)
        self.assertEqual(summary['albumsToLink'], 0)
        self.assertEqual(summary['filesToTag'], 0)

    def test_duplicate_files_require_matching_source_bytes_and_preserve_extras(self):
        s3 = Mock(); s3.head_object.return_value = {'ETag': '"checksum"', 'ContentLength': 3}
        tree = {'root': [folder('photos', 'Photos')], 'photos': [folder('album-folder', 'Hike')], 'album-folder': [{'id': 'a', 'name': 'photo.jpg', 'md5Checksum': 'checksum', 'size': '3'}, {'id': 'b', 'name': 'photo.jpg', 'md5Checksum': 'checksum', 'size': '3'}, {'id': 'manual', 'name': 'photo.jpg', 'md5Checksum': 'different', 'size': '3'}]}
        links, summary = self.inventory(tree=tree, s3=s3)
        self.assertEqual(summary['filesMatched'], 2)
        self.assertEqual([item['fileId'] for item in links[0]['media']], ['a', 'b'])
        s3.head_object.return_value = {'ETag': '"no-match"', 'ContentLength': 3}
        with self.assertRaises(RuntimeError): self.inventory(tree=tree, s3=s3)

    def test_duplicate_manifest_entries_do_not_create_ambiguous_mapping(self):
        links, summary = self.inventory(albums=[{**ALBUM, 'images': ALBUM['images'] * 2}])
        self.assertEqual(summary['filesMatched'], 1)
        self.assertEqual(len(links[0]['media']), 1)

    def test_two_different_keys_with_same_name_fail_closed(self):
        with self.assertRaises(RuntimeError): self.inventory(albums=[{**ALBUM, 'images': [{'rawKey': 'albums/one/a/photo.jpg'}, {'rawKey': 'albums/one/b/photo.jpg'}]}])

    def test_missing_current_file_and_extra_file_are_not_deleted(self):
        links, summary = self.inventory(tree={'root': [folder('photos', 'Photos')], 'photos': [folder('album-folder', 'Hike')], 'album-folder': [{'id': 'manual', 'name': 'keep.jpg'}]})
        self.assertEqual(summary['filesMatched'], 0)
        self.assertEqual(len(links), 1)
