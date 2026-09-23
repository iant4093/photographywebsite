"""Bounded deletion of website-generated comparisons, never the Drive archive."""
import os
import time
import re
import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from validation_helpers import validate_uuid


def _purge(s3, bucket, prefix):
    # Non-versioned generated-preview bucket only. Repeat the first bounded
    # page until empty; missing/duplicate delete responses remain idempotent.
    page = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=100)
    objects = [{'Key':item['Key']} for item in page.get('Contents', [])]
    if objects:
        result = s3.delete_objects(Bucket=bucket, Delete={'Objects':objects, 'Quiet':True})
        if result.get('Errors'):
            raise RuntimeError('Comparison cleanup needs another attempt')
    return not page.get('IsTruncated')


def clean(album_id, media_ids=None, pending=None, save=None):
    table_name = os.environ.get('ORIGINAL_COMPARISON_TABLE', '').strip()
    bucket = os.environ.get('ORIGINAL_PREVIEW_BUCKET', '').strip()
    if not table_name or not bucket:
        return True  # Feature disabled in older deployments and local fixtures.
    album_id = validate_uuid(album_id)
    table = boto3.resource('dynamodb').Table(table_name)
    s3 = boto3.client('s3')
    if media_ids is None:
        page = table.query(KeyConditionExpression=Key('albumId').eq(album_id), ConsistentRead=True, Limit=25)
        records = page.get('Items', [])
    else:
        ids = sorted(set(media_ids) - set((pending or {}).get("comparisonCleaned", [])))
        if any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{24}', value) for value in ids):
            raise ValueError('Invalid comparison cleanup scope')
        records = [table.get_item(Key={'albumId':album_id, 'mediaId':value}, ConsistentRead=True).get('Item',
                    {'albumId':album_id, 'mediaId':value}) for value in ids[:25]]
        page = {'LastEvaluatedKey':len(ids) > 25}
    for record in records:
        media_id = record['mediaId']
        if not re.fullmatch(r'[a-f0-9]{24}', media_id):
            raise ValueError('Invalid comparison identity')
        if int(record.get('leaseUntil', 0)) >= int(time.time()):
            return False
        if not _purge(s3, bucket, f'before/{album_id}/{media_id}/'):
            return False
        try:
            table.delete_item(Key={'albumId':album_id, 'mediaId':media_id},
                ConditionExpression='attribute_not_exists(leaseUntil) OR leaseUntil < :now',
                ExpressionAttributeValues={':now':int(time.time())})
        except ClientError as error:
            if error.response['Error']['Code'] == 'ConditionalCheckFailedException':
                return False
            raise
        if media_ids is not None and pending is not None:
            pending.setdefault('comparisonCleaned', []).append(media_id)
            save()
    if page.get('LastEvaluatedKey'):
        return False
    # Whole-album cleanup also removes outputs whose publication never finished.
    return _purge(s3, bucket, f'before/{album_id}/') if media_ids is None else True
