import json
import os
import boto3

# S3 client for generating presigned URLs
s3 = boto3.client('s3')
BUCKET = os.environ['IMAGES_BUCKET']

from auth_helpers import require_admin


def handler(event, context):
    """POST /upload-url — generates a presigned PUT URL for S3 (admin-only)."""
    denied = require_admin(event)
    if denied:
        return denied
    try:
        body = json.loads(event.get('body', '{}'))
        filename = body.get('filename')
        content_type = body.get('contentType', 'image/jpeg')

        if not filename:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'filename is required'}),
            }

        # Generate a presigned URL valid for 5 minutes
        upload_url = s3.generate_presigned_url(
            'put_object',
            Params={
                'Bucket': BUCKET,
                'Key': filename,
                'ContentType': content_type,
            },
            ExpiresIn=300,
        )

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'uploadUrl': upload_url}),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
