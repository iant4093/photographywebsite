"""Failure scenarios from the September 2026 hardening audit; local AWS only."""
from contextlib import contextmanager
from copy import deepcopy
import json
import time
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch
import boto3
import unittest
import test_publication_recovery as baseline
from test_publication_recovery import ALBUM, SUB, RECORD, RAW, THUMB, CONTEXT
import comparison_cleanup, cleanup_work, delete_album, delete_images, media_access, ownership_guard, user_email_update
from media_mutation import MediaMutationBusy


class ExpandedRecoveryTests(unittest.TestCase):
    setUp = baseline.PublicationRecoveryTests.setUp
    put = baseline.PublicationRecoveryTests.put
    album = baseline.PublicationRecoveryTests.album
    object = baseline.PublicationRecoveryTests.object
    event = baseline.PublicationRecoveryTests.event
    # Use the shared Moto fixture without rerunning its test methods.
    def identity(self):
        client = Mock()
        client.exceptions = boto3.client('cognito-idp').exceptions
        client.admin_list_groups_for_user.return_value = {'Groups':[]}
        email = ['old@example.test']
        identity = lambda *_: ('stable', SUB, {'email':email[0]})
        client.admin_update_user_attributes.side_effect = lambda **_: email.__setitem__(0, 'new@example.test')
        return client, email, identity

    def test_email_rechecks_identity_after_acquiring_lock(self):
        client, email, identity = self.identity()
        real = ownership_guard.identity_lease
        @contextmanager
        def lease(*args, **kwargs):
            email[0] = 'concurrent@example.test'
            with real(*args, **kwargs): yield
        with patch.object(user_email_update, 'cognito_identity', side_effect=identity), patch.object(user_email_update, 'assert_admin_target_mutable'), patch.object(ownership_guard, 'identity_lease', lease):
            with self.assertRaises(MediaMutationBusy):
                user_email_update.update(self.table, client, 'pool', 'old@example.test', 'new@example.test', {'userId':SUB}, {}, CONTEXT)
        client.admin_update_user_attributes.assert_not_called()

    def test_email_progress_survives_many_bounded_invocations_and_fences_assignment(self):
        self.put({**RECORD, 'ownerEmail':'old@example.test'})
        for _ in range(35):
            self.put({**RECORD, 'albumId':str(uuid.uuid4()), 'ownerEmail':'old@example.test'})
        client, email, identity = self.identity()
        def invocation():
            budget = iter([60000]*5+[5000]*100)
            return SimpleNamespace(get_remaining_time_in_millis=lambda: next(budget))
        with patch.object(user_email_update, 'cognito_identity', side_effect=identity), patch.object(user_email_update, 'assert_admin_target_mutable'):
            result = user_email_update.update(self.table, client, 'pool', 'old@example.test', 'new@example.test', {'userId':SUB}, {}, invocation())
            self.assertIsNone(result)
            with self.assertRaises(MediaMutationBusy):
                ownership_guard.write(self.table, 'Put', SUB, Item={**RECORD, 'albumId':str(uuid.uuid4()), 'ownerSub':SUB})
            for _ in range(100):
                result = user_email_update.resume(self.table, client, 'pool', SUB, invocation())
                if result is not None: break
            self.assertEqual(result, 36)
        self.assertEqual(self.album()['ownerEmail'], 'new@example.test')
        self.assertNotIn('emailOperation', self.table.get_item(Key=ownership_guard.key(SUB))['Item'])
        complete = self.table.get_item(Key=user_email_update._key('UPDATE', SUB))['Item']['payload']
        self.assertFalse({'oldEmail', 'newEmail', 'username'} & complete.keys())
        self.assertEqual(user_email_update.resume(self.table, client, 'pool', SUB, CONTEXT),36)
        client.admin_update_user_attributes.assert_called_once()

    def test_background_email_continuation_refuses_a_newly_protected_admin(self):
        from auth_helpers import AuthError
        client, email, identity = self.identity()
        with patch.object(user_email_update, 'cognito_identity', side_effect=identity), patch.object(user_email_update, 'assert_admin_target_mutable') as authorize:
            short = SimpleNamespace(get_remaining_time_in_millis=lambda:5000)
            self.assertIsNone(user_email_update.update(self.table, client, 'pool', 'old@example.test', 'new@example.test', {'userId':SUB}, {}, short))
            client.admin_list_groups_for_user.return_value = {'Groups':[{'GroupName':'Admins'}]}
            with self.assertRaises(AuthError): user_email_update.resume(self.table, client, 'pool', SUB, CONTEXT)
            authorize.assert_called_once()
        client.admin_update_user_attributes.assert_not_called()

    def test_album_count_survives_cdn_wait_and_completion_receipt(self):
        self.object(RAW); self.object(THUMB)
        with patch.object(cleanup_work, 'advance_media_revocation', side_effect=[False, True]):
            self.assertEqual(delete_album.handler(self.event({}), CONTEXT)['statusCode'], 202)
            result = delete_album.handler(self.event({}), CONTEXT)
        self.assertEqual(result['statusCode'], 200, result)
        value = json.loads(result['body'])
        self.assertEqual(value['deletedObjectVersions'], 2)
        self.assertTrue(value['deletedObjectVersionsExact'])
        receipt = self.table.get_item(Key=cleanup_work.completion_key(ALBUM))['Item']['payload']
        self.assertEqual(receipt['deletedVersions'], 2)

    def test_late_upload_during_cdn_wait_is_drained_without_losing_previous_counts(self):
        self.object(RAW)
        with patch.object(cleanup_work, 'advance_media_revocation', side_effect=[False, True]):
            self.assertEqual(delete_album.handler(self.event({}), CONTEXT)['statusCode'], 202)
            self.object(THUMB)
            result = delete_album.handler(self.event({}), CONTEXT)
        self.assertEqual(json.loads(result['body'])['deletedObjectVersions'],2)
        self.assertEqual(self.s3.list_objects_v2(Bucket='images-test')['KeyCount'],0)

    def test_media_count_survives_cdn_wait_and_duplicate_request(self):
        self.object(RAW); self.object(THUMB)
        with patch.object(cleanup_work, 'advance_media_revocation', side_effect=[False, True]):
            self.assertEqual(delete_images.handler(self.event({'keys':[RAW]}), CONTEXT)['statusCode'], 202)
            result = delete_images.handler(self.event({'keys':[RAW]}), CONTEXT)
        self.assertEqual(json.loads(result['body'])['deletedObjectVersions'], 2)
        repeat = delete_images.handler(self.event({'keys':[RAW]}), CONTEXT)
        self.assertEqual(json.loads(repeat['body'])['deletedObjectVersions'], 2)

    def test_lost_provider_reply_never_claims_exact_count_or_double_counts(self):
        pending = {'countExact':True}
        durable = {}
        def save(): durable.update(deepcopy(pending))
        with self.assertRaises(RuntimeError):
            cleanup_work.counted_step(pending, save, 'objects', Mock(side_effect=RuntimeError('lost reply')))
        cleanup_work.counted_step(pending, save, 'objects', lambda: 0)
        self.assertFalse(pending['countExact'])
        cleanup_work.counted_step(pending, save, 'objects', lambda: 0)
        self.assertEqual(pending['deletedVersions'], 0)

    def comparisons(self):
        db = boto3.resource('dynamodb')
        table = db.create_table(TableName='comparison-test', KeySchema=[{'AttributeName':'albumId','KeyType':'HASH'}, {'AttributeName':'mediaId','KeyType':'RANGE'}], AttributeDefinitions=[{'AttributeName':'albumId','AttributeType':'S'}, {'AttributeName':'mediaId','AttributeType':'S'}], BillingMode='PAY_PER_REQUEST')
        self.s3.create_bucket(Bucket='comparison-preview-test', CreateBucketConfiguration={'LocationConstraint':'us-west-2'})
        self.stack.enter_context(patch.dict('os.environ', {'ORIGINAL_COMPARISON_TABLE':'comparison-test','ORIGINAL_PREVIEW_BUCKET':'comparison-preview-test'}))
        return table

    def test_comparison_cleanup_waits_for_old_worker_then_removes_only_generated_scope(self):
        table = self.comparisons()
        media_id = media_access.media_id_for_key(RAW)
        key = {'albumId':ALBUM, 'mediaId':media_id}
        table.put_item(Item={**key,'leaseUntil':int(time.time())+360})
        generated = f'before/{ALBUM}/{media_id}/'+'a'*32+'/w640.webp'
        for path in [generated, 'index/keep.json.gz', 'before/another-album/keep.webp']:
            self.s3.put_object(Bucket='comparison-preview-test', Key=path, Body=b'fixture')
        self.assertFalse(comparison_cleanup.clean(ALBUM))
        table.update_item(Key=key, UpdateExpression='REMOVE leaseUntil')
        self.assertTrue(comparison_cleanup.clean(ALBUM))
        keys = [item['Key'] for item in self.s3.list_objects_v2(Bucket='comparison-preview-test')['Contents']]
        self.assertEqual(keys, ['before/another-album/keep.webp','index/keep.json.gz'])
        self.assertNotIn('Item', table.get_item(Key=key))

    def test_comparison_media_cleanup_advances_past_first_25_targets(self):
        self.comparisons()
        pending = {}
        ids = [f'{i:024x}' for i in range(30)]
        self.assertFalse(comparison_cleanup.clean(ALBUM, ids, pending, lambda: None))
        self.assertTrue(comparison_cleanup.clean(ALBUM, ids, pending, lambda: None))
        self.assertEqual(len(pending['comparisonCleaned']),30)
