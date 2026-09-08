import os
import unittest
from unittest.mock import Mock, patch

from test_support import DEFAULT_ENV
from botocore.exceptions import ClientError
from boto3.dynamodb.types import TypeDeserializer
import drive_backup_jobs as jobs
import drive_backup_reconcile as worker
import admin_drive_backups as api

ALBUM = {'albumId': '11111111-1111-4111-8111-111111111111', 'title': 'Hike', 'category': 'Hikes', 'type': 'photo', 'status': 'active', 'driveFolderId': 'folder', 'backupToGoogleDrive': False}
RAW = 'albums/' + ALBUM['albumId'] + '/original/photo.jpg'
JOB = {'albumId': ALBUM['albumId'], 'entry': 'job#one', 'status': 'pending', 'removedKeys': [RAW]}


def decode(value):
    return {key: TypeDeserializer().deserialize(item) for key, item in value.items()}


def conditional(code='ConditionalCheckFailedException'):
    return ClientError({'Error': {'Code': code}}, 'Test')


class DurableJobsTests(unittest.TestCase):
    def test_gallery_only_uses_normal_commit_and_never_creates_intent(self):
        table = Mock()
        with patch.object(jobs, 'state_table', return_value=Mock()), patch.object(jobs, 'transaction') as transact:
            jobs.update_album(table, {**ALBUM, 'driveFolderId': ''}, Key={'albumId': ALBUM['albumId']})
        table.update_item.assert_called_once()
        transact.assert_not_called()

    def test_false_flag_with_confirmed_backup_commits_media_removal_and_intent_atomically(self):
        table = Mock(name='albums')
        table.name = 'albums'
        state = Mock(); state.name = 'backup-state'
        table.get_item.return_value = {'Item': ALBUM}
        with patch.object(jobs, 'state_table', return_value=state), patch.object(jobs, 'transaction') as transact:
            result = jobs.update_album(table, ALBUM, removed_keys=[RAW], Key={'albumId': ALBUM['albumId']}, UpdateExpression='SET title = :title', ConditionExpression='attribute_exists(albumId)', ExpressionAttributeValues={':title': 'New'}, ReturnValues='ALL_NEW')
        request = transact.call_args.args[0]
        self.assertEqual(len(request), 3)
        self.assertEqual(decode(request[1]['Put']['Item'])['removedKeys'], [RAW])
        self.assertIn('retained', request[2]['Update']['ConditionExpression'])
        self.assertEqual(result['Attributes'], ALBUM)
        table.update_item.assert_not_called()

    def test_transaction_conflict_is_retryable_without_separate_album_write(self):
        table = Mock(); table.name = 'albums'
        state = Mock(); state.name = 'state'
        with patch.object(jobs, 'state_table', return_value=state), patch.object(jobs, 'transaction', side_effect=conditional('TransactionCanceledException')):
            with self.assertRaises(jobs.DriveBackupBusy):
                jobs.update_album(table, ALBUM, Key={'albumId': ALBUM['albumId']}, UpdateExpression='SET title = :v', ExpressionAttributeValues={':v': 'New'})
        table.update_item.assert_not_called()

    def test_retry_keeps_failed_removal_intent_and_does_not_increment_job_count(self):
        state = Mock()
        state.query.return_value = {'Items': [JOB, {**JOB, 'entry': 'job#done', 'status': 'done'}]}
        with patch.object(jobs, 'state_table', return_value=state), patch.object(jobs, 'transaction') as transact:
            self.assertTrue(jobs.enqueue_retry(ALBUM))
        delivery = state.put_item.call_args.kwargs['Item']
        self.assertEqual(delivery['jobEntry'], JOB['entry'])
        self.assertEqual(delivery['recordType'], 'delivery')
        transact.assert_not_called()

    def test_fresh_retry_checks_album_still_exists_in_transaction(self):
        state = Mock(); state.name = 'state'; state.query.return_value = {'Items': []}
        with patch.object(jobs, 'state_table', return_value=state), patch.object(jobs, 'transaction') as transact:
            jobs.enqueue_retry(ALBUM)
        self.assertIn('ConditionCheck', transact.call_args.args[0][0])

    def test_retention_waits_for_inflight_worker_and_can_resume_failed_deletion(self):
        state = Mock(); state.update_item.side_effect = conditional()
        with patch.object(jobs, 'state_table', return_value=state):
            with self.assertRaises(jobs.DriveBackupBusy): jobs.begin_retention(ALBUM)
            state.update_item.side_effect = None
            self.assertTrue(jobs.begin_retention(ALBUM))
            jobs.end_retention(ALBUM['albumId'], False)
            self.assertEqual(state.update_item.call_args.kwargs['UpdateExpression'], 'REMOVE retiring')
            jobs.end_retention(ALBUM['albumId'], True)
            self.assertIn('retained = :yes', state.update_item.call_args.kwargs['UpdateExpression'])

    def test_completion_updates_counter_and_job_in_one_transaction(self):
        state = Mock(); state.name = 'state'; state.get_item.return_value = {'Item': {'pendingJobs': 2}}
        with patch.object(jobs, 'state_table', return_value=state), patch.object(jobs, 'transaction') as transact:
            jobs.complete(JOB)
        request = transact.call_args.args[0]
        self.assertEqual(decode(request[1]['Update']['ExpressionAttributeValues'])[':remaining'], 1)
        self.assertEqual(decode(request[1]['Update']['ExpressionAttributeValues'])[':status'], 'queued')
        self.assertIn('#status <> :done', request[0]['Update']['ConditionExpression'])

    def test_claim_and_release_require_lease_identity(self):
        state = Mock()
        with patch.object(jobs, 'state_table', return_value=state):
            self.assertTrue(jobs.claim(ALBUM['albumId'], 'owner'))
            self.assertIn('retiring', state.update_item.call_args.kwargs['ConditionExpression'])
            jobs.release(ALBUM['albumId'], 'owner')
            self.assertEqual(state.update_item.call_args.kwargs['ConditionExpression'], 'leaseOwner = :owner')
            state.update_item.side_effect = conditional()
            self.assertFalse(jobs.claim(ALBUM['albumId'], 'another'))
            jobs.release(ALBUM['albumId'], 'another')


