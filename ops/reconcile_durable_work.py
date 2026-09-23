#!/usr/bin/env python3
"""Read-only inventory and one-operation, compare-and-swap recovery. No bulk redrive."""
import argparse
from copy import deepcopy
from decimal import Decimal
import hashlib
import json
import time
import uuid
from botocore.exceptions import ClientError

FIELDS = {'pendingAlbumDeletion':'album-deletion', 'pendingMediaDeletion':'album-media-deletion',
          'pendingThumbnailCleanup':'album-thumbnail-cleanup', 'pendingVisibilityChange':'album-visibility'}
LEASES = ('mediaLeaseUntil', 'deletionLeaseUntil', 'identityLeaseUntil', 'leaseUntil')


def fingerprint(item):
    return hashlib.sha256(json.dumps(item, sort_keys=True, separators=(',', ':'), default=lambda v:int(v) if isinstance(v, Decimal) else str(v)).encode()).hexdigest()


def describe(item, now):
    result = []
    fields = dict(FIELDS)
    key = item.get('albumId', '')
    if key.startswith('__USER_DELETION__'):
        fields['payload'] = 'user-deletion'
    elif key.startswith('__USER_EMAIL_UPDATE__'):
        fields['payload'] = 'user-email-update'
    for field, kind in fields.items():
        pending = item.get(field)
        if not isinstance(pending, dict) or pending.get('phase') in {'complete','rejected'}:
            continue
        started = int(pending.get('continuationStartedAt', 0))
        if started and now-started >= 86400:
            result.append({'key':key, 'field':field, 'kind':kind,
                'operation':pending.get('id') or pending.get('operation'), 'snapshot':fingerprint(item),
                'ageSeconds':now-started, 'repairCount':int(pending.get('repairCount', 0))})
    return result


