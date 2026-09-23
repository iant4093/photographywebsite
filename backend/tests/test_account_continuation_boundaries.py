"""Crash/lease/rejection regressions using local AWS emulation only."""
import io
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import test_support
import boto3
import test_publication_recovery as baseline
from test_publication_recovery import SUB, CONTEXT
import cleanup_work, user_email_update, user_deletion, ownership_guard
import edit_user, delete_user, cache_invalidation_worker


class AccountContinuationBoundariesTests(unittest.TestCase):
    setUp = baseline.PublicationRecoveryTests.setUp
    put = baseline.PublicationRecoveryTests.put

    def client(self):
        client = Mock()
        client.exceptions = boto3.client('cognito-idp').exceptions
        client.admin_list_groups_for_user.return_value = {'Groups':[]}
        client.admin_get_user.return_value = {'UserAttributes':[{'Name':'sub','Value':SUB}, {'Name':'email','Value':'old@example.test'}]}
        return client

    def email_fixture(self):
        client = self.client()
        self.stack.enter_context(patch.object(user_email_update, 'cognito_identity', return_value=('stable', SUB, {'email':'old@example.test'})))
        self.stack.enter_context(patch.object(user_email_update, 'assert_admin_target_mutable'))
        clock = self.stack.enter_context(patch.object(cleanup_work.time, 'time', return_value=1000))
        return client, clock

    def update(self, client, context=CONTEXT):
        return user_email_update.update(self.table, client, 'pool', 'old@example.test', 'taken@example.test', {'userId':SUB}, {}, context)

    def reject(self, client):
        client.admin_update_user_attributes.side_effect = client.exceptions.AliasExistsException({'Error':{'Code':'AliasExistsException'}}, 'AdminUpdateUserAttributes')
        with self.assertRaises(client.exceptions.AliasExistsException): self.update(client)

    def receipt(self):
        return self.table.get_item(Key=user_email_update._key('UPDATE', SUB))['Item']['payload']

    def test_rejected_deliveries_are_terminal_even_after_original_retry_window(self):
        client, clock = self.email_fixture(); self.reject(client)
        original = self.receipt()
        self.assertEqual(original['phase'], 'rejected')
        for field in ('oldEmail', 'newEmail', 'username', 'page', 'cursor'): self.assertNotIn(field, original)
        sends = self.queue.return_value.send_message.call_count
        for now in (1031, 91000, 92000):
            clock.return_value = now
            self.assertEqual(user_email_update.resume(self.table, client, 'pool', SUB, CONTEXT), 0)
            self.assertEqual(self.receipt(), original)
        client.admin_update_user_attributes.assert_called_once()
        self.assertEqual(self.queue.return_value.send_message.call_count, sends)
        self.assertNotIn('emailOperation', self.table.get_item(Key=ownership_guard.key(SUB))['Item'])

    def test_explicit_same_request_preserves_age_and_expired_request_stays_terminal(self):
        client, clock = self.email_fixture(); self.reject(client)
        clock.return_value = 2000
        self.reject(client)
        self.assertEqual(self.receipt()['continuationStartedAt'], 1000)
        clock.return_value = 91000
        with self.assertRaises(user_email_update.MediaMutationBusy): self.update(client)
        self.assertEqual(self.receipt()['phase'], 'rejected')
        self.assertEqual(client.admin_update_user_attributes.call_count, 2)
        self.assertNotIn('emailOperation', self.table.get_item(Key=ownership_guard.key(SUB))['Item'])

    def test_old_rejected_receipt_is_scrubbed_without_repeating_provider_intent(self):
        client, _ = self.email_fixture(); self.reject(client)
        pending = {**self.receipt(), 'oldEmail':'old@example.test', 'newEmail':'taken@example.test', 'username':'stable'}
        self.table.update_item(Key=user_email_update._key('UPDATE', SUB), UpdateExpression='SET payload = :p', ExpressionAttributeValues={':p':pending})
        user_email_update.resume(self.table, client, 'pool', SUB, CONTEXT)
        self.assertNotIn('oldEmail', self.receipt())
        client.admin_update_user_attributes.assert_called_once()

    def dispatch(self, kind, module, client):
        def invoke(**request):
            result = module.handler(json.loads(request['Payload']), CONTEXT)
            return {'Payload':io.BytesIO(json.dumps(result).encode())}
        with patch.object(module, 'table', self.table), patch.object(module, 'cognito', client), patch.dict(os.environ, {cache_invalidation_worker.WORKERS[kind]:'synthetic'}), patch.object(cache_invalidation_worker.boto3.session, 'Session') as session:
            session.return_value.client.return_value.invoke.side_effect = invoke
            return cache_invalidation_worker.handler({'Records':[{'messageId':'delivery', 'body':json.dumps({'version':1, 'kind':kind, 'albumId':SUB})}]}, CONTEXT)

    def test_email_busy_delivery_retries_then_completes_after_crash_lease_expires(self):
        client, clock = self.email_fixture()
        self.update(client, SimpleNamespace(get_remaining_time_in_millis=lambda:5000))
        self.table.update_item(Key=ownership_guard.key(SUB), UpdateExpression='SET identityLeaseOwner = :o, identityLeaseUntil = :t', ExpressionAttributeValues={':o':'crashed', ':t':1120})
        clock.return_value = 1031
        sends = self.queue.return_value.send_message.call_count
        self.assertEqual(self.dispatch('user-email-update', edit_user, client)['batchItemFailures'], [{'itemIdentifier':'delivery'}])
        self.assertEqual(self.queue.return_value.send_message.call_count, sends)
        clock.return_value = 1121
        self.assertEqual(self.dispatch('user-email-update', edit_user, client)['batchItemFailures'], [])
        self.assertEqual(self.receipt()['phase'], 'complete')
        self.assertEqual(self.dispatch('user-email-update', edit_user, client)['batchItemFailures'], [])
        client.admin_update_user_attributes.assert_called_once()

    def test_deletion_busy_delivery_retries_then_completes_after_crash_lease_expires(self):
        client = self.client()
        with patch.object(cleanup_work.time, 'time', return_value=1000) as clock:
            user_deletion.begin(self.table, SUB, 'stable', 'old@example.test', {})
            self.assertFalse(user_deletion.advance(self.table, client, 'pool', SUB, CONTEXT))
            self.table.update_item(Key=ownership_guard.key(SUB), UpdateExpression='SET deletionLeaseOwner = :o, deletionLeaseUntil = :t', ExpressionAttributeValues={':o':'crashed', ':t':1120})
            sends = self.queue.return_value.send_message.call_count
            clock.return_value = 1031
            self.assertEqual(self.dispatch('user-deletion', delete_user, client)['batchItemFailures'], [{'itemIdentifier':'delivery'}])
            self.assertEqual(self.queue.return_value.send_message.call_count, sends)
            clock.return_value = 1121
            self.assertEqual(self.dispatch('user-deletion', delete_user, client)['batchItemFailures'], [])
            self.assertEqual(self.table.get_item(Key=ownership_guard.key(SUB))['Item']['payload']['phase'], 'complete')
            self.assertEqual(self.dispatch('user-deletion', delete_user, client)['batchItemFailures'], [])
        client.admin_delete_user.assert_called_once()

    def test_failed_first_send_is_visible_and_reviewed_repair_preserves_original_deadline(self):
        import sys
        from pathlib import Path
        self.enterContext(patch.object(sys, 'path', [str(Path(__file__).resolve().parents[2]), *sys.path]))
        from ops.reconcile_durable_work import describe, fingerprint, repair
        client,clock=self.email_fixture()
        self.queue.return_value.send_message.side_effect=RuntimeError('synthetic queue outage')
        with self.assertRaises(RuntimeError):self.update(client)
        row=self.table.get_item(Key=user_email_update._key('UPDATE',SUB))['Item']
        self.assertEqual(row['payload']['continuationStartedAt'],1000)
        self.assertNotIn('scheduledUntil',row['payload'])
        self.assertNotIn('identityLeaseUntil',self.table.get_item(Key=ownership_guard.key(SUB))['Item'])
        self.assertEqual(describe(row,1030),[])
        self.assertEqual(describe(row,1061)[0]['reason'],'never_dispatched')
        self.queue.return_value.send_message.side_effect=None
        clock.return_value=1061
        result=repair(self.table,self.queue.return_value,'queue',row['albumId'],row['payload']['operation'],fingerprint(row),cognito=client,pool='pool',apply=True,now=1061)
        self.assertTrue(result['applied'])
        self.assertEqual(self.receipt()['continuationStartedAt'],1000)
        user_email_update.resume(self.table,client,'pool',SUB,CONTEXT)
        self.assertEqual(self.receipt()['phase'],'complete')
        client.admin_update_user_attributes.assert_called_once()
