"""Bounded, resumable Cognito/email synchronization on the existing album table."""
import hashlib
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError
from audit_helpers import emit_audit_event
import cleanup_work
import ownership_guard
from media_mutation import album_lease, MediaAlbumMissing, MediaMutationBusy
from owner_helpers import cognito_identity, assert_admin_target_mutable, groups_for_user
from auth_helpers import AuthError
from validation_helpers import require_string


def _key(kind, value):
    return {'albumId': f'__USER_EMAIL_{kind}__' + hashlib.sha256(value.encode()).hexdigest()}


def _conditional_failure(error):
    return isinstance(error, ClientError) and error.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException'


def _unfence(table, subject, operation):
    try:
        table.update_item(Key=ownership_guard.key(subject), UpdateExpression='REMOVE emailOperation',
            ConditionExpression='emailOperation = :op', ExpressionAttributeValues={':op':operation})
    except ClientError as error:
        if not _conditional_failure(error):
            raise


def _finish(table, key, subject, pending):
    updated = int(pending.get('updated', 0))
    if not pending.get('auditComplete'):
        actor = pending.get('audit', {'actor':'service', 'auth':'service'})
        emitted = emit_audit_event(event_name='admin.user_updated', outcome='success', action='user.email.update',
            resource_type='user', reason_code='user_updated', actor_type=actor['actor'], auth_method=actor['auth'],
            event={'requestContext':{'requestId':pending['operation']}}, details={'album_count':updated})
        if not emitted: raise RuntimeError('Account update audit requires another attempt')
        pending['auditComplete'] = True
        for field in ('oldEmail', 'newEmail', 'username'):
            pending.pop(field, None)
        table.update_item(Key=key, UpdateExpression='SET payload = :pending',
            ConditionExpression='payload.operation = :op', ExpressionAttributeValues={':pending':pending, ':op':pending['operation']})
    _unfence(table, subject, pending['operation'])
    return updated


def update(table, cognito, pool, old_email, new_email, body, event, context):
    user_id = body.get('userId')
    if user_id is not None:
        user_id = require_string(user_id, 'userId', maximum=128)
    alias = table.get_item(Key=_key('LOOKUP', old_email), ConsistentRead=True).get('Item', {}).get('payload', {})
    try:
        username, subject, _ = cognito_identity(cognito, pool, user_id or old_email)
    except cognito.exceptions.UserNotFoundException:
        if user_id or not alias.get('username'):
            raise
        username, subject, _ = cognito_identity(cognito, pool, alias['username'])
    if not subject:
        raise RuntimeError('Account has no stable subject')
    if not user_id and alias and alias.get('subject') != subject:
        raise MediaMutationBusy('The account changed. Reload the user list and retry.')
    operation = hashlib.sha256(f'{subject}\n{old_email}\n{new_email}'.encode()).hexdigest()
    return _advance(table, cognito, pool, subject, operation, context,
        request={'username':username, 'oldEmail':old_email, 'newEmail':new_email}, event=event)


def resume(table, cognito, pool, subject, context):
    pending = table.get_item(Key=_key('UPDATE', subject), ConsistentRead=True).get('Item', {}).get('payload')
    if not pending:
        return 0
    if pending.get('phase') == 'complete' and pending.get('auditComplete'):
        _unfence(table, subject, pending['operation'])
        return int(pending.get('updated', 0))
    if not pending.get('oldEmail') or not pending.get('newEmail'):
        # A preceding release's receipt requires its original authenticated retry.
        raise MediaMutationBusy('Retry the original account update to resume it.')
    return _advance(table, cognito, pool, subject, pending['operation'], context)


