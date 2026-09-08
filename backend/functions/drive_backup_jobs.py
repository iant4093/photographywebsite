"""Durable Drive intents committed atomically with album mutations.

Only confirmed backup links or an explicit upload opt-in can create work.
The table stream delivers job inserts; completed jobs expire, failed jobs stay
available for admin retry. No media bytes or credentials are stored here.
"""
import os
import time
import uuid

import boto3
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


def new_intent(album, removed_keys=()):
    table = state_table()
    job_id = 'job#' + uuid.uuid4().hex
    now = int(time.time())
    job = {'albumId': album['albumId'], 'entry': job_id, 'recordType': 'job',
           'status': 'pending', 'createdAt': now, 'removedKeys': sorted(set(removed_keys))}
    return job, [
        {'Put': {'TableName': table.name, 'Item': encode(job),
                 'ConditionExpression': 'attribute_not_exists(albumId)'}},
        {'Update': {'TableName': table.name, 'Key': encode({'albumId': album['albumId'], 'entry': 'state'}),
                    'UpdateExpression': 'SET #status = :queued, updatedAt = :now ADD pendingJobs :one',
                    'ConditionExpression': 'attribute_not_exists(retained) AND attribute_not_exists(retiring)',
                    'ExpressionAttributeNames': {'#status': 'status'},
                    'ExpressionAttributeValues': encode({':queued': 'queued', ':now': now, ':one': 1})}},
    ]


def update_album(table, album, *, removed_keys=(), **kwargs):
    if state_table() is None or not eligible(album):
        try:
            return table.update_item(**kwargs)
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
        transaction([{'Update': update}, *intent])
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
        # Insert a delivery record pointing to the original durable job. It
        # never increments pendingJobs or loses deletion intent.
        table.put_item(Item={'albumId': album['albumId'], 'entry': 'delivery#' + uuid.uuid4().hex,
                             'recordType': 'delivery', 'jobEntry': old_job['entry'],
                             'expiresAt': int(time.time()) + 7 * 86400})
    if not jobs:
        _, intent = new_intent(album)
        transaction([{'ConditionCheck': {'TableName': os.environ['ALBUMS_TABLE'],
                     'Key': encode({'albumId': album['albumId']}),
                     'ConditionExpression': 'attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status = :active)',
                     'ExpressionAttributeNames': {'#status': 'status'},
                     'ExpressionAttributeValues': encode({':active': 'active'})}}, *intent])
    return True


def claim(album_id, owner):
    table = state_table()
    now = int(time.time())
    try:
        table.update_item(Key={'albumId': album_id, 'entry': 'state'},
                          UpdateExpression='SET leaseOwner = :owner, leaseUntil = :until',
                          ConditionExpression='attribute_not_exists(retained) AND attribute_not_exists(retiring) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
                          ExpressionAttributeValues={':owner': owner, ':until': now + 960, ':now': now})
        return True
    except ClientError as error:
        if error.response['Error']['Code'] == 'ConditionalCheckFailedException':
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
        try:
            transaction([
                {'Update': {'TableName': table.name, 'Key': encode({'albumId': job['albumId'], 'entry': job['entry']}),
                            'UpdateExpression': 'SET #status = :done, expiresAt = :ttl',
                            'ConditionExpression': '#status <> :done',
                            'ExpressionAttributeNames': {'#status': 'status'},
                            'ExpressionAttributeValues': encode({':done': 'done', ':ttl': now + 7 * 86400})}},
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
            if current.get('status') == 'done':
                return
    raise RuntimeError('Backup completion conflicted')


def fail(job):
    table = state_table()
    table.update_item(Key={'albumId': job['albumId'], 'entry': job['entry']},
                      UpdateExpression='SET #status = :failed', ExpressionAttributeNames={'#status': 'status'},
                      ExpressionAttributeValues={':failed': 'failed'})
    table.update_item(Key={'albumId': job['albumId'], 'entry': 'state'},
                      UpdateExpression='SET #status = :failed, errorCode = :code',
                      ExpressionAttributeNames={'#status': 'status'},
                      ExpressionAttributeValues={':failed': 'failed', ':code': 'drive_sync_failed'})


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
