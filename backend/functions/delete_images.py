import json
import os
import boto3

# S3 client for deleting specific images
s3 = boto3.client('s3')
BUCKET = os.environ['IMAGES_BUCKET']

from auth_helpers import require_admin


def handler(event, context):
    """POST /albums/{albumId}/delete-images — deletes specific S3 keys (admin-only)."""
    denied = require_admin(event)
    if denied:
        return denied
    try:
        body = json.loads(event.get('body', '{}'))
        keys = body.get('keys', [])

        if not keys:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'keys array is required'}),
            }

        # Delete the specified objects
        s3.delete_objects(
            Bucket=BUCKET,
            Delete={'Objects': [{'Key': k} for k in keys]},
        )

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'message': f'Deleted {len(keys)} image(s)'}),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
