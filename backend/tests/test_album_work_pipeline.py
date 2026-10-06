"""Compatibility and failure isolation for separated durable continuation delivery."""
import io
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import test_support  # noqa: F401
import album_work_worker as worker
import cache_invalidation_worker as legacy
import continuation_dispatch as dispatch
import work_queue
import visibility_change
import cleanup_work
import tag_media_object
import video_upgrade
import drive_backup_jobs

ALBUM = '11111111-1111-4111-8111-111111111111'


def record(kind, identifier='message', **fields):
    return {'messageId': identifier, 'body': json.dumps({'version': 1, 'kind': kind, 'albumId': ALBUM, **fields})}


class AlbumWorkPipelineTests(unittest.TestCase):
    def test_every_v1_kind_has_identical_trusted_adapter_for_both_consumers(self):
        for kind, variable in dispatch.WORKERS.items():
            entry = 'job#' + 'a' * 32
            fields = {'jobEntry': entry, 'key': f'albums/{ALBUM}/source.jpg', 'attempt': 2, 'firstAttemptAt': 10, 'subject': 'injected', 'source': 'injected'}
            with self.subTest(kind=kind), patch.dict(os.environ, {variable: 'synthetic-worker'}), patch.object(dispatch.boto3.session, 'Session') as factory:
                client = factory.return_value.client.return_value
                client.invoke.side_effect = lambda **kw: {'StatusCode': 202 if kind == 'album-drive-backup' else 200, 'Payload': io.BytesIO(b'{"statusCode":200}')}
                self.assertEqual(worker.handler({'Records': [record(kind, **fields)]}, None), {'batchItemFailures': []})
                separated = client.invoke.call_args.kwargs
                legacy.handler({'Records': [record(kind, **fields)]}, None)
                self.assertEqual(client.invoke.call_args.kwargs, separated)
                envelope = json.loads(separated['Payload'])
                self.assertEqual(envelope['source'], kind)
                self.assertEqual(envelope.get('albumId', envelope.get('subject')), ALBUM)
                expected = {'source', 'subject'} if kind in {'user-deletion', 'user-email-update'} else {'source', 'albumId'}
                if kind == 'album-drive-backup': expected.add('jobEntry')
                if kind == 'album-object-tagging': expected |= {'key', 'attempt', 'firstAttemptAt'}
                self.assertEqual(set(envelope), expected)

    def test_duplicate_group_failure_returns_every_delivery_and_other_groups_complete(self):
        records = [record('album-upload-followup', 'one'), record('album-upload-followup', 'duplicate'), record('album-video-jobs', 'video')]
        def invoke(body):
            if body['kind'] == 'album-upload-followup': raise TimeoutError('ambiguous invocation')
        with patch.object(worker, 'continue_album_work', side_effect=invoke) as calls:
            result = worker.handler({'Records': records}, None)
        self.assertEqual(calls.call_count, 2)
        self.assertEqual(result['batchItemFailures'], [{'itemIdentifier': 'one'}, {'itemIdentifier': 'duplicate'}])

    def test_low_remaining_budget_defers_without_invoking(self):
        context = SimpleNamespace(get_remaining_time_in_millis=lambda: 23999)
        with patch.object(worker, 'continue_album_work') as calls:
            self.assertEqual(worker.handler({'Records': [record('album-deletion')]}, context), {'batchItemFailures': [{'itemIdentifier': 'message'}]})
        calls.assert_not_called()

    def test_invalid_and_cdn_messages_cannot_invoke_an_album_handler(self):
        invalid = ['null', '[]', '{bad', json.dumps({'version': 2, 'kind': 'album-deletion', 'albumId': ALBUM}),
                   json.dumps({'version': 1, 'kind': 'unknown', 'albumId': ALBUM}),
                   json.dumps({'version': 1, 'kind': 'album-deletion', 'albumId': '../admin'}),
                   json.dumps({'version': 1, 'catalog': True})]
        with patch.object(worker, 'continue_album_work') as calls:
            for body in invalid:
                self.assertEqual(worker.handler({'Records': [{'messageId': 'bad', 'body': body}]}, None), {'batchItemFailures': []})
        calls.assert_not_called()

    def test_direct_invocation_failure_is_not_silently_acknowledged(self):
        value = record('album-deletion'); value.pop('messageId')
        with patch.object(worker, 'continue_album_work', side_effect=RuntimeError('outage')):
            with self.assertRaises(RuntimeError): worker.handler({'Records': [value]}, None)

    def test_each_backup_and_tagging_identity_is_independent(self):
        records = [record('album-drive-backup', 'a', jobEntry='job#'+'a'*32), record('album-drive-backup', 'b', jobEntry='job#'+'b'*32), record('album-object-tagging', 'c', key='one'), record('album-object-tagging', 'd', key='two')]
        with patch.object(worker, 'continue_album_work') as calls:
            worker.handler({'Records': records}, None)
        self.assertEqual(calls.call_count, 4)

    def test_missing_worker_error_and_provider_failure_leave_retry_ownership_with_sqs(self):
        with patch.dict(os.environ, {dispatch.WORKERS['album-deletion']: ''}):
            self.assertEqual(worker.handler({'Records': [record('album-deletion')]}, None)['batchItemFailures'], [{'itemIdentifier': 'message'}])
        with patch.dict(os.environ, {dispatch.WORKERS['album-deletion']: 'target'}), patch.object(dispatch.boto3.session, 'Session') as factory:
            client = factory.return_value.client.return_value
            for response in ({'Payload': io.BytesIO(b'{"statusCode":500}')}, {'FunctionError': 'Unhandled', 'Payload': io.BytesIO(b'{"statusCode":200}')}, {'Payload': io.BytesIO(b'invalid')}, {'Payload': io.BytesIO(b'x'*65537)}):
                client.invoke.return_value = response
                self.assertEqual(worker.handler({'Records': [record('album-deletion')]}, None)['batchItemFailures'], [{'itemIdentifier': 'message'}])
                self.assertTrue(response['Payload'].closed)

    def test_destination_selection_and_send_failure_never_dual_dispatch(self):
        with patch.dict(os.environ, {'CACHE_INVALIDATION_QUEUE_URL': 'legacy', 'ALBUM_WORK_QUEUE_URL': ' separate '}):
            self.assertEqual(work_queue.queue_url(), 'separate')
            client = Mock(); client.send_message.side_effect = RuntimeError('outage')
            with patch.object(visibility_change, '_queue_client', return_value=client):
                with self.assertRaises(RuntimeError): visibility_change.enqueue(ALBUM)
            self.assertEqual(client.send_message.call_count, 1); self.assertEqual(client.send_message.call_args.kwargs['QueueUrl'], 'separate')
        for current in ('', '  '):
            with patch.dict(os.environ, {'CACHE_INVALIDATION_QUEUE_URL': 'legacy', 'ALBUM_WORK_QUEUE_URL': current}): self.assertEqual(work_queue.queue_url(), 'legacy')

    def test_receipt_checkpoint_is_saved_only_after_selected_queue_send(self):
        pending = {}; client = Mock(); saves = []
        def save(): saves.append(dict(pending))
        with patch.dict(os.environ, {'CACHE_INVALIDATION_QUEUE_URL': 'old', 'ALBUM_WORK_QUEUE_URL': 'work'}), patch.object(cleanup_work, '_queue_client', return_value=client):
            client.send_message.side_effect = RuntimeError('outage')
            with self.assertRaises(RuntimeError): cleanup_work.schedule(ALBUM, pending, save, 'album-deletion')
            self.assertIn('continuationStartedAt', pending); self.assertNotIn('scheduledUntil', pending)
            client.send_message.side_effect = None
            cleanup_work.schedule(ALBUM, pending, save, 'album-deletion')
            cleanup_work.schedule(ALBUM, pending, save, 'album-deletion')
        self.assertEqual(client.send_message.call_count, 2)
        self.assertTrue(all(c.kwargs['QueueUrl'] == 'work' for c in client.send_message.call_args_list))
        self.assertIn('scheduledUntil', pending); self.assertEqual(len(saves), 2)

    def test_video_repair_producer_uses_same_selected_destination_and_v1_schema(self):
        client = Mock()
        with patch.dict(os.environ, {'CACHE_INVALIDATION_QUEUE_URL': 'legacy', 'ALBUM_WORK_QUEUE_URL': 'work'}), patch.object(video_upgrade, '_sqs', client): video_upgrade._enqueue_video_jobs(ALBUM)
        self.assertEqual(client.send_message.call_args.kwargs['QueueUrl'], 'work')
        self.assertEqual(json.loads(client.send_message.call_args.kwargs['MessageBody']), {'version': 1, 'kind': 'album-video-jobs', 'albumId': ALBUM})

    def test_public_cdn_invalidation_completes_even_when_work_consumer_is_failing(self):
        with patch.object(worker, 'continue_album_work', side_effect=RuntimeError('backup blocked')), patch.object(legacy, 'invalidate_public_api_batch') as purge:
            worker.handler({'Records': [record('album-drive-backup', jobEntry='job#'+'a'*32)]}, None)
            result = legacy.handler({'Records': [{'messageId': 'cdn', 'body': json.dumps({'version': 1, 'catalog': True})}]}, None)
        self.assertTrue(result['invalidated']); purge.assert_called_once()
