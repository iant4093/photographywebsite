import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
import test_publication_recovery as fixture
import user_deletion
import delete_user
import ownership_guard
import cleanup_work
import visibility_change
from media_mutation import MediaMutationBusy
from deletion_helpers import DeletionTooLargeError

SUB = fixture.SUB
OTHER = '33333333-3333-4333-8333-333333333333'


class AccountDeletionTests(unittest.TestCase):
    put = fixture.PublicationRecoveryTests.put
    album = fixture.PublicationRecoveryTests.album

    def setUp(self):
        fixture.PublicationRecoveryTests.setUp(self)
        self.record = {**fixture.RECORD, 'ownerSub':SUB, 'ownerEmail':'synthetic@example.invalid'}
        self.put(self.record)
        self.now = self.stack.enter_context(patch.object(user_deletion.time, 'time', return_value=1000))
        self.provider = Mock()
        self.provider.exceptions = SimpleNamespace(UserNotFoundException=type('UserNotFoundException', (Exception,), {}))
        self.provider.admin_get_user.return_value = {'UserAttributes':[{'Name':'sub','Value':SUB}]}
        self.provider.admin_list_groups_for_user.return_value = {'Groups':[]}
        self.stack.enter_context(patch('delete_album.request_public_api_invalidation', return_value=True))
        self.stack.enter_context(patch('delete_album.request_random_photo_pool_refresh', return_value=True))
        self.audit = self.stack.enter_context(patch.object(cleanup_work, 'emit_audit_event', return_value=True))
        self.event = {'requestContext':{'authorizer':{'jwt':{'claims':{'sub':OTHER,'cognito:groups':['Admins']}}}}}

    def begin(self):
        return user_deletion.begin(self.table, SUB, 'stable-username', self.record['ownerEmail'], self.event)

    def advance(self):
        return user_deletion.advance(self.table, self.provider, 'pool', SUB, fixture.CONTEXT)

    def finish(self):
        for _ in range(10):
            if self.advance(): return
            self.now.return_value += 31
        self.fail('Deletion did not complete')

    def test_index_omission_cannot_leave_owned_album_and_deletion_finishes_without_browser(self):
        with patch.object(self.table, 'query', return_value={'Items':[]}) as index:
            self.begin()
            self.assertFalse(self.advance())
            self.provider.admin_delete_user.assert_not_called()
            self.now.return_value = 1061
            self.finish()
            index.assert_not_called()
        self.assertIsNone(self.album())
        self.provider.admin_delete_user.assert_called_once_with(UserPoolId='pool', Username='stable-username')
        receipt = self.table.get_item(Key=ownership_guard.key(SUB))['Item']
        self.assertEqual(receipt['payload']['phase'], 'complete')
        self.assertNotIn('email', receipt['payload'])
        self.assertNotIn('username', receipt['payload'])
        self.assertTrue(self.advance())
        self.assertEqual(self.provider.admin_delete_user.call_count, 1)

    def test_fence_rejects_new_assignment_and_remains_after_identity_removal(self):
        self.begin()
        for complete in (False, True):
            if complete:
                self.now.return_value = 1061
                self.finish()
            with self.assertRaises(MediaMutationBusy):
                ownership_guard.write(self.table, 'Put', SUB, Item={'albumId':OTHER,'ownerSub':SUB})
            self.assertNotIn('Item', self.table.get_item(Key={'albumId':OTHER}))

    def test_private_transition_reserves_owner_in_visible_row_before_background_commit(self):
        original = {**fixture.RECORD}
        self.put(original)
        updated = {**original, 'visibility':'private', 'ownerSub':SUB, 'ownerEmail':self.record['ownerEmail']}
        pending = visibility_change.begin(self.table, original, updated, {'visibility':'private'}, {'visibility','ownerSub','ownerEmail'})
        self.assertEqual(self.album()['ownerSub'], SUB)
        self.begin()
        self.now.return_value = 1061
        self.assertFalse(self.advance())
        self.provider.admin_delete_user.assert_not_called()
        visibility_change.commit(self.table, self.album(), updated)
        self.finish()
        self.assertIsNone(self.album())
        self.assertEqual(pending['ownerSub'], SUB)

    def test_transferred_album_is_preserved_and_legacy_email_and_pending_upload_are_deleted(self):
        self.begin(); self.now.return_value = 1061
        def transfer(**_kwargs):
            self.table.update_item(Key={'albumId':fixture.ALBUM}, UpdateExpression='SET ownerSub = :other', ExpressionAttributeValues={':other':OTHER})
            return 0
        with patch.object(user_deletion, 'preflight_deletion', side_effect=transfer): self.finish()
        self.assertEqual(self.album()['ownerSub'], OTHER)

    def test_pending_legacy_album_can_be_erased_without_publishing_it(self):
        record = {**self.record, 'status':'pending'}
        record.pop('ownerSub')
        self.put(record)
        self.begin(); self.now.return_value = 1061
        self.finish()
        self.assertIsNone(self.album())

    def test_oversized_preflight_does_not_delete_or_permanently_freeze_account(self):
        self.begin(); self.now.return_value = 1061
        with patch.object(user_deletion, 'preflight_deletion', side_effect=DeletionTooLargeError()):
            with self.assertRaises(DeletionTooLargeError): self.advance()
        self.assertEqual(self.album()['ownerSub'], SUB)
        self.provider.admin_delete_user.assert_not_called()
        self.assertNotIn('deletionId', self.table.get_item(Key=ownership_guard.key(SUB))['Item'])

    def test_identity_update_and_deletion_exclude_each_other(self):
        with ownership_guard.identity_lease(self.table, SUB, fixture.CONTEXT):
            with self.assertRaises(MediaMutationBusy): self.begin()
        self.begin()
        with self.assertRaises(MediaMutationBusy):
            with ownership_guard.identity_lease(self.table, SUB, fixture.CONTEXT): pass

    def test_provider_failure_retains_receipt_and_protected_admin_is_not_erased(self):
        self.begin(); self.now.return_value = 1061
        self.provider.admin_list_groups_for_user.return_value = {'Groups':[{'GroupName':'Admins'}]}
        with self.assertRaises(RuntimeError): self.advance()
        self.assertIsNotNone(self.album())
        self.provider.admin_delete_user.assert_not_called()
        self.provider.admin_list_groups_for_user.return_value = {'Groups':[]}
        self.finish()

    def test_lost_identity_reply_and_failed_audit_recover_by_stable_subject(self):
        self.begin(); self.now.return_value = 1061
        self.audit.side_effect = lambda **values: values['resource_type'] != 'user'
        with self.assertRaisesRegex(RuntimeError, 'audit'): self.finish()
        self.assertIsNone(self.album())
        self.provider.admin_get_user.side_effect = self.provider.exceptions.UserNotFoundException()
        self.provider.admin_delete_user.side_effect = self.provider.exceptions.UserNotFoundException()
        self.audit.side_effect = None
        self.finish()
        events = [call.kwargs for call in self.audit.call_args_list if call.kwargs['resource_type']=='user']
        self.assertEqual(events[0]['event'], events[-1]['event'])
        self.assertEqual(events[-1]['actor_type'], 'admin')
        self.assertEqual(events[-1]['auth_method'], 'jwt')
        self.assertNotIn('claims', str(self.table.get_item(Key=ownership_guard.key(SUB))))

    def test_http_request_rejects_reused_email_with_different_selected_subject(self):
        import json
        event = {'pathParameters':{'email':self.record['ownerEmail']}, 'body':json.dumps({'userId':OTHER})}
        with patch.object(delete_user, 'verify_front_door_request', return_value=None), patch.object(delete_user, 'require_admin', return_value=None), \
             patch.object(delete_user, 'cognito', self.provider), patch.object(delete_user, 'table', self.table):
            self.assertEqual(delete_user.handler(event, fixture.CONTEXT)['statusCode'], 409)
        self.provider.admin_delete_user.assert_not_called()
        self.assertNotIn('Item', self.table.get_item(Key=ownership_guard.key(SUB)))

    def test_http_retry_after_worker_erases_identity_uses_saved_subject_receipt(self):
        import json
        self.begin(); self.now.return_value = 1061; self.finish()
        self.provider.admin_get_user.side_effect = self.provider.exceptions.UserNotFoundException()
        event = {'pathParameters':{'email':self.record['ownerEmail']}, 'body':json.dumps({'userId':SUB})}
        with patch.object(delete_user, 'verify_front_door_request', return_value=None), patch.object(delete_user, 'require_admin', return_value=None), \
             patch.object(delete_user, 'cognito', self.provider), patch.object(delete_user, 'table', self.table):
            result = delete_user.handler(event, fixture.CONTEXT)
        self.assertEqual(result['statusCode'], 200)
        self.assertEqual(json.loads(result['body'])['albumsDeleted'], 1)
        self.assertEqual(self.provider.admin_delete_user.call_count, 1)

    def test_authoritative_scan_resumes_across_empty_filtered_pages_and_invocations(self):
        # DynamoDB's Limit counts evaluated records, including other accounts.
        for index in range(810):
            self.put({'albumId':f'unrelated-{index:04}', 'status':'internal'})
        self.begin(); self.now.return_value = 1061
        with patch.object(self.table, 'scan', wraps=self.table.scan) as scan:
            self.assertFalse(self.advance())
            self.provider.admin_delete_user.assert_not_called()
            self.finish()
        self.assertTrue(any(call.kwargs.get('ExclusiveStartKey') for call in scan.call_args_list))
        self.assertTrue(all(call.kwargs['ConsistentRead'] for call in scan.call_args_list))
        self.assertIsNone(self.album())
        self.assertIn('Item', self.table.get_item(Key={'albumId':'unrelated-0000'}))

    def test_worker_maps_only_the_validated_subject_to_the_existing_handler(self):
        import io, json, os
        import cache_invalidation_worker
        stream = io.BytesIO(b'{"statusCode":202}')
        client = Mock(); client.invoke.return_value = {'Payload':stream}
        with patch.dict(os.environ, {'USER_DELETION_WORKER_FUNCTION_NAME':'existing-user-worker'}), \
             patch('boto3.session.Session.client', return_value=client):
            cache_invalidation_worker._continue_album_work({'kind':'user-deletion', 'albumId':SUB, 'subject':OTHER})
        self.assertEqual(json.loads(client.invoke.call_args.kwargs['Payload']), {'source':'user-deletion', 'subject':SUB})
        self.assertEqual(client.invoke.call_args.kwargs['FunctionName'], 'existing-user-worker')
        self.assertTrue(stream.closed)
