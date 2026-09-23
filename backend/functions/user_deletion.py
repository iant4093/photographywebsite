"""Resumable account erasure, fenced against new ownership assignments."""
import time
import uuid

from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError
import cleanup_work
import ownership_guard
from delete_album import delete_album_record, DeletionPending, DeletionConflict
from deletion_helpers import preflight_deletion, DeletionTooLargeError, sync_delete_limit
from drive_backup_jobs import DriveBackupBusy
from media_access import album_media_prefixes
from media_mutation import MediaMutationBusy
from owner_helpers import groups_for_user
from validation_helpers import validate_uuid
from visibility_change import enqueue


def owns(album, pending):
    return bool(album and (album.get('ownerSub') == pending['subject'] or
        ('ownerSub' not in album and album.get('ownerEmail') == pending['email'])))


def begin(table, subject, username, email, event):
    receipt_key = ownership_guard.key(subject)
    current = table.get_item(Key=receipt_key, ConsistentRead=True).get('Item', {})
    if current.get('deletionId'):
        return current
    now = int(time.time())
    operation = uuid.uuid4().hex
    pending = {'id':operation, 'subject':subject, 'username':username, 'email':email,
        'phase':'scan', 'albumIds':[], 'position':0, 'versionCount':0, 'prefixCount':0,
        'deletedAlbums':0, 'deletedVersions':0, 'countExact':True, 'audit':cleanup_work.audit_context(event),
        # Let any invocations of a preceding release finish before relying on
        # the ownership fence during a rolling backend deployment.
        'notBefore':now+60}
    try:
        table.update_item(Key=receipt_key,
            UpdateExpression='SET #status = :internal, deletionId = :id, payload = :pending',
            ConditionExpression='attribute_not_exists(deletionId) AND attribute_not_exists(emailOperation) AND (attribute_not_exists(identityLeaseUntil) OR identityLeaseUntil < :now)',
            ExpressionAttributeNames={'#status':'status'},
            ExpressionAttributeValues={':internal':'internal', ':id':operation, ':pending':pending, ':now':now})
    except ClientError as error:
        if error.response['Error']['Code'] != 'ConditionalCheckFailedException':
            raise
        raise MediaMutationBusy('The account is being updated. Please retry shortly.') from None
    return {**receipt_key, 'deletionId':operation, 'payload':pending}


