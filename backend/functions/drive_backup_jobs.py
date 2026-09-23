"""Durable Drive intents committed atomically with album mutations.

Only confirmed backup links or an explicit upload opt-in can create work.
The table stream delivers job inserts; completed jobs expire, failed jobs stay
available for admin retry. No media bytes or credentials are stored here.
"""
import os
import json
import time
import uuid

import boto3
import ownership_guard
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError


class DriveBackupBusy(Exception):
    pass


def state_table():
    name = os.environ.get('DRIVE_BACKUP_STATE_TABLE', '').strip()
    return boto3.resource('dynamodb').Table(name) if name else None


def eligible(album):
    return album.get('backupToGoogleDrive') is True or bool(album.get('driveFolderId'))


def encode(values):
    serializer = TypeSerializer()
    return {key: serializer.serialize(value) for key, value in values.items()}


def transaction(items):
    return boto3.client('dynamodb').transact_write_items(TransactItems=items)


def attempt_condition(job, values):
    if job.get('attemptId'):
        values[':attempt'] = job['attemptId']
        return 'attemptId = :attempt'
    return 'attribute_not_exists(attemptId)'


def current_attempt(table, job):
    current = table.get_item(Key={'albumId': job['albumId'], 'entry': job['entry']}, ConsistentRead=True).get('Item', {})
    return bool(current and current.get('status') != 'done' and current.get('attemptId') == job.get('attemptId'))


def new_intent(album, removed_keys=()):
    table = state_table()
    job_id = 'job#' + uuid.uuid4().hex
    now = int(time.time())
    job = {'albumId': album['albumId'], 'entry': job_id, 'recordType': 'job',
           'status': 'pending', 'createdAt': now, 'attemptStartedAt': now, 'attemptId': uuid.uuid4().hex,
           'removedKeys': sorted(set(removed_keys))}
    return job, [
        {'Put': {'TableName': table.name, 'Item': encode(job),
                 'ConditionExpression': 'attribute_not_exists(albumId)'}},
        {'Update': {'TableName': table.name, 'Key': encode({'albumId': album['albumId'], 'entry': 'state'}),
                    'UpdateExpression': 'SET #status = :queued, updatedAt = :now ADD pendingJobs :one',
                    'ConditionExpression': 'attribute_not_exists(retained) AND attribute_not_exists(retiring)',
                    'ExpressionAttributeNames': {'#status': 'status'},
                    'ExpressionAttributeValues': encode({':queued': 'queued', ':now': now, ':one': 1})}},
    ]


def update_album(table, album, *, removed_keys=(), owner_target=None, **kwargs):
    if state_table() is None or not eligible(album):
        try:
            return ownership_guard.write(table, 'Update', owner_target, **kwargs)
        except ClientError as error:
            if error.response['Error']['Code'] == 'ConditionalCheckFailedException':
                raise DriveBackupBusy('Album changed. Refresh and retry.') from None
            raise
    _, intent = new_intent(album, removed_keys)
    update = {key: value for key, value in kwargs.items() if key != 'ReturnValues'}
    update['TableName'] = table.name
    update['Key'] = encode(update['Key'])
    update['ExpressionAttributeValues'] = encode(update['ExpressionAttributeValues'])
    try:
        guard = [ownership_guard.condition(table, owner_target)] if owner_target else []
        transaction([{'Update': update}, *intent, *guard])
    except ClientError as error:
        if error.response['Error']['Code'] == 'TransactionCanceledException':
            raise DriveBackupBusy('Album changed or its backup is being retained. Please retry.') from None
        raise
    if kwargs.get('ReturnValues') == 'ALL_NEW':
        return {'Attributes': table.get_item(Key=kwargs['Key'], ConsistentRead=True).get('Item', album)}
    return {}


