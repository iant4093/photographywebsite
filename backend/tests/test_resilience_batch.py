"""Failure-path regression tests: bounded work and recoverable deletion."""
import json
import unittest
from copy import deepcopy
from unittest.mock import Mock, patch
from botocore.exceptions import ClientError
import test_support
from test_album_write_branch_coverage import album, event, RAW_KEY
import get_public_album as feed
import delete_images as deletion
import audit_helpers
import hero_cover
import create_zip
import front_door
import secret_helpers
import security_helpers
import login
from aws_request_config import request_config


class DependencyBudgets(unittest.TestCase):
    def test_request_clients_have_short_bounded_retries(self):
        for config in (request_config(), feed.table.meta.client.meta.config,
                       security_helpers._get_rate_table().meta.client.meta.config):
            self.assertLessEqual(config.connect_timeout, 2)
            self.assertLessEqual(config.read_timeout, 3)
            self.assertEqual(config.retries['total_max_attempts'], 2)
        for client in (front_door._client(), secret_helpers._ssm_client(), login.cognito):
            self.assertEqual(client.meta.config.retries['total_max_attempts'], 1)

    def test_feed_read_failure_never_triggers_catalog_fallback(self):
        for loader, responder in [('load_pool_references', feed._random_photos_response),
                                  ('load_featured_references', feed._featured_photos_response)]:
            with self.subTest(loader=loader), patch.object(feed, '_preview_table'), patch.object(
                feed, loader, side_effect=RuntimeError('offline')), patch.object(feed, '_random_photo_albums') as fallback:
                with self.assertRaises(feed.PhotoFeedUnavailable):
                    responder({})
                fallback.assert_not_called()

    def test_legacy_pagination_stops_without_returning_partial_results(self):
        with patch.dict(feed.os.environ, {'VISIBILITY_CREATED_AT_INDEX': 'VisibilityCreatedAtIndex'}), patch.object(
            feed.table, 'query', return_value={'Items': [], 'LastEvaluatedKey': {'albumId': 'next'}}) as query:
            with self.assertRaises(feed.PhotoFeedUnavailable):
                feed._random_photo_albums()
            self.assertEqual(query.call_count, feed.FALLBACK_MAX_PAGES)
            self.assertTrue(all(call.kwargs['Limit'] == feed.FALLBACK_PAGE_SIZE for call in query.call_args_list))

    def test_legacy_deadline_exhaustion_prevents_next_read(self):
        with patch.object(feed.time, 'monotonic', side_effect=[0, 6]), patch.object(feed.table, 'query') as query:
            with self.assertRaises(feed.PhotoFeedUnavailable): feed._random_photo_albums()
            query.assert_not_called()

    def test_pending_deletion_never_reconstructs_removed_manifest_from_s3(self):
        with patch.object(feed.s3, 'get_paginator') as paginator:
            self.assertEqual(feed._legacy_images({'pendingMediaDeletion': {'requested': ['old']}}), [])
            paginator.assert_not_called()


class RecoverableDeletion(unittest.TestCase):
    def setUp(self):
        self.saved = album(visibility='private')
        self.table = Mock()
        self.table.meta.client.exceptions.ConditionalCheckFailedException = type('Conflict', (Exception,), {})
        self.table.get_item.side_effect = lambda **_: {'Item': deepcopy(self.saved)}
        def update(**kw):
            values = kw['ExpressionAttributeValues']
            if ':pending' in values:
                self.saved.update(images=values[':images'], imageCount=values[':count'],
                                  coverImageUrl=values[':cover'], coverThumbKey=values[':coverThumb'],
                                  coverBlurhash=values[':coverBlurhash'], pendingMediaDeletion=values[':pending'])
            else:
                self.assertEqual(self.saved['pendingMediaDeletion']['id'], values[':id'])
                del self.saved['pendingMediaDeletion']
            return {}
        self.table.update_item.side_effect = update
        for name, value in [('require_admin', None), ('load_preview_metadata', {}), ('preflight_deletion', None),
                            ('delete_preview_metadata', None), ('delete_prefix_all_versions', 0),
                            ('request_public_api_invalidation', None), ('request_random_photo_pool_refresh', None)]:
            self.enterContext(patch.object(deletion, name, return_value=value))
        self.enterContext(patch.object(deletion, 'table', self.table))
        self.enterContext(patch.object(deletion.drive_backup_jobs, 'state_table', return_value=None))
        self.erase = self.enterContext(patch.object(deletion, 'delete_keys_all_versions', return_value=2))

    def delete(self): return deletion.handler(event({'keys': [RAW_KEY]}), None)

    def test_conflict_or_busy_backup_prevents_every_object_deletion(self):
        self.table.update_item.side_effect = ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'UpdateItem')
        self.assertEqual(self.delete()['statusCode'], 409)
        self.erase.assert_not_called()
        self.assertEqual(len(self.saved['images']), 1)

    def test_failed_cleanup_is_resumed_without_recommitting_album_or_drive_intent(self):
        self.erase.side_effect = RuntimeError('storage unavailable')
        self.assertEqual(self.delete()['statusCode'], 500)
        self.assertEqual(self.saved['images'], [])
        self.assertEqual(self.saved['pendingMediaDeletion']['requested'], [RAW_KEY])
        self.assertEqual(self.table.update_item.call_count, 1)
        self.erase.side_effect = None
        self.assertEqual(self.delete()['statusCode'], 200)
        self.assertNotIn('pendingMediaDeletion', self.saved)
        self.assertEqual(self.table.update_item.call_count, 2)
        self.assertEqual(self.table.update_item.call_args.kwargs['UpdateExpression'], 'REMOVE pendingMediaDeletion')

    def test_different_deletion_cannot_overwrite_unfinished_cleanup(self):
        self.erase.side_effect = RuntimeError('storage unavailable')
        self.delete()
        self.erase.reset_mock()
        response = deletion.handler(event({'keys': [RAW_KEY + '.different']}), None)
        self.assertEqual(response['statusCode'], 409)
        self.erase.assert_not_called()


class AuditContracts(unittest.TestCase):
    def test_hero_and_failed_archive_events_are_actually_emitted(self):
        with patch.object(audit_helpers.logger, 'info') as output:
            hero_cover._audit({}, None, 'upload-url', 'success', 'upload_authorized')
            create_zip._audit({}, None, 'failure', 'archive_failed', zip_state='failed')
        records = [json.loads(call.args[0]) for call in output.call_args_list]
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]['details'], {'hero_type': 'photo'})
        self.assertEqual(records[1]['details'], {'zip_state': 'failed'})
