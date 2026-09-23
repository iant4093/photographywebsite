import os
import time
import unittest
from unittest.mock import patch
import boto3
from boto3.dynamodb.conditions import Key
import test_publication_recovery as fixture
import drive_backup_jobs as jobs
import drive_backup_reconcile as worker


class RetryAttemptsTests(unittest.TestCase):
    put = fixture.PublicationRecoveryTests.put

    def setUp(self):
        fixture.PublicationRecoveryTests.setUp(self)
        self.state = boto3.resource('dynamodb').create_table(TableName='backup-attempts',
            KeySchema=[{'AttributeName':'albumId','KeyType':'HASH'}, {'AttributeName':'entry','KeyType':'RANGE'}],
            AttributeDefinitions=[{'AttributeName':'albumId','AttributeType':'S'}, {'AttributeName':'entry','AttributeType':'S'}], BillingMode='PAY_PER_REQUEST')
        self.stack.enter_context(patch.dict(os.environ, {'DRIVE_BACKUP_STATE_TABLE':'backup-attempts'}))
        self.record = {**fixture.RECORD, 'backupToGoogleDrive':True}
        self.put(self.record)
        self.job = {'albumId':fixture.ALBUM, 'entry':'job#'+'a'*32, 'recordType':'job', 'status':'failed',
            'createdAt':int(time.time())-90000, 'removedKeys':[fixture.RAW]}
        self.state.put_item(Item=self.job)
        self.state.put_item(Item={'albumId':fixture.ALBUM, 'entry':'state', 'status':'failed', 'pendingJobs':1})

    def read(self, entry=None):
        return self.state.get_item(Key={'albumId':fixture.ALBUM, 'entry':entry or self.job['entry']}, ConsistentRead=True)['Item']

    def test_retry_old_job_gets_fresh_window_and_preserves_exact_intent_and_counter(self):
        jobs.enqueue_retry(self.record)
        current = self.read()
        self.assertEqual(current['createdAt'], self.job['createdAt'])
        self.assertEqual(current['removedKeys'], self.job['removedKeys'])
        self.assertEqual(self.read('state')['pendingJobs'], 1)
        with patch.object(worker, 'live_album', return_value=self.record), patch.object(worker, 'reconcile', side_effect=worker.BackupContinuation('budget')), patch('cache_invalidation._queue_client', self.queue):
            worker.process(fixture.ALBUM, self.job['entry'], fixture.CONTEXT)
        self.assertEqual(self.read()['status'], 'pending')
        self.assertGreater(self.read()['deferredUntil'], time.time())
        self.queue.return_value.send_message.assert_called_once()

    def test_old_delivery_cannot_fail_complete_or_defer_new_attempt(self):
        jobs.enqueue_retry(self.record)
        before = self.read()
        jobs.fail(self.job)
        jobs.complete(self.job)
        with patch('cache_invalidation._queue_client', self.queue): jobs.defer(self.job)
        self.assertEqual(self.read(), before)
        self.assertEqual(self.read('state')['pendingJobs'], 1)
        self.queue.return_value.send_message.assert_not_called()
        self.assertFalse(jobs.claim(fixture.ALBUM, 'old-worker', job=self.job))
        self.assertTrue(jobs.claim(fixture.ALBUM, 'new-worker', job=before))

    def test_running_attempt_prevents_reset_and_duplicate_retry_clicks_share_delivery(self):
        self.assertTrue(jobs.claim(fixture.ALBUM, 'worker', job=self.job))
        with self.assertRaises(jobs.DriveBackupBusy): jobs.enqueue_retry(self.record)
        self.assertEqual(self.read(), self.job)
        jobs.release(fixture.ALBUM, 'worker')
        jobs.enqueue_retry(self.record)
        before = self.read()
        jobs.enqueue_retry(self.record)
        self.assertEqual(before, self.read())
        deliveries = self.state.query(KeyConditionExpression=Key('albumId').eq(fixture.ALBUM) & Key('entry').begins_with('delivery#'))['Items']
        self.assertEqual(len(deliveries), 1)

    def test_completed_attempt_cannot_be_failed_by_a_late_error(self):
        jobs.enqueue_retry(self.record)
        current = self.read()
        jobs.complete(current)
        jobs.fail(current)
        self.assertEqual(self.read()['status'], 'done')
        self.assertEqual(self.read('state')['pendingJobs'], 0)
        self.assertEqual(self.read('state')['status'], 'synced')

    def test_attempt_still_expires_without_unlimited_automatic_retries(self):
        jobs.enqueue_retry(self.record)
        current = self.read()
        with patch.object(jobs.time, 'time', return_value=int(current['attemptStartedAt'])+86400):
            with self.assertRaises(jobs.DriveBackupBusy): jobs.defer(current)
        self.assertEqual(self.read()['status'], 'failed')
