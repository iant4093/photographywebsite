"""Admin-only batched backup status and explicit retry."""
import os
import time

import boto3
from botocore.exceptions import ClientError

import drive_backup_jobs as jobs
from auth_helpers import require_admin
from front_door import verify_front_door_request
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, parse_json_body, validate_list, validate_uuid


def batch_get(table_name, keys):
    result = []
    pending = {table_name: {'Keys': keys, 'ConsistentRead': True}}
    client = boto3.resource('dynamodb')
    for _ in range(4):
        response = client.batch_get_item(RequestItems=pending)
        result.extend(response.get('Responses', {}).get(table_name, []))
        pending = response.get('UnprocessedKeys', {})
        if not pending:
            return result
    raise RuntimeError('Backup status temporarily unavailable')


def handler(event, context):
    denied = verify_front_door_request(event, context)
    if denied:
        return denied
    denied = require_admin(event)
    if denied:
        return denied
    try:
        body = parse_json_body(event)
        ids = list(dict.fromkeys(validate_uuid(value) for value in validate_list(body.get('albumIds'), 'albumIds', maximum=100, required=True)))
        if not ids:
            return json_response(200, {'items': []})
        albums = batch_get(os.environ['ALBUMS_TABLE'], [{'albumId': album_id} for album_id in ids])
        active = [album for album in albums if album.get('status', 'active') == 'active']
        if body.get('action') == 'retry':
            if len(ids) != 1 or not active:
                return error_response(400, 'Choose one active album to retry.', code='invalid_request')
            if not jobs.enqueue_retry(active[0]):
                return error_response(400, 'This album has no linked Drive backup.', code='not_backed_up')
            return json_response(202, {'queued': True})
        if body.get('action') not in {None, 'status'}:
            raise ValidationError('Invalid backup action')
        linked = [album for album in active if jobs.eligible(album)]
        states = batch_get(jobs.state_table().name, [{'albumId': album['albumId'], 'entry': 'state'} for album in linked]) if linked else []
        by_id = {state['albumId']: state for state in states}
        items = []
        for album in active:
            state = by_id.get(album['albumId'], {})
            status = state.get('status', 'not_synced' if jobs.eligible(album) else 'gallery_only')
            if state.get('leaseUntil', 0) > time.time():
                status = 'syncing'
            elif state.get('pendingJobs', 0) > 0 and status != 'failed':
                status = 'queued'
            items.append({'albumId': album['albumId'], 'status': status,
                          'lastSyncedAt': state.get('lastSyncedAt'),
                          'canRetry': jobs.eligible(album) and status not in {'syncing', 'retained'}})
        return json_response(200, {'items': items})
    except (ValidationError, jobs.DriveBackupBusy) as error:
        return error_response(400, str(error), code='invalid_request')
    except ClientError as error:
        if error.response['Error']['Code'] == 'TransactionCanceledException':
            return error_response(409, 'Album changed. Refresh and retry.', code='conflict')
        return internal_error(context, error, 'drive_backup_status')
    except Exception as error:
        return internal_error(context, error, 'drive_backup_status')