class WorkerTests(unittest.TestCase):
    def test_album_deletion_never_contacts_drive(self):
        with patch.object(worker, 'live_album', return_value=None), patch.object(worker.provider, 'get_drive_service') as service:
            self.assertTrue(worker.reconcile(JOB))
        service.assert_not_called()

    def test_removes_only_explicitly_removed_tagged_media_and_keeps_manual_files(self):
        album = {**ALBUM, 'images': []}
        service = Mock()
        media_id = worker.media_id_for_key(RAW)
        files = [{'id': 'target', 'appProperties': {worker.MEDIA_ID: media_id, worker.provider.APP_ALBUM_ID_KEY: ALBUM['albumId']}}, {'id': 'manual', 'name': 'extra.jpg'}]
        with patch.object(worker, 'live_album', return_value=album), patch.object(worker.provider, 'get_drive_service', return_value=service), patch.object(worker, 'album_folder', return_value='folder'), patch.object(worker, 'children', return_value=files):
            self.assertFalse(worker.reconcile(JOB))
        service.files().update.assert_called_once_with(fileId='target', body={'trashed': True}, fields='id', supportsAllDrives=True)

    def test_stale_remove_does_not_trash_readded_item_or_reupload_backed_file(self):
        album = {**ALBUM, 'images': [{'rawKey': RAW}]}
        service = Mock()
        files = [{'id': 'target', 'appProperties': {worker.MEDIA_ID: worker.media_id_for_key(RAW), worker.provider.APP_ALBUM_ID_KEY: ALBUM['albumId']}}]
        with patch.object(worker, 'live_album', return_value=album), patch.object(worker.provider, 'get_drive_service', return_value=service), patch.object(worker, 'album_folder', return_value='folder'), patch.object(worker, 'children', return_value=files), patch.object(jobs, 'state_table', return_value=Mock()), patch.object(worker, 'upload') as upload:
            worker.reconcile(JOB)
        upload.assert_not_called()
        service.files().update.assert_not_called()

    def test_new_original_uploads_for_confirmed_backup_even_with_false_flag(self):
        album = {**ALBUM, 'images': [{'rawKey': RAW}]}
        state = Mock()
        with patch.object(worker, 'live_album', return_value=album), patch.object(worker.provider, 'get_drive_service', return_value=Mock()), patch.object(worker, 'album_folder', return_value='folder'), patch.object(worker, 'children', return_value=[]), patch.object(jobs, 'state_table', return_value=state), patch.object(worker, 'upload', return_value='new-file') as upload:
            worker.reconcile({**JOB, 'removedKeys': []})
        self.assertEqual(upload.call_count, 1)
        self.assertEqual(state.put_item.call_args.kwargs['Item']['fileId'], 'new-file')

    def test_removed_while_upload_is_queued_is_not_uploaded(self):
        album = {**ALBUM, 'images': [{'rawKey': RAW}]}
        with patch.object(worker, 'live_album', side_effect=[album, {**album, 'images': []}]), patch.object(worker.provider, 'get_drive_service', return_value=Mock()), patch.object(worker, 'album_folder', return_value='folder'), patch.object(worker, 'children', return_value=[]), patch.object(worker, 'upload') as upload:
            worker.reconcile({**JOB, 'removedKeys': []})
        upload.assert_not_called()

    def test_explicit_removal_trashes_all_identified_historical_copies(self):
        service = Mock()
        item = {'id': 'file', 'appProperties': {worker.MEDIA_ID: worker.media_id_for_key(RAW), worker.provider.APP_ALBUM_ID_KEY: ALBUM['albumId']}}
        with patch.object(worker, 'live_album', return_value={**ALBUM, 'images': []}), patch.object(worker.provider, 'get_drive_service', return_value=service), patch.object(worker, 'album_folder', return_value='folder'), patch.object(worker, 'children', return_value=[item, {**item, 'id': 'duplicate'}]):
            worker.reconcile(JOB)
        self.assertEqual(service.files().update.call_count, 2)

    def test_worker_failure_records_error_and_releases_lease(self):
        state = Mock(); state.get_item.side_effect = [{'Item': JOB}, {'Item': {}}]
        with patch.object(jobs, 'state_table', return_value=state), patch.object(worker, 'live_album', return_value=ALBUM), patch.object(jobs, 'claim', return_value=True), patch.object(worker, 'reconcile', side_effect=RuntimeError('private provider failure')), patch.object(jobs, 'fail') as fail, patch.object(jobs, 'release') as release:
            with self.assertRaises(RuntimeError): worker.process(ALBUM['albumId'], JOB['entry'])
        fail.assert_called_once_with(JOB)
        release.assert_called_once()

    def test_repeated_completed_delivery_is_noop(self):
        state = Mock(); state.get_item.return_value = {'Item': {**JOB, 'status': 'done'}}
        with patch.object(jobs, 'state_table', return_value=state), patch.object(worker, 'reconcile') as reconcile:
            worker.process(ALBUM['albumId'], JOB['entry'])
        reconcile.assert_not_called()

    def test_folder_move_keeps_identity_and_creates_destination(self):
        service = Mock(); service.files().get.return_value.execute.return_value = {'id': 'folder', 'parents': ['old'], 'appProperties': {worker.provider.APP_ALBUM_ID_KEY: ALBUM['albumId']}}
        with patch.object(worker, 'assert_root'), patch.object(worker.provider, 'find_or_create_folder', side_effect=['photos', 'new-category']), patch.object(worker.provider, 'table', Mock()):
            self.assertEqual(worker.album_folder(service, {**ALBUM, 'title': 'Renamed'}), 'folder')
        args = service.files().update.call_args.kwargs
        self.assertEqual(args['fileId'], 'folder')
        self.assertEqual(args['addParents'], 'new-category')
        self.assertEqual(args['removeParents'], 'old')
        self.assertEqual(args['body']['name'], 'Renamed')

    def test_foreign_folder_or_missing_link_fails_without_creation(self):
        service = Mock(); service.files().get.return_value.execute.return_value = {'appProperties': {worker.provider.APP_ALBUM_ID_KEY: 'other'}}
        with patch.object(worker.provider, 'find_or_create_folder') as create:
            with self.assertRaises(RuntimeError): worker.album_folder(service, ALBUM)
        create.assert_not_called()