def enqueue_retry(album):
    table = state_table()
    if table is None or not eligible(album):
        return False
    # Redispatch retained failed/pending jobs, including their exact removals.
    jobs = []
    cursor = None
    while True:
        params = {'KeyConditionExpression': Key('albumId').eq(album['albumId']) & Key('entry').begins_with('job#'),
                  'ConsistentRead': True}
        if cursor:
            params['ExclusiveStartKey'] = cursor
        page = table.query(**params)
        jobs.extend(item for item in page.get('Items', []) if item.get('status') != 'done')
        cursor = page.get('LastEvaluatedKey')
        if not cursor:
            break
    for old_job in jobs:
        now = int(time.time())
        if old_job.get('status') == 'pending' and now - int(old_job.get('retryAcceptedAt', 0)) < 60:
            continue  # Repeated clicks share the already accepted attempt.
        values = {':pending': 'pending', ':done': 'done', ':newAttempt': uuid.uuid4().hex, ':now': now}
        condition = attempt_condition(old_job, values)
        try:
            transaction([
                {'ConditionCheck': {'TableName': os.environ['ALBUMS_TABLE'], 'Key': encode({'albumId': album['albumId']}),
                    'ConditionExpression': 'attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status = :active)',
                    'ExpressionAttributeNames': {'#status': 'status'}, 'ExpressionAttributeValues': encode({':active': 'active'})}},
                {'Update': {'TableName': table.name, 'Key': encode({'albumId': album['albumId'], 'entry': old_job['entry']}),
                    'UpdateExpression': 'SET #status = :pending, attemptId = :newAttempt, attemptStartedAt = :now, retryAcceptedAt = :now REMOVE deferredUntil, deferrals, expiresAt',
                    'ConditionExpression': 'attribute_exists(albumId) AND #status <> :done AND ' + condition,
                    'ExpressionAttributeNames': {'#status': 'status'}, 'ExpressionAttributeValues': encode(values)}},
                {'Update': {'TableName': table.name, 'Key': encode({'albumId': album['albumId'], 'entry': 'state'}),
                    'UpdateExpression': 'SET #status = :queued REMOVE errorCode',
                    'ConditionExpression': 'attribute_not_exists(retained) AND attribute_not_exists(retiring) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
                    'ExpressionAttributeNames': {'#status': 'status'}, 'ExpressionAttributeValues': encode({':queued':'queued', ':now':now})}},
                {'Put': {'TableName': table.name, 'Item': encode({'albumId': album['albumId'], 'entry': 'delivery#' + uuid.uuid4().hex,
                    'recordType': 'delivery', 'jobEntry': old_job['entry'], 'expiresAt': now + 7 * 86400})}},
            ])
        except ClientError as error:
            if error.response['Error']['Code'] != 'TransactionCanceledException':
                raise
            if current_attempt(table, old_job):
                raise DriveBackupBusy('Backup is running or the album changed. Retry shortly.') from None
    if not jobs:
        _, intent = new_intent(album)
        transaction([{'ConditionCheck': {'TableName': os.environ['ALBUMS_TABLE'],
                     'Key': encode({'albumId': album['albumId']}),
                     'ConditionExpression': 'attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status = :active)',
                     'ExpressionAttributeNames': {'#status': 'status'},
                     'ExpressionAttributeValues': encode({':active': 'active'})}}, *intent])
    return True


def claim(album_id, owner, job=None):
    table = state_table()
    now = int(time.time())
    try:
        update = dict(Key={'albumId': album_id, 'entry': 'state'},
                          UpdateExpression='SET leaseOwner = :owner, leaseUntil = :until',
                          ConditionExpression='attribute_not_exists(retained) AND attribute_not_exists(retiring) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
                          ExpressionAttributeValues={':owner': owner, ':until': now + 960, ':now': now})
        if job is None:
            table.update_item(**update)
        else:
            values = {':done': 'done'}
            condition = attempt_condition(job, values)
            update.update(TableName=table.name, Key=encode(update['Key']), ExpressionAttributeValues=encode(update['ExpressionAttributeValues']))
            transaction([{'ConditionCheck': {'TableName': table.name,
                'Key': encode({'albumId': album_id, 'entry': job['entry']}),
                'ConditionExpression': 'attribute_exists(albumId) AND #status <> :done AND ' + condition,
                'ExpressionAttributeNames': {'#status': 'status'}, 'ExpressionAttributeValues': encode(values)}}, {'Update': update}])
        return True
    except ClientError as error:
        if error.response['Error']['Code'] in {'ConditionalCheckFailedException', 'TransactionCanceledException'}:
            return False
        raise


def release(album_id, owner):
    try:
        state_table().update_item(Key={'albumId': album_id, 'entry': 'state'},
                                  UpdateExpression='REMOVE leaseOwner, leaseUntil',
                                  ConditionExpression='leaseOwner = :owner',
                                  ExpressionAttributeValues={':owner': owner})
    except ClientError as error:
        if error.response['Error']['Code'] != 'ConditionalCheckFailedException':
            raise


