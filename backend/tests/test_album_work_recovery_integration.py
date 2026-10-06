"""Run both consumers through the real upload handler, leases and durable checkpoints."""
import io
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import test_support  # noqa: F401
import boto3
from moto import mock_aws
import add_images
import album_media_store
import album_work_worker
import cache_invalidation_worker
import continuation_dispatch
import upload_followup

ALBUM = '11111111-1111-4111-8111-111111111111'
RAW = f'albums/{ALBUM}/original/one.jpg'
CONTEXT = SimpleNamespace(get_remaining_time_in_millis=lambda: 60000)


class AlbumWorkRecoveryIntegrationTests(unittest.TestCase):
    def setUp(self):
        aws = mock_aws(); aws.start(); self.addCleanup(aws.stop)
        db = boto3.resource('dynamodb', region_name='us-west-2')
        self.albums = db.create_table(TableName='pipeline-albums', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'albumId', 'KeyType': 'HASH'}], AttributeDefinitions=[{'AttributeName': 'albumId', 'AttributeType': 'S'}])
        self.media = db.create_table(TableName='pipeline-media', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'albumId', 'KeyType': 'HASH'}, {'AttributeName': 'mediaId', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'albumId', 'AttributeType': 'S'}, {'AttributeName': 'mediaId', 'AttributeType': 'S'}])
        self.album = {'albumId': ALBUM, 'images': [{'rawKey': RAW}], 'imageCount': 1, 'status': 'active', 'visibility': 'public', 'type': 'photo', 'mediaStoreDirty': True,
                      'pendingMediaUpload': {'id': 'a'*32, 'keys': [RAW], 'done': []}}
        self.albums.put_item(Item=self.album)
        self.mocks = {}
        patches = {'table': patch.object(add_images, 'table', self.albums), 'media': patch.object(album_media_store, '_table', return_value=self.media),
                   'tags': patch.object(upload_followup, 'tag_keys_visibility'), 'comparisons': patch.object(upload_followup, 'enqueue_original_comparisons'),
                   'previews': patch.object(upload_followup, 'enqueue_preview_jobs'), 'catalog': patch.object(upload_followup, 'request_public_api_invalidation', return_value=True),
                   'random': patch.object(upload_followup, 'request_random_photo_pool_refresh', return_value=True),
                   'drive': patch.object(upload_followup.drive_backup_jobs, 'state_table', return_value=None),
                   'environment': patch.dict(os.environ, {'MEDIA_MUTATION_PROTOCOL': '1', 'UPLOAD_WORKER_FUNCTION_NAME': 'upload-worker', 'RANDOM_PHOTO_REFRESH_QUEUE_URL': 'random', 'ALBUM_WORK_QUEUE_URL': 'work'})}
        for name, p in patches.items(): self.mocks[name] = p.start(); self.addCleanup(p.stop)
        p = patch.object(continuation_dispatch.boto3.session, 'Session'); factory = p.start(); self.addCleanup(p.stop)
        factory.return_value.client.return_value.invoke.side_effect = self.invoke

    def invoke(self, **kwargs):
        self.assertEqual(kwargs['InvocationType'], 'RequestResponse')
        try:
            response = add_images.handler(json.loads(kwargs['Payload']), CONTEXT)
            return {'StatusCode': 200, 'Payload': io.BytesIO(json.dumps(response).encode())}
        except Exception:
            return {'StatusCode': 200, 'FunctionError': 'Unhandled', 'Payload': io.BytesIO(b'{}')}

    def consume(self, consumer=album_work_worker):
        return consumer.handler({'Records': [{'messageId': 'delivery', 'body': json.dumps({'version': 1, 'kind': 'album-upload-followup', 'albumId': ALBUM})}]}, CONTEXT)

    def saved(self): return self.albums.get_item(Key={'albumId': ALBUM}, ConsistentRead=True).get('Item')

    def test_duplicate_delivery_and_mixed_consumers_finish_each_stage_once(self):
        for first, second in ((album_work_worker, cache_invalidation_worker), (cache_invalidation_worker, album_work_worker)):
            with self.subTest(first=first.__name__):
                self.albums.put_item(Item=self.album)
                for name in ('tags', 'comparisons', 'previews', 'catalog', 'random'): self.mocks[name].reset_mock()
                self.assertEqual(self.consume(first)['batchItemFailures'], [])
                self.assertEqual(self.consume(second)['batchItemFailures'], [])
                self.assertEqual(self.consume(second)['batchItemFailures'], [])
                saved = self.saved(); self.assertNotIn('pendingMediaUpload', saved); self.assertNotIn('mediaStoreDirty', saved)
                self.assertEqual(saved['mediaStoreVersion'], 1); self.assertEqual(saved['images'], self.album['images'])
                for name in ('tags', 'comparisons', 'previews', 'catalog', 'random'): self.mocks[name].assert_called_once()
                self.assertNotIn('mediaLeaseOwner', saved)

    def test_provider_failure_retains_receipt_and_retry_resumes_without_rewriting_manifest(self):
        self.mocks['previews'].side_effect = RuntimeError('provider outage')
        self.assertEqual(self.consume()['batchItemFailures'], [{'itemIdentifier': 'delivery'}])
        saved = self.saved(); self.assertEqual(saved['pendingMediaUpload']['done'], ['tags', 'comparisons'])
        self.assertEqual(saved['images'], self.album['images']); self.assertNotIn('mediaLeaseOwner', saved)
        self.mocks['previews'].side_effect = None
        self.assertEqual(self.consume(cache_invalidation_worker)['batchItemFailures'], [])
        self.mocks['tags'].assert_called_once(); self.mocks['comparisons'].assert_called_once()
        self.assertEqual(self.mocks['previews'].call_count, 2); self.assertNotIn('pendingMediaUpload', self.saved())

    def test_creation_and_privacy_transitions_defer_work_until_active_commit(self):
        for changes in ({'createdBySub': 'creator'}, {'status': 'updating', 'pendingVisibilityChange': {'id': 'privacy'}}):
            with self.subTest(changes=changes):
                self.albums.put_item(Item={**self.album, **changes})
                self.assertEqual(self.consume()['batchItemFailures'], [{'itemIdentifier': 'delivery'}])
                self.mocks['tags'].assert_not_called()
                self.albums.put_item(Item=self.album)
                self.assertEqual(self.consume()['batchItemFailures'], [])
                self.mocks['tags'].reset_mock()

    def test_deleted_album_is_acknowledged_without_recreating_media_or_dispatching(self):
        self.albums.delete_item(Key={'albumId': ALBUM})
        self.assertEqual(self.consume()['batchItemFailures'], [])
        self.assertIsNone(self.saved()); self.assertEqual(self.media.scan()['Items'], [])
        for name in ('tags', 'comparisons', 'previews', 'catalog', 'random'): self.mocks[name].assert_not_called()