class StatusTests(unittest.TestCase):
    def event(self, body):
        import json
        return {'body': json.dumps(body)}

    def test_admin_required_before_database_access(self):
        with patch.object(api, 'verify_front_door_request', return_value=None), patch.object(api, 'require_admin', return_value={'statusCode': 403}), patch.object(api, 'batch_get') as read:
            self.assertEqual(api.handler({}, None)['statusCode'], 403)
        read.assert_not_called()

    def test_status_is_batched_and_never_returns_drive_ids(self):
        import json
        with patch.object(api, 'verify_front_door_request', return_value=None), patch.object(api, 'require_admin', return_value=None), patch.object(api, 'batch_get', side_effect=[[ALBUM], [{'albumId': ALBUM['albumId'], 'status': 'synced', 'driveFolderId': 'secret-folder'}]]), patch.object(jobs, 'state_table', return_value=Mock()):
            result = api.handler(self.event({'albumIds': [ALBUM['albumId']]}), None)
        payload = json.loads(result['body'])
        self.assertEqual(payload['items'][0]['status'], 'synced')
        self.assertNotIn('secret-folder', result['body'])

    def test_gallery_only_does_not_read_backup_table(self):
        with patch.object(api, 'verify_front_door_request', return_value=None), patch.object(api, 'require_admin', return_value=None), patch.object(api, 'batch_get', return_value=[{**ALBUM, 'driveFolderId': ''}]) as read:
            result = api.handler(self.event({'albumIds': [ALBUM['albumId']]}), None)
        self.assertEqual(result['statusCode'], 200)
        self.assertEqual(read.call_count, 1)

