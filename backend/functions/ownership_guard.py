"""Fence new owner assignments against account deletion on the existing table."""
import hashlib
import time
import uuid
from contextlib import contextmanager

import boto3
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError
from media_mutation import MediaMutationBusy, enabled


def key(subject):
    return {'albumId': '__USER_DELETION__' + hashlib.sha256(subject.encode()).hexdigest()}


def encode(values):
    serializer = TypeSerializer()
    return {name: serializer.serialize(value) for name, value in values.items()}


def condition(table, subject):
    return {'ConditionCheck': {'TableName': table.name, 'Key': encode(key(subject)),
        'ConditionExpression': 'attribute_not_exists(deletionId) AND attribute_not_exists(emailOperation) AND (attribute_not_exists(identityLeaseUntil) OR identityLeaseUntil < :now)',
        'ExpressionAttributeValues': encode({':now': int(time.time())})}}


def write(table, operation, subject=None, **kwargs):
    method = table.put_item if operation == 'Put' else table.update_item
    if not subject or not enabled():
        return method(**kwargs)
    request = {name: value for name, value in kwargs.items() if name != 'ReturnValues'}
    request['TableName'] = table.name
    for name in ('Item', 'Key', 'ExpressionAttributeValues'):
        if name in request:
            request[name] = encode(request[name])
    try:
        boto3.client('dynamodb').transact_write_items(TransactItems=[{operation: request}, condition(table, subject)])
    except ClientError as error:
        if error.response['Error']['Code'] != 'TransactionCanceledException':
            raise
        reasons = error.response.get('CancellationReasons', [])
        if reasons and reasons[0].get('Code') == 'ConditionalCheckFailed':
            raise ClientError({'Error': {'Code':'ConditionalCheckFailedException', 'Message':'Album changed'}}, operation) from None
        raise MediaMutationBusy('The owner account is being updated or deleted. Please retry shortly.') from None
    if kwargs.get('ReturnValues') == 'ALL_NEW':
        return {'Attributes': table.get_item(Key=kwargs['Key'], ConsistentRead=True).get('Item', {})}
    return {}


@contextmanager
def identity_lease(table, subject, context, email_operation=None):
    owner = uuid.uuid4().hex
    now = int(time.time())
    remaining = getattr(context, 'get_remaining_time_in_millis', None)
    duration = max(60, int(remaining()/1000)+60) if callable(remaining) else 960
    try:
        table.update_item(Key=key(subject),
            UpdateExpression='SET #status = :internal, identityLeaseOwner = :owner, identityLeaseUntil = :until',
            ConditionExpression='attribute_not_exists(deletionId) AND (attribute_not_exists(emailOperation) OR emailOperation = :emailOp) AND (attribute_not_exists(identityLeaseUntil) OR identityLeaseUntil < :now)',
            ExpressionAttributeNames={'#status':'status'},
            ExpressionAttributeValues={':internal':'internal', ':owner':owner, ':until':now+duration, ':now':now, ':emailOp':email_operation or 'none'})
    except ClientError as error:
        if error.response['Error']['Code'] != 'ConditionalCheckFailedException':
            raise
        raise MediaMutationBusy('The account is being updated or deleted. Please retry shortly.') from None
    try:
        yield
    finally:
        try:
            table.update_item(Key=key(subject), UpdateExpression='REMOVE identityLeaseOwner, identityLeaseUntil',
                ConditionExpression='identityLeaseOwner = :owner', ExpressionAttributeValues={':owner':owner})
        except ClientError as error:
            if error.response['Error']['Code'] != 'ConditionalCheckFailedException':
                raise
