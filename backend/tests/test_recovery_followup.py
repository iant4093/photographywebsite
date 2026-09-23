"""Stateful regressions for interrupted provider work and storage cutovers."""
from contextlib import ExitStack
from copy import deepcopy
import json
import os
import unittest
from unittest.mock import Mock, patch
import test_support
import boto3
from botocore.exceptions import ClientError
import test_publication_recovery as publication
from test_publication_recovery import ALBUM, SUB, RECORD, CONTEXT
import cache_invalidation, visibility_change, update_album, user_email_update
import create_album, upload_followup, video_jobs, add_images, get_album_media, album_media_store
import drive_backup_jobs, drive_backup_reconcile, cache_invalidation_worker, google_drive_sync


class RecoveryFollowupTests(unittest.TestCase):
    setUp = publication.PublicationRecoveryTests.setUp
    put = publication.PublicationRecoveryTests.put
    album = publication.PublicationRecoveryTests.album
    event = publication.PublicationRecoveryTests.event

    def test_privacy_stays_pending_until_purge_completes_and_does_not_resubmit(self):
        client = Mock()
        client.create_invalidation.return_value = {'Invalidation': {'Id': 'purge-id', 'Status': 'InProgress'}}
        client.get_invalidation.return_value = {'Invalidation': {'Id': 'purge-id', 'Status': 'Completed'}}
        with patch.dict(os.environ, {'IMAGES_DISTRIBUTION_ID': 'distribution'}), patch.object(cache_invalidation, '_client', return_value=client), patch.object(visibility_change, 'prepare_media_revocation', cache_invalidation.prepare_media_revocation), patch.object(visibility_change, 'advance_media_revocation', cache_invalidation.advance_media_revocation), patch.object(cache_invalidation.time, 'time', return_value=1000) as now:
            result = update_album.handler(self.event({'visibility': 'unlisted'}), CONTEXT)
            self.assertEqual(result['statusCode'], 202)
            self.assertEqual(self.album()['status'], 'updating')
            self.assertEqual(self.album()['pendingVisibilityChange']['invalidation']['id'], 'purge-id')
            self.assertEqual(update_album.handler(self.event({'visibility': 'unlisted'}), CONTEXT)['statusCode'], 202)
            client.get_invalidation.assert_not_called()
            now.return_value = 1016
            self.assertEqual(update_album.handler(self.event({'visibility': 'unlisted'}), CONTEXT)['statusCode'], 200)
            self.assertEqual(self.album()['status'], 'active')
            self.assertNotIn('pendingVisibilityChange', self.album())
        client.create_invalidation.assert_called_once()
        client.get_invalidation.assert_called_once()

    def test_lost_purge_response_reuses_identical_provider_token_and_paths(self):
        with patch.dict(os.environ, {'IMAGES_DISTRIBUTION_ID': 'distribution'}), patch.object(cache_invalidation, '_client') as factory:
            receipt = cache_invalidation.prepare_media_revocation(RECORD, 'operation')
            factory.return_value.create_invalidation.side_effect = [RuntimeError('lost response'), {'Invalidation': {'Id': 'purge', 'Status': 'Completed'}}]
            with self.assertRaises(RuntimeError): cache_invalidation.advance_media_revocation(receipt)
            self.assertTrue(cache_invalidation.advance_media_revocation(receipt))
            calls = factory.return_value.create_invalidation.call_args_list
            self.assertEqual(calls[0], calls[1])
            self.assertTrue(cache_invalidation.advance_media_revocation(receipt))
            factory.return_value.get_invalidation.assert_not_called()

    def test_corrected_email_after_definitive_rejection_is_allowed(self):
        client = Mock(); client.exceptions = boto3.client('cognito-idp').exceptions
        client.admin_update_user_attributes.side_effect = [client.exceptions.AliasExistsException({'Error': {'Code': 'AliasExistsException'}}, 'AdminUpdateUserAttributes'), None]
        with patch.object(user_email_update, 'cognito_identity', return_value=('name', SUB, {'email': 'old@example.test'})), patch.object(user_email_update, 'assert_admin_target_mutable'), patch.object(user_email_update, 'albums_owned_by', return_value=[]):
            with self.assertRaises(client.exceptions.AliasExistsException):
                user_email_update.update(self.table, client, 'pool', 'old@example.test', 'taken@example.test', {}, {}, CONTEXT)
            self.assertEqual(user_email_update.update(self.table, client, 'pool', 'old@example.test', 'available@example.test', {}, {}, CONTEXT), 0)
        self.assertEqual(client.admin_update_user_attributes.call_count, 2)

    def test_uncertain_email_change_still_blocks_different_operation(self):
        client = Mock(); client.exceptions = boto3.client('cognito-idp').exceptions
        client.admin_update_user_attributes.side_effect = RuntimeError('timeout')
        with patch.object(user_email_update, 'cognito_identity', return_value=('name', SUB, {'email': 'old@example.test'})), patch.object(user_email_update, 'assert_admin_target_mutable'), patch.object(user_email_update, 'albums_owned_by', return_value=[]):
            with self.assertRaises(RuntimeError): user_email_update.update(self.table, client, 'pool', 'old@example.test', 'new@example.test', {}, {}, CONTEXT)
            with self.assertRaises(user_email_update.MediaMutationBusy): user_email_update.update(self.table, client, 'pool', 'old@example.test', 'different@example.test', {}, {}, CONTEXT)
        client.admin_update_user_attributes.assert_called_once()

    def test_pagination_survives_both_storage_transitions_and_deleted_anchor(self):
        images = [{'rawKey': f'albums/{ALBUM}/original/{index}.jpg'} for index in range(4)]
        album = {**RECORD, 'images': images, 'imageCount': 4}
        album_media_store.replace_album_media(ALBUM, images)
        with patch.object(get_album_media, 'albums_table', self.table), patch.object(get_album_media, 'require_admin', return_value=None), patch.object(get_album_media, 'verify_front_door_request', return_value=None), patch.object(get_album_media, 'serialize_album_detail', return_value={'albumId': ALBUM}), patch.object(get_album_media, 'serialize_images', side_effect=lambda value, **_: value['images']):
            def page(cursor=None):
                result = get_album_media.handler({'pathParameters': {'albumId': ALBUM}, 'queryStringParameters': {'limit': '1', **({'cursor': cursor} if cursor else {})}}, CONTEXT)
                self.assertEqual(result['statusCode'], 200, result)
                return json.loads(result['body'])
            for first_store, next_store in [(1, None), (None, 1)]:
                self.put({**album, **({'mediaStoreVersion': first_store} if first_store else {})})
                first = page()
                self.put({**album, **({'mediaStoreVersion': next_store} if next_store else {})})
                second = page(first['nextCursor'])
                self.assertEqual(second['items'][0]['rawKey'], images[1]['rawKey'])
                self.put({**album, 'images': images[2:], 'imageCount': 2})
                third = page(second['nextCursor'])
                self.assertEqual(third['items'][0]['rawKey'], images[2]['rawKey'])

    def test_normalized_index_lag_uses_complete_manifest_page(self):
        self.put({**RECORD, 'mediaStoreVersion': 1})
        with patch.object(get_album_media, 'albums_table', self.table), patch.object(get_album_media, 'require_admin', return_value=None), patch.object(get_album_media, 'verify_front_door_request', return_value=None), patch.object(get_album_media, 'serialize_album_detail', return_value={'albumId': ALBUM}), patch.object(get_album_media, 'serialize_images', side_effect=lambda value, **_: value['images']), patch.object(album_media_store, 'query_album_media', return_value=([], None)):
            result = get_album_media.handler({'pathParameters': {'albumId': ALBUM}}, CONTEXT)
        self.assertEqual(json.loads(result['body'])['items'], RECORD['images'])

    def create_fixture(self, stack, kind='photo'):
        self.table.delete_item(Key={'albumId': ALBUM})
        stack.enter_context(patch.object(create_album, 'table', self.table))
        for name in ('require_admin', 'verify_front_door_request', '_audit', '_extract_exif', '_ensure_album_qr', 'tag_album_visibility'):
            stack.enter_context(patch.object(create_album, name, return_value=None))
        stack.enter_context(patch.object(create_album, 'get_caller_claims', return_value={'sub': SUB}))
        stack.enter_context(patch.object(create_album, 'serialize_album_summary', side_effect=lambda value, **_: {'albumId': value['albumId']}))
        images = RECORD['images'] if kind == 'photo' else [{'rawKey': f'albums/{ALBUM}/original/{n}.mp4'} for n in range(2)]
        return {'body': json.dumps({'albumId': ALBUM, 'uploadRequestId': '33333333-3333-4333-8333-333333333333', 'type': kind, 'visibility': 'public', 'title': 'Synthetic', 'createdAt': '2026-09-22T00:00:00Z', 'images': images})}

    def test_new_album_recovers_preview_failure_without_recreating_album(self):
        with ExitStack() as stack:
            event = self.create_fixture(stack)
            self.preview.side_effect = [RuntimeError('queue outage'), 1]
            self.assertEqual(create_album.handler(event, CONTEXT)['statusCode'], 201)
            self.assertIn('pendingMediaUpload', self.album())
            self.assertEqual(create_album.handler(event, CONTEXT)['statusCode'], 201)
            self.assertNotIn('pendingMediaUpload', self.album())
            self.assertEqual(self.preview.call_count, 2)
            self.assertEqual(len(self.album()['images']), 1)

    def test_video_job_acceptance_then_failed_save_reconciles_without_resubmission(self):
        image = {'rawKey': f'albums/{ALBUM}/original/movie.mp4'}
        album = {**RECORD, 'type': 'video', 'images': [image]}
        album['videoJobs'] = video_jobs.prepare(album, album['images']); self.put(album)
        original = self.table.update_item
        def fail_write(**kwargs):
            if 'images = :images' in kwargs['UpdateExpression']:
                raise RuntimeError('database save interrupted')
            return original(**kwargs)
        with patch.object(video_jobs, 'start_mediaconvert_job', return_value='accepted-job') as submit, patch.object(self.table, 'update_item', side_effect=fail_write):
            with self.assertRaises(RuntimeError): video_jobs.resume(self.table, album, CONTEXT)
        receipt = next(iter(self.album()['videoJobs'].values()))
        self.assertEqual(receipt['phase'], 'submitting')
        provider = Mock(); provider.search_jobs.return_value = {'Jobs': [{'Id': 'accepted-job', 'ClientRequestToken': receipt['token']}]}
        with patch.object(video_jobs, 'get_mediaconvert_client', return_value=provider), patch.object(video_jobs, 'start_mediaconvert_job') as retry:
            video_jobs.resume(self.table, self.album(), CONTEXT)
        submit.assert_called_once(); retry.assert_not_called()
        self.assertEqual(self.album()['images'][0]['mediaConvertJobId'], 'accepted-job')
        self.assertEqual(self.album()['videoJobs'], {})

    def test_partial_video_rejection_retries_only_failed_file(self):
        with ExitStack() as stack:
            event = self.create_fixture(stack, 'video')
            submit = stack.enter_context(patch.object(video_jobs, 'start_mediaconvert_job', side_effect=['first-job', ClientError({'Error': {'Code': 'TooManyRequestsException'}}, 'CreateJob'), 'second-job']))
            stack.enter_context(patch.object(video_jobs.time, 'time', return_value=1000))
            self.assertEqual(create_album.handler(event, CONTEXT)['statusCode'], 201)
            self.assertEqual(len(self.album()['videoJobs']), 1)
            self.assertNotIn('hlsUrl', self.album()['images'][1])
            with patch.object(video_jobs.time, 'time', return_value=1061):
                add_images.handler({'source': 'album-video-jobs', 'albumId': ALBUM}, CONTEXT)
            self.assertEqual(submit.call_count, 3)
            self.assertEqual([i['mediaConvertJobId'] for i in self.album()['images']], ['first-job', 'second-job'])

    def test_old_uncertain_submission_is_not_recreated_after_provider_window(self):
        image = {'rawKey': f'albums/{ALBUM}/original/movie.mp4'}
        album = {**RECORD, 'type': 'video', 'images': [image]}
        album['videoJobs'] = video_jobs.prepare(album, album['images'])
        receipt = next(iter(album['videoJobs'].values())); receipt.update(phase='submitting', submittedAt=1000)
        self.put(album)
        provider = Mock(); provider.search_jobs.return_value = {'Jobs': []}
        with patch.object(video_jobs.time, 'time', return_value=1200), patch.object(video_jobs, 'get_mediaconvert_client', return_value=provider), patch.object(video_jobs, 'start_mediaconvert_job') as submit:
            video_jobs.resume(self.table, self.album(), CONTEXT)
        submit.assert_not_called()
        self.assertEqual(next(iter(self.album()['videoJobs'].values()))['phase'], 'submitting')

    def test_backup_update_defers_and_preserves_exact_job_then_resumes(self):
        db = boto3.resource('dynamodb')
        backup = db.create_table(TableName='backup-test', KeySchema=[{'AttributeName': 'albumId', 'KeyType': 'HASH'}, {'AttributeName': 'entry', 'KeyType': 'RANGE'}], AttributeDefinitions=[{'AttributeName': 'albumId', 'AttributeType': 'S'}, {'AttributeName': 'entry', 'AttributeType': 'S'}], BillingMode='PAY_PER_REQUEST')
        with patch.dict(os.environ, {'DRIVE_BACKUP_STATE_TABLE': 'backup-test'}), patch.object(drive_backup_reconcile.provider, 'table', self.table), patch.object(cache_invalidation, '_queue_client') as queue:
            album = {**RECORD, 'backupToGoogleDrive': True}
            job, writes = drive_backup_jobs.new_intent(album, [RECORD['images'][0]['rawKey']]); drive_backup_jobs.transaction(writes)
            self.put({**album, 'status': 'updating'})
            drive_backup_reconcile.process(ALBUM, job['entry'], CONTEXT)
            saved = backup.get_item(Key={'albumId': ALBUM, 'entry': job['entry']})['Item']
            self.assertEqual(saved['status'], 'pending'); self.assertEqual(saved['removedKeys'], job['removedKeys'])
            self.assertEqual(backup.get_item(Key={'albumId': ALBUM, 'entry': 'state'})['Item']['pendingJobs'], 1)
            self.assertEqual(queue.return_value.send_message.call_args.kwargs['DelaySeconds'], 30)
            self.put(album)
            with patch.object(drive_backup_reconcile, 'reconcile', return_value=False):
                drive_backup_reconcile.process(ALBUM, job['entry'], CONTEXT)
            self.assertEqual(backup.get_item(Key={'albumId': ALBUM, 'entry': job['entry']})['Item']['status'], 'done')

    def test_video_search_failure_never_resets_an_uncertain_submission(self):
        image = {'rawKey': f'albums/{ALBUM}/original/movie.mp4'}
        album = {**RECORD, 'type': 'video', 'images': [image]}
        album['videoJobs'] = video_jobs.prepare(album, album['images'])
        next(iter(album['videoJobs'].values())).update(phase='submitting', submittedAt=1000)
        self.put(album)
        provider = Mock(); provider.search_jobs.side_effect = ClientError({'Error': {'Code': 'ForbiddenException'}}, 'SearchJobs')
        with patch.object(video_jobs.time, 'time', return_value=1000), patch.object(video_jobs, 'get_mediaconvert_client', return_value=provider), patch.object(video_jobs, 'start_mediaconvert_job') as submit:
            video_jobs.resume(self.table, self.album(), CONTEXT)
        submit.assert_not_called()
        self.assertEqual(next(iter(self.album()['videoJobs'].values()))['phase'], 'submitting')

    def test_video_normalization_failure_enqueues_existing_repair_worker(self):
        image = {'rawKey': f'albums/{ALBUM}/original/movie.mp4'}
        album = {**RECORD, 'type': 'video', 'images': [image]}
        album['videoJobs'] = video_jobs.prepare(album, album['images']); self.put(album)
        with patch.object(video_jobs, 'start_mediaconvert_job', return_value='job'), patch.object(video_jobs, 'finish_media_sync', return_value=False), patch.object(video_jobs, 'enqueue') as enqueue:
            video_jobs.resume(self.table, album, CONTEXT)
        enqueue.assert_called_once_with(ALBUM, 'album-media-sync', delay=30)
        self.assertTrue(self.album()['mediaStoreDirty'])
        self.assertEqual(self.album()['images'][0]['mediaConvertJobId'], 'job')

    def test_backup_dispatch_uses_async_invocation_and_keeps_distinct_jobs(self):
        client = Mock(); client.invoke.return_value = {'StatusCode': 202}
        entries = ['job#' + '1' * 32, 'job#' + '2' * 32]
        event = {'Records': [{'messageId': str(index), 'body': json.dumps({'version': 1, 'kind': 'album-drive-backup', 'albumId': ALBUM, 'jobEntry': entry})} for index, entry in enumerate(entries)]}
        with patch.dict(os.environ, {'DRIVE_WORKER_FUNCTION_NAME': 'existing-drive-worker'}), patch.object(cache_invalidation_worker.boto3.session.Session, 'client', return_value=client):
            result = cache_invalidation_worker.handler(event, CONTEXT)
        self.assertEqual(result['batchItemFailures'], [])
        self.assertEqual(client.invoke.call_count, 2)
        self.assertEqual({json.loads(call.kwargs['Payload'])['jobEntry'] for call in client.invoke.call_args_list}, set(entries))
        self.assertTrue(all(call.kwargs['InvocationType'] == 'Event' for call in client.invoke.call_args_list))

    def test_privacy_completion_redispatches_interrupted_media_followup_before_commit(self):
        self.put({**RECORD, 'pendingMediaUpload': {'id': 'upload', 'keys': [], 'done': []}})
        result = update_album.handler(self.event({'visibility': 'unlisted'}), CONTEXT)
        self.assertEqual(result['statusCode'], 200)
        messages = [json.loads(call.kwargs['MessageBody']) for call in self.queue.return_value.send_message.call_args_list]
        self.assertTrue(any(message.get('kind') == 'album-upload-followup' for message in messages))
        self.assertEqual(self.album()['status'], 'active')
        self.assertIn('pendingMediaUpload', self.album())