def complete(job, *, retained=False):
    table = state_table()
    for _ in range(5):
        state = table.get_item(Key={'albumId': job['albumId'], 'entry': 'state'}, ConsistentRead=True).get('Item', {})
        count = int(state.get('pendingJobs', 0))
        now = int(time.time())
        values = {':done': 'done', ':ttl': now + 7 * 86400}
        condition = attempt_condition(job, values)
        try:
            transaction([
                {'Update': {'TableName': table.name, 'Key': encode({'albumId': job['albumId'], 'entry': job['entry']}),
                            'UpdateExpression': 'SET #status = :done, expiresAt = :ttl',
                            'ConditionExpression': '#status <> :done AND ' + condition,
                            'ExpressionAttributeNames': {'#status': 'status'},
                            'ExpressionAttributeValues': encode(values)}},
                {'Update': {'TableName': table.name, 'Key': encode({'albumId': job['albumId'], 'entry': 'state'}),
                            'UpdateExpression': 'SET pendingJobs = :remaining, #status = :status, lastSyncedAt = :now REMOVE errorCode',
                            'ConditionExpression': 'pendingJobs = :count',
                            'ExpressionAttributeNames': {'#status': 'status'},
                            'ExpressionAttributeValues': encode({':remaining': max(0, count - 1), ':status': 'retained' if retained else ('queued' if count > 1 else 'synced'), ':now': now, ':count': count})}},
            ])
            return
        except ClientError as error:
            if error.response['Error']['Code'] != 'TransactionCanceledException':
                raise
            current = table.get_item(Key={'albumId': job['albumId'], 'entry': job['entry']}, ConsistentRead=True).get('Item', {})
            if current.get('status') == 'done' or current.get('attemptId') != job.get('attemptId'):
                return
    raise RuntimeError('Backup completion conflicted')


def fail(job):
    table = state_table()
    values = {':failed': 'failed', ':done': 'done'}
    condition = attempt_condition(job, values)
    try:
        transaction([
            {'Update': {'TableName': table.name, 'Key': encode({'albumId': job['albumId'], 'entry': job['entry']}),
                'UpdateExpression':'SET #status = :failed', 'ConditionExpression':'attribute_exists(albumId) AND #status <> :done AND ' + condition,
                'ExpressionAttributeNames':{'#status':'status'}, 'ExpressionAttributeValues':encode(values)}},
            {'Update': {'TableName': table.name, 'Key': encode({'albumId': job['albumId'], 'entry':'state'}),
                'UpdateExpression':'SET #status = :failed, errorCode = :code', 'ExpressionAttributeNames':{'#status':'status'},
                'ExpressionAttributeValues':encode({':failed':'failed', ':code':'drive_sync_failed'})}},
        ])
    except ClientError as error:
        if error.response['Error']['Code'] != 'TransactionCanceledException' or current_attempt(table, job):
            raise


def begin_retention(album):
    table = state_table()
    if table is None or not eligible(album):
        return False
    try:
        table.update_item(Key={'albumId': album['albumId'], 'entry': 'state'},
                          UpdateExpression='SET retiring = :yes',
                          ConditionExpression='attribute_not_exists(leaseUntil) OR leaseUntil < :now',
                          ExpressionAttributeValues={':yes': True, ':now': int(time.time())})
        return True
    except ClientError as error:
        if error.response['Error']['Code'] == 'ConditionalCheckFailedException':
            raise DriveBackupBusy('The Drive backup is syncing. Retry album deletion shortly; its backup will be kept.') from None
        raise


def end_retention(album_id, deleted):
    table = state_table()
    if deleted:
        table.update_item(Key={'albumId': album_id, 'entry': 'state'},
                          UpdateExpression='SET retained = :yes, #status = :retained REMOVE retiring',
                          ExpressionAttributeNames={'#status': 'status'},
                          ExpressionAttributeValues={':yes': True, ':retained': 'retained'})
    else:
        table.update_item(Key={'albumId': album_id, 'entry': 'state'}, UpdateExpression='REMOVE retiring')


def defer(job):
    """Keep the exact intent and retry temporary contention without a hot loop."""
    from cache_invalidation import _queue_client
    table = state_table()
    if not current_attempt(table, job):
        return
    now = int(time.time())
    if now - int(job.get('attemptStartedAt', job.get('createdAt', now))) >= 86400:
        fail(job)
        raise DriveBackupBusy('Backup needs an administrator retry')
    if int(job.get('deferredUntil', 0)) > now:
        return
    queue = os.environ.get('CACHE_INVALIDATION_QUEUE_URL', '').strip()
    if not queue:
        raise DriveBackupBusy('Backup continuation queue is unavailable')
    count = min(4, int(job.get('deferrals', 0)))
    delay = min(300, 30 * (2 ** count))
    # Dispatch first: a lost metadata write can only duplicate a safe delivery,
    # never record a retry that was not actually scheduled.
    _queue_client().send_message(QueueUrl=queue, DelaySeconds=delay, MessageBody=json.dumps({
        'version': 1, 'kind': 'album-drive-backup', 'albumId': job['albumId'], 'jobEntry': job['entry']}))
    values = {':until': now + delay, ':count': count + 1, ':done': 'done'}
    condition = attempt_condition(job, values)
    try:
        table.update_item(Key={'albumId': job['albumId'], 'entry': job['entry']},
            UpdateExpression='SET deferredUntil = :until, deferrals = :count',
            ConditionExpression='attribute_exists(albumId) AND #status <> :done AND ' + condition,
            ExpressionAttributeNames={'#status': 'status'}, ExpressionAttributeValues=values)
    except ClientError as error:
        if error.response['Error']['Code'] != 'ConditionalCheckFailedException':
            raise
