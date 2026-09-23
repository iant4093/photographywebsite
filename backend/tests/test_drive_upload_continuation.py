"""Real Drive SDK resumable requests with synthetic transports and storage."""
import json
import os
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import test_support
import boto3
import httplib2
from googleapiclient.http import HttpRequest
import drive_backup_jobs as jobs
import drive_backup_reconcile as worker
import test_publication_recovery as fixture
from test_publication_recovery import ALBUM, RAW, RECORD

URI = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic'


class DriveContinuationTests(unittest.TestCase):
    setUp = fixture.PublicationRecoveryTests.setUp
    put = fixture.PublicationRecoveryTests.put
    album = fixture.PublicationRecoveryTests.album

    def backup_state(self):
        state = boto3.resource('dynamodb', region_name='us-west-2').create_table(TableName='drive-state',
            KeySchema=[{'AttributeName': 'albumId', 'KeyType': 'HASH'}, {'AttributeName': 'entry', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'albumId', 'AttributeType': 'S'}, {'AttributeName': 'entry', 'AttributeType': 'S'}], BillingMode='PAY_PER_REQUEST')
        self.stack.enter_context(patch.dict(os.environ, {'DRIVE_BACKUP_STATE_TABLE': 'drive-state'}))
        self.stack.enter_context(patch.object(worker.provider, 'table', self.table))
        return state

    def upload_setup(self):
        state = self.backup_state()
        album = {**RECORD, 'backupToGoogleDrive': True}
        self.put(album)
        s3 = Mock(); s3.head_object.return_value = {'ContentLength': 6, 'ETag': 'etag', 'VersionId': 'version', 'ContentType': 'image/jpeg'}
        s3.download_file.side_effect = lambda bucket, key, path: Path(path).write_bytes(b'abcdef')
        self.stack.enter_context(patch.object(worker.provider, 's3', s3))
        service = Mock()
        http = Mock()
        service.files().create.side_effect = lambda **args: HttpRequest(http, lambda response, body: json.loads(body),
            uri='https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', method='POST', body='{}', resumable=args['media_body'])
        return state, album, s3, service, http

    def receipt(self, state):
        return state.get_item(Key={'albumId': ALBUM, 'entry': 'upload#' + worker.media_id_for_key(RAW)}, ConsistentRead=True).get('Item', {})

    def test_upload_resumes_from_provider_offset_after_time_budget_without_new_upload_session(self):
        state, album, s3, service, http = self.upload_setup()
        http.request.side_effect = [(httplib2.Response({'status': '200', 'location': URI}), b''),
                                    (httplib2.Response({'status': '308', 'range': 'bytes=0-2'}), b'')]
        context = Mock(); context.get_remaining_time_in_millis.side_effect = [90000, 50000]
        with self.assertRaises(worker.BackupContinuation): worker.upload(service, album, RAW, 'folder', context)
        self.assertEqual(self.receipt(state)['uploadUri'], URI)
        first_path = s3.download_file.call_args.args[2]
        self.assertFalse(Path(first_path).exists())
        http.reset_mock()
        http.request.side_effect = [(httplib2.Response({'status': '308', 'range': 'bytes=0-2'}), b''),
                                    (httplib2.Response({'status': '200'}), b'{"id":"file"}')]
        self.assertEqual(worker.upload(service, album, RAW, 'folder', None), 'file')
        self.assertEqual(http.request.call_count, 2)
        status_call, bytes_call = http.request.call_args_list
        self.assertEqual(status_call.args, (URI, 'PUT'))
        self.assertEqual(status_call.kwargs['headers']['Content-Range'], 'bytes */6')
        self.assertEqual(bytes_call.args[0], URI)
        self.assertEqual(bytes_call.kwargs['headers']['Content-Range'], 'bytes 3-5/6')
        self.assertNotIn('uploadUri', self.receipt(state))
        self.assertFalse(Path(s3.download_file.call_args.args[2]).exists())

    def test_lost_final_reply_asks_provider_status_and_does_not_upload_bytes_twice(self):
        state, album, _, service, http = self.upload_setup()
        state.put_item(Item={'albumId': ALBUM, 'entry': 'upload#' + worker.media_id_for_key(RAW), 'uploadUri': URI,
            'folderId': 'folder', 'source': {'ContentLength': 6, 'ETag': 'etag', 'VersionId': 'version'}, 'expiresAt': int(time.time()) + 1000})
        http.request.return_value = (httplib2.Response({'status': '200'}), b'{"id":"already-complete"}')
        self.assertEqual(worker.upload(service, album, RAW, 'folder', None), 'already-complete')
        http.request.assert_called_once()
        self.assertEqual(http.request.call_args.kwargs['headers']['Content-Range'], 'bytes */6')

    def test_expired_provider_session_is_cleared_and_deferred_for_fresh_inventory_check(self):
        state, album, _, service, http = self.upload_setup()
        state.put_item(Item={'albumId': ALBUM, 'entry': 'upload#' + worker.media_id_for_key(RAW), 'uploadUri': URI,
            'folderId': 'folder', 'source': {'ContentLength': 6, 'ETag': 'etag', 'VersionId': 'version'}, 'expiresAt': int(time.time()) + 1000})
        http.request.return_value = (httplib2.Response({'status': '404'}), b'{}')
        with self.assertRaises(worker.BackupContinuation): worker.upload(service, album, RAW, 'folder', None)
        self.assertNotIn('uploadUri', self.receipt(state))

    def test_source_changed_during_download_never_appends_to_previous_upload(self):
        state, album, s3, service, http = self.upload_setup()
        s3.head_object.side_effect = [{'ContentLength': 6, 'ETag': 'old'}, {'ContentLength': 6, 'ETag': 'new'}]
        with self.assertRaises(worker.BackupContinuation): worker.upload(service, album, RAW, 'folder', None)
        http.request.assert_not_called()
        self.assertEqual(self.receipt(state), {})

    def test_untrusted_resumable_endpoint_is_rejected_without_sending_credentials(self):
        for uri in ('http://www.googleapis.com/upload/drive/v3/files', 'https://example.test/upload/drive/', 'https://www.googleapis.com:444/upload/drive/', 'https://name:secret@www.googleapis.com/upload/drive/', 'https://www.googleapis.com/elsewhere'):
            with self.subTest(uri=uri), self.assertRaises(RuntimeError): worker._upload_uri(uri)
        self.assertIsNone(worker._upload_uri(None))
        self.assertIsNone(worker._upload_uri('x' * 9000))

    def test_album_budget_defers_original_intent_and_count_then_completes_on_next_delivery(self):
        state = self.backup_state()
        self.put({**RECORD, 'backupToGoogleDrive': True})
        entry = 'job#' + 'a' * 32
        removed = RAW.replace('photo.jpg', 'removed.jpg')
        job = {'albumId': ALBUM, 'entry': entry, 'status': 'pending', 'createdAt': int(time.time()), 'removedKeys': [removed]}
        state.put_item(Item=job); state.put_item(Item={'albumId': ALBUM, 'entry': 'state', 'pendingJobs': 1})
        service = Mock()
        files = [{'id': 'uploaded', 'appProperties': {worker.provider.APP_ALBUM_ID_KEY: ALBUM, worker.MEDIA_ID: worker.media_id_for_key(RAW)}},
                 {'id': 'removed', 'appProperties': {worker.provider.APP_ALBUM_ID_KEY: ALBUM, worker.MEDIA_ID: worker.media_id_for_key(removed)}}]
        with patch.object(worker.provider, 'get_drive_service', return_value=service), patch.object(worker, 'album_folder', return_value='folder'), patch.object(worker, 'children', return_value=files), patch.object(worker, 'upload') as upload, patch('cache_invalidation._queue_client', self.queue):
            worker.process(ALBUM, entry, SimpleNamespace(get_remaining_time_in_millis=lambda: 59000))
            waiting = state.get_item(Key={'albumId': ALBUM, 'entry': entry})['Item']
            self.assertEqual(waiting['status'], 'pending')
            self.assertEqual(waiting['removedKeys'], [removed])
            self.assertIn('deferredUntil', waiting)
            self.assertEqual(state.get_item(Key={'albumId': ALBUM, 'entry': 'state'})['Item']['pendingJobs'], 1)
            self.queue.return_value.send_message.assert_called_once()
            worker.process(ALBUM, entry)
        upload.assert_not_called()
        service.files().update.assert_called_once_with(fileId='removed', body={'trashed': True}, fields='id', supportsAllDrives=True)
        self.assertEqual(state.get_item(Key={'albumId': ALBUM, 'entry': 'state'})['Item']['pendingJobs'], 0)
        self.assertEqual(state.get_item(Key={'albumId': ALBUM, 'entry': entry})['Item']['status'], 'done')