def _advance(table, cognito, pool, subject, operation, context, request=None, event=None):
    with ownership_guard.identity_lease(table, subject, context, email_operation=operation):
        key = _key('UPDATE', subject)
        pending = table.get_item(Key=key, ConsistentRead=True).get('Item', {}).get('payload', {})
        same = pending.get('operation') == operation
        if pending and pending.get('phase') not in {'complete', 'rejected'} and not same:
            raise MediaMutationBusy('The previous account update is still being completed.')
        identity = request or pending
        username, current_subject, attrs = cognito_identity(cognito, pool, identity['username'])
        if current_subject != subject:
            raise MediaMutationBusy('The account identity changed. Reload the user list.')
        if request is not None:
            assert_admin_target_mutable(event, cognito, pool, username, subject)
        elif 'Admins' in groups_for_user(cognito, pool, username):
            raise AuthError('Administrator accounts cannot be modified here', 403)
        old_email, new_email = identity['oldEmail'], identity['newEmail']
        current_email = str(attrs.get('email', '')).strip().lower()
        if current_email != old_email and not (same and current_email == new_email):
            raise MediaMutationBusy('The account email changed. Reload the user list and retry.')
        if same and pending.get('phase') == 'complete':
            return _finish(table, key, subject, pending)
        if not same or pending.get('phase') == 'rejected':
            pending = {'operation':operation, 'id':operation, 'subject':subject,
                'username':username, 'oldEmail':old_email, 'newEmail':new_email,
                'phase':'pin', 'position':0, 'updated':0, 'audit':cleanup_work.audit_context(event)}
        if pending['phase'] == 'pending':
            # Upgrade a legacy receipt using a fresh consistent scan. Pinning is
            # idempotent, including when Cognito already accepted the change.
            pending.update(phase='pin', position=0, updated=0, oldEmail=old_email, newEmail=new_email, id=operation)
            pending.pop('albumIds', None)
        def save():
            table.update_item(Key=key, UpdateExpression='SET #status = :internal, payload = :pending',
                ExpressionAttributeNames={'#status':'status'},
                ExpressionAttributeValues={':internal':'internal', ':pending':pending})
        save()
        # This durable fence remains between Lambda invocations. New ownership
        # assignments and account erasure must wait for synchronization.
        table.update_item(Key=ownership_guard.key(subject), UpdateExpression='SET emailOperation = :op',
            ConditionExpression='attribute_not_exists(deletionId)', ExpressionAttributeValues={':op':operation})
        table.update_item(Key=_key('LOOKUP', old_email), UpdateExpression='SET #status = :internal, payload = :payload',
            ExpressionAttributeNames={'#status':'status'}, ExpressionAttributeValues={':internal':'internal',
                ':payload':{'username':subject, 'subject':subject, 'operation':operation}})
        cleanup_work.schedule(subject, pending, save, 'user-email-update', 30)
        remaining = getattr(context, 'get_remaining_time_in_millis', None)
        for _ in range(32):
            if callable(remaining) and remaining() < 10000:
                return None
            phase = pending['phase']
            if phase in {'pin', 'sync'}:
                if 'page' not in pending:
                    args = {'ConsistentRead':True, 'Limit':25, 'ProjectionExpression':'albumId',
                        'FilterExpression':Attr('ownerSub').eq(subject) | (Attr('ownerSub').not_exists() & Attr('ownerEmail').eq(old_email))}
                    if pending.get('cursor'):
                        args['ExclusiveStartKey'] = pending['cursor']
                    page = table.scan(**args)
                    pending.update(page=[item['albumId'] for item in page.get('Items', [])], position=0,
                                   nextCursor=page.get('LastEvaluatedKey'))
                    save()
                position = int(pending['position'])
                if position >= len(pending['page']):
                    cursor = pending.pop('nextCursor', None)
                    pending.pop('page', None)
                    if cursor:
                        pending['cursor'] = cursor
                    else:
                        pending.pop('cursor', None)
                        pending['phase'] = 'provider' if phase == 'pin' else 'complete'
                    save()
                    continue
                album_id = pending['page'][position]
                try:
                    with album_lease(table, album_id, context):
                        if phase == 'pin':
                            table.update_item(Key={'albumId':album_id}, UpdateExpression='SET ownerSub = :subject',
                                ConditionExpression='attribute_exists(albumId) AND attribute_not_exists(ownerSub) AND ownerEmail = :oldEmail',
                                ExpressionAttributeValues={':subject':subject, ':oldEmail':old_email})
                        else:
                            table.update_item(Key={'albumId':album_id}, UpdateExpression='SET ownerEmail = :newEmail',
                                ConditionExpression='attribute_exists(albumId) AND ownerSub = :subject',
                                ExpressionAttributeValues={':subject':subject, ':newEmail':new_email})
                            # Position and count are committed together. Repeating
                            # an interrupted write does not increment twice.
                            pending['updated'] += 1
                except MediaAlbumMissing:
                    pass
                except ClientError as error:
                    if not _conditional_failure(error):
                        raise
                pending['position'] = position+1
                save()
                continue
            if phase == 'provider':
                if current_email != new_email:
                    try:
                        cognito.admin_update_user_attributes(UserPoolId=pool, Username=username, UserAttributes=[
                            {'Name':'email', 'Value':new_email}, {'Name':'email_verified', 'Value':'true'}])
                    except ClientError as error:
                        if error.response['Error']['Code'] in {'AliasExistsException', 'UsernameExistsException', 'InvalidParameterException'}:
                            _, sub, fresh = cognito_identity(cognito, pool, username)
                            if sub == subject and str(fresh.get('email', '')).lower() == old_email:
                                pending['phase'] = 'rejected'; save(); _unfence(table, subject, operation)
                        raise
                pending.update(phase='sync', position=0)
                save()
                continue
            if phase == 'complete':
                return _finish(table, key, subject, pending)
            raise RuntimeError('Unknown email synchronization phase')
        return None