def advance(table, cognito, pool, subject, context):
    receipt_key = ownership_guard.key(subject)
    record = table.get_item(Key=receipt_key, ConsistentRead=True).get('Item')
    if not record or not record.get('deletionId'):
        return True
    pending = record['payload']
    if pending['phase'] == 'complete':
        return True
    now = int(time.time())
    owner = uuid.uuid4().hex
    remaining = getattr(context, 'get_remaining_time_in_millis', None)
    duration = max(60, int(remaining()/1000)+60) if callable(remaining) else 960
    try:
        table.update_item(Key=receipt_key,
            UpdateExpression='SET deletionLeaseOwner = :owner, deletionLeaseUntil = :until',
            ConditionExpression='deletionId = :id AND (attribute_not_exists(deletionLeaseUntil) OR deletionLeaseUntil < :now)',
            ExpressionAttributeValues={':id':record['deletionId'], ':owner':owner, ':until':now+duration, ':now':now})
    except ClientError as error:
        if error.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return False
        raise

    def save():
        table.update_item(Key=receipt_key, UpdateExpression='SET payload = :pending',
            ConditionExpression='deletionId = :id AND deletionLeaseOwner = :owner',
            ExpressionAttributeValues={':pending':pending, ':id':record['deletionId'], ':owner':owner})

    try:
        pending = table.get_item(Key=receipt_key, ConsistentRead=True)['Item']['payload']
        if pending['phase'] == 'complete':
            return True
        cleanup_work.schedule(subject, pending, save, 'user-deletion', 30)
        if now < int(pending.get('notBefore', 0)):
            return False
        try:
            identity = cognito.admin_get_user(UserPoolId=pool, Username=pending['username'])
            attrs = {item['Name']:item['Value'] for item in identity.get('UserAttributes', [])}
            if attrs.get('sub') != subject or 'Admins' in groups_for_user(cognito, pool, pending['username']):
                raise RuntimeError('Account identity or protected status changed')
        except cognito.exceptions.UserNotFoundException:
            # A lost AdminDeleteUser reply is safe to resume by stable subject.
            if pending['phase'] != 'identity':
                raise

        for _ in range(8):
            if callable(remaining) and remaining() < 12000:
                return False
            phase = pending['phase']
            if phase in {'scan', 'verify'}:
                params = {'ConsistentRead':True, 'Limit':100,
                    'ProjectionExpression':'albumId',
                    'FilterExpression':Attr('ownerSub').eq(subject) | (Attr('ownerSub').not_exists() & Attr('ownerEmail').eq(pending['email']))}
                if pending.get('cursor'):
                    params['ExclusiveStartKey'] = pending['cursor']
                page = table.scan(**params)
                pending['albumIds'] = sorted(set(pending['albumIds']) | {validate_uuid(item['albumId']) for item in page.get('Items', [])})
                if len(pending['albumIds']) > 250:
                    raise DeletionTooLargeError('Account has too many albums for automatic deletion')
                if page.get('LastEvaluatedKey'):
                    pending['cursor'] = page['LastEvaluatedKey']
                else:
                    pending.pop('cursor', None)
                    pending.update(phase='identity' if phase == 'verify' and not pending['albumIds'] else 'preflight', position=0)
                save()
                continue
            if phase in {'preflight', 'delete'}:
                position = int(pending['position'])
                if position >= len(pending['albumIds']):
                    if phase == 'preflight':
                        pending.update(phase='delete', position=0)
                    else:
                        pending.update(phase='verify', position=0, albumIds=[], versionCount=0, prefixCount=0)
                    save()
                    continue
                album_id = pending['albumIds'][position]
                album = table.get_item(Key={'albumId':album_id}, ConsistentRead=True).get('Item')
                if owns(album, pending):
                    if phase == 'preflight':
                        prefixes = (*album_media_prefixes(album), f'temp-zips/{album_id}/', f'album-zips/{album_id}/')
                        count = preflight_deletion(prefixes=prefixes, max_versions=sync_delete_limit()-int(pending['versionCount']))
                        pending['versionCount'] += count
                        pending['prefixCount'] += len(prefixes)
                        if pending['versionCount'] > sync_delete_limit() or pending['prefixCount'] > 500:
                            raise DeletionTooLargeError('Account cleanup exceeds the synchronous safety limit')
                    else:
                        if album.get('status') == 'updating':
                            enqueue(album_id, 'album-visibility', delay=15)
                            return False
                        pending['inProgressAlbum'] = album_id
                        pending.setdefault('inProgressOperation', album.get('deletionId') or uuid.uuid4().hex)
                        save()
                        try:
                            delete_album_record(album, context, allow_pending=True, audit=pending['audit'], operation_id=pending['inProgressOperation'])
                        except (DeletionPending, DeletionConflict, DriveBackupBusy):
                            return False
                        pending['deletedAlbums'] += 1
                elif phase == 'delete' and not album and pending.get('inProgressAlbum') == album_id:
                    pending['deletedAlbums'] += 1
                if phase == 'delete' and pending.get('inProgressAlbum') == album_id:
                    receipt = table.get_item(Key=cleanup_work.completion_key(album_id), ConsistentRead=True).get('Item', {}).get('payload', {})
                    if receipt.get('id') == pending.get('inProgressOperation'):
                        pending['deletedVersions'] += int(receipt.get('deletedVersions', 0))
                        pending['countExact'] = pending.get('countExact', False) and receipt.get('countExact', False)
                    else:
                        pending['countExact'] = False
                pending.pop('inProgressOperation', None)
                pending.pop('inProgressAlbum', None)
                pending['position'] = position+1
                save()
                continue
            if phase == 'identity':
                try:
                    cognito.admin_delete_user(UserPoolId=pool, Username=pending['username'])
                except cognito.exceptions.UserNotFoundException:
                    pass
                cleanup_work.complete_audit(pending, save, 'user', {'album_count':int(pending['deletedAlbums']),
                    'deleted_version_count':int(pending['deletedVersions']),
                    'count_accuracy':'exact' if pending.get('countExact', False) else 'lower_bound'})
                pending['phase'] = 'complete'
                # Keep the subject fence permanently, without retaining the
                # deleted user's email or provider username after completion.
                pending.pop('email', None)
                pending.pop('username', None)
                save()
                return True
            raise RuntimeError('Unknown account deletion phase')
        return False
    except DeletionTooLargeError:
        if pending['phase'] in {'scan', 'preflight'} and not pending['deletedAlbums']:
            # Preflight has not erased anything; release the subject fence so
            # rejecting an oversized cascade cannot freeze the account.
            table.update_item(Key=receipt_key, UpdateExpression='REMOVE deletionId, payload',
                ConditionExpression='deletionId = :id AND deletionLeaseOwner = :owner',
                ExpressionAttributeValues={':id':record['deletionId'], ':owner':owner})
        raise
    finally:
        table.update_item(Key=receipt_key, UpdateExpression='REMOVE deletionLeaseOwner, deletionLeaseUntil',
            ConditionExpression='deletionLeaseOwner = :owner', ExpressionAttributeValues={':owner':owner})