def repair(table, sqs, queue_url, key, operation, expected, *, cognito=None, pool=None, apply=False, now=None, _locked=False):
    now = int(time.time()) if now is None else now
    item = table.get_item(Key={'albumId':key}, ConsistentRead=True).get('Item', {})
    if fingerprint(item) != expected:
        raise ValueError('The receipt changed; generate a fresh dry-run plan')
    candidates = [plan for plan in describe(item, now) if plan['operation'] == operation]
    if len(candidates) != 1:
        raise ValueError('Exactly one aged operation must match')
    plan = candidates[0]
    if any(int(item.get(name, 0)) >= now for name in LEASES):
        raise ValueError('A worker still holds a lease')
    pending = item[plan['field']]
    if int(pending.get('repairCount', 0)) >= 3:
        raise ValueError('Repair budget exhausted; investigate the underlying failure')
    subject = pending.get('subject')
    if plan['kind'] == 'user-email-update':
        from pathlib import Path
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend' / 'functions'))
        import ownership_guard
        fence = table.get_item(Key=ownership_guard.key(subject), ConsistentRead=True).get('Item', {})
        if fence.get('emailOperation') != operation or fence.get('deletionId') or (not _locked and int(fence.get('identityLeaseUntil', 0)) >= now):
            raise ValueError('Account ownership fence changed or is busy')
        if apply and not _locked:
            with ownership_guard.identity_lease(table, subject, None, email_operation=operation):
                return repair(table, sqs, queue_url, key, operation, expected, cognito=cognito, pool=pool,
                              apply=True, now=now, _locked=True)
    if plan['kind'].startswith('user-'):
        if not cognito or not pool or not subject:
            raise ValueError('Account reconciliation requires the current identity provider')
        # No automatic recovery for removed/reused/protected identities.
        try:
            account = cognito.admin_get_user(UserPoolId=pool, Username=pending['username'])
        except ClientError as error:
            if not (error.response.get('Error', {}).get('Code') == 'UserNotFoundException'
                    and plan['kind'] == 'user-deletion' and pending.get('phase') == 'identity'
                    and item.get('deletionId') == operation):
                raise
            account = None  # A lost successful deletion reply; never recreate it.
        if account is not None:
            attrs = {entry['Name']:entry['Value'] for entry in account.get('UserAttributes', [])}
            groups = cognito.admin_list_groups_for_user(UserPoolId=pool, Username=pending['username'])
            if attrs.get('sub') != subject or groups.get('NextToken') or any(g.get('GroupName') == 'Admins' for g in groups.get('Groups', [])):
                raise ValueError('Account identity or protected status changed')
            allowed = {pending.get('email'),pending.get('oldEmail'),pending.get('newEmail')}-{None}
            if attrs.get('email', '').lower() not in allowed:
                raise ValueError('Account email changed')
        if plan['kind'] == 'user-email-update' and pending.get('phase') not in {'pin','provider','sync'}:
            raise ValueError('Legacy email operation requires its original request')
    else:
        uuid.UUID(key)
        if item.get('visibility', 'private') not in {'private','public','unlisted'}:
            raise ValueError('Unknown current privacy state')
        required = 'deleting' if plan['kind'] == 'album-deletion' else 'updating' if plan['kind'] == 'album-visibility' else 'active'
        if item.get('status', 'active') != required:
            raise ValueError('Album status does not match the operation')
    plan['applied'] = False
    if not apply:
        return plan
    repaired = deepcopy(pending)
    repaired.update(continuationStartedAt=now, scheduledUntil=now+30,
                    repairCount=int(pending.get('repairCount', 0))+1, lastRepairAt=now)
    repaired.setdefault('originalContinuationStartedAt', pending['continuationStartedAt'])
    # Enqueue first, then CAS the exact reviewed receipt and every live field.
    # Failed CAS leaves the original bounded operation unchanged. A duplicate
    # delivery has no destructive authority beyond the current saved receipt.
    sqs.send_message(QueueUrl=queue_url, DelaySeconds=30, MessageBody=json.dumps({
        'version':1,'kind':plan['kind'],'albumId':subject or key}))
    names = {'#field':plan['field']}
    values = {':next':repaired}
    conditions = []
    for index, (name, value) in enumerate(item.items()):
        if name == 'albumId': continue
        names[f'#v{index}'] = name; values[f':v{index}'] = value
        conditions.append(f'#v{index} = :v{index}')
    for name in LEASES + ('ownerSub','ownerEmail','visibility','status','emailOperation','deletionId'):
        if name not in item:
            alias = f'#abs{len(names)}'; names[alias] = name
            conditions.append(f'attribute_not_exists({alias})')
    table.update_item(Key={'albumId':key}, UpdateExpression='SET #field = :next',
        ConditionExpression=' AND '.join(conditions), ExpressionAttributeNames=names, ExpressionAttributeValues=values)
    plan.update(applied=True, repairCount=repaired['repairCount'])
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--table', required=True)
    parser.add_argument('--region', default='us-west-2')
    parser.add_argument('--key'); parser.add_argument('--operation'); parser.add_argument('--expected-snapshot')
    parser.add_argument('--queue-url'); parser.add_argument('--pool')
    parser.add_argument('--cursor', help='One scan page resumes after this albumId')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    import boto3
    session = boto3.Session(region_name=args.region)
    table = session.resource('dynamodb').Table(args.table)
    if not args.key:
        if args.apply: parser.error('--apply requires an exact key, operation and expected snapshot')
        params = {'ConsistentRead':True, 'Limit':100}
        if args.cursor: params['ExclusiveStartKey'] = {'albumId':args.cursor}
        page = table.scan(**params)
        result = {'operations':[plan for item in page.get('Items', []) for plan in describe(item, int(time.time()))],
            'nextCursor':page.get('LastEvaluatedKey', {}).get('albumId')}
    else:
        if not args.operation or not args.expected_snapshot or (args.apply and not args.queue_url):
            parser.error('Exact operation/snapshot and apply queue are required')
        result = repair(table, session.client('sqs'), args.queue_url, args.key, args.operation, args.expected_snapshot,
            cognito=session.client('cognito-idp'), pool=args.pool, apply=args.apply)
    # Append this structured operator record to the incident/release evidence.
    print(json.dumps({'event':'durable_work_reconciliation','at':int(time.time()),'result':result}, default=str))


if __name__ == '__main__': main()