class AdditionalBackupBehaviorTests(unittest.TestCase):
    def test_root_ancestry_requires_configured_destination(self):
        service = Mock()
        with patch.dict(os.environ, {'GOOGLE_DRIVE_FOLDER_ID': 'root'}):
            worker.assert_root(service, {'id': 'root'})
            service.files().get.return_value.execute.return_value = {'id': 'root'}
            worker.assert_root(service, {'id': 'album', 'parents': ['root']})
            with self.assertRaises(RuntimeError): worker.assert_root(service, {'id': 'album', 'parents': []})
            service.files().get.return_value.execute.return_value = {'id': 'other', 'trashed': True}
            with self.assertRaises(RuntimeError): worker.assert_root(service, {'id': 'album', 'parents': ['other']})

    def test_stream_skips_unrelated_updates_and_delivers_original_retry_job(self):
        event = {'Records': [{'eventName': 'MODIFY'}, {'eventName': 'INSERT', 'dynamodb': {'NewImage': jobs.encode({'albumId': ALBUM['albumId'], 'entry': 'delivery#new', 'recordType': 'delivery', 'jobEntry': JOB['entry']})}}]}
        with patch.object(worker, 'process') as process:
            worker.handler(event)
        process.assert_called_once_with(ALBUM['albumId'], JOB['entry'], None)

    def test_retained_album_finishes_pending_job_without_acquiring_provider_lease(self):
        state = Mock(); state.get_item.side_effect = [{'Item': JOB}, {'Item': {'retained': True}}]
        with patch.object(jobs, 'state_table', return_value=state), patch.object(jobs, 'claim') as claim, patch.object(jobs, 'complete') as complete:
            worker.process(ALBUM['albumId'], JOB['entry'])
        claim.assert_not_called()
        complete.assert_called_once_with(JOB, retained=True)

    def test_actual_upload_sets_stable_identity_and_cleans_temporary_file(self):
        album = {**ALBUM, 'images': [{'rawKey': RAW}]}
        service = Mock(); service.files().create.return_value.next_chunk.return_value = (None, {'id': 'new-file'})
        s3 = Mock(); s3.head_object.return_value = {'ContentLength': 3, 'ContentType': 'image/jpeg'}
        with patch.object(worker.provider, 's3', s3), patch.object(worker, 'live_album', return_value=album), patch.object(worker, 'MediaFileUpload', return_value='media'), patch.object(worker.os, 'remove') as remove:
            self.assertEqual(worker.upload(service, album, RAW, 'folder', None), 'new-file')
        self.assertEqual(service.files().create.call_args.kwargs['body']['appProperties'][worker.MEDIA_ID], worker.media_id_for_key(RAW))
        self.assertEqual(remove.call_count, 1)
        # Mocked unlink above intentionally preserves the file for assertion cleanup.
        os.remove(remove.call_args.args[0])

    def test_upload_rechecks_membership_after_download(self):
        service = Mock(); s3 = Mock(); s3.head_object.return_value = {'ContentLength': 3}
        with patch.object(worker.provider, 's3', s3), patch.object(worker, 'live_album', return_value={**ALBUM, 'images': []}):
            self.assertIsNone(worker.upload(service, ALBUM, RAW, 'folder', None))
        service.files().create.assert_not_called()

    def test_upload_refuses_oversized_original_and_near_timeout(self):
        service = Mock(); s3 = Mock(); s3.head_object.return_value = {'ContentLength': 2000 * 1024 * 1024}
        with patch.object(worker.provider, 's3', s3):
            with self.assertRaises(RuntimeError): worker.upload(service, ALBUM, RAW, 'folder', None)
        s3.download_file.assert_not_called()
        context = Mock(); context.get_remaining_time_in_millis.return_value = 1000
        s3.head_object.return_value = {'ContentLength': 3}
        with patch.object(worker.provider, 's3', s3), patch.object(worker, 'live_album', return_value={**ALBUM, 'images': [{'rawKey': RAW}]}), patch.object(worker, 'MediaFileUpload', return_value='media'):
            with self.assertRaises(RuntimeError): worker.upload(service, ALBUM, RAW, 'folder', context)

    def test_paginated_folder_inventory_and_error_state(self):
        service = Mock(); service.files().list.return_value.execute.side_effect = [{'files': [{'id': 'a'}], 'nextPageToken': 'more'}, {'files': [{'id': 'b'}]}]
        self.assertEqual([item['id'] for item in worker.children(service, 'folder')], ['a', 'b'])
        state = Mock()
        with patch.object(jobs, 'state_table', return_value=state): jobs.fail(JOB)
        self.assertEqual(state.update_item.call_count, 2)
        self.assertNotIn('private provider', str(state.update_item.call_args))

    def test_status_retry_validation_and_busy_state(self):
        import json
        def call(body): return api.handler({'body': json.dumps(body)}, None)
        with patch.object(api, 'verify_front_door_request', return_value=None), patch.object(api, 'require_admin', return_value=None), patch.object(api, 'batch_get', return_value=[ALBUM]), patch.object(jobs, 'enqueue_retry', return_value=True):
            self.assertEqual(call({'albumIds': [ALBUM['albumId']], 'action': 'retry'})['statusCode'], 202)
            self.assertEqual(call({'albumIds': [ALBUM['albumId']], 'action': 'unknown'})['statusCode'], 400)
            self.assertEqual(call({'albumIds': []})['statusCode'], 400)
            self.assertEqual(call({'albumIds': ['bad']})['statusCode'], 400)
        with patch.object(api, 'verify_front_door_request', return_value=None), patch.object(api, 'require_admin', return_value=None), patch.object(api, 'batch_get', side_effect=[[ALBUM], [{'albumId': ALBUM['albumId'], 'status': 'queued', 'pendingJobs': 1, 'leaseUntil': 9999999999}]]), patch.object(jobs, 'state_table', return_value=Mock()):
            payload = json.loads(call({'albumIds': [ALBUM['albumId']]})['body'])
            self.assertEqual(payload['items'][0]['status'], 'syncing')
            self.assertFalse(payload['items'][0]['canRetry'])
