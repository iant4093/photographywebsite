import json
import os
import boto3

# DynamoDB and S3 for deleting albums and their images
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])
s3 = boto3.client('s3')
BUCKET = os.environ['IMAGES_BUCKET']

from auth_helpers import require_admin


def handler(event, context):
    """DELETE /albums/{albumId} — deletes album record and all S3 images (admin-only)."""
    denied = require_admin(event)
    if denied:
        return denied
    try:
        album_id = event['pathParameters']['albumId']

        # Get album to find S3 prefix
        response = table.get_item(Key={'albumId': album_id})
        album = response.get('Item')

        if not album:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': 'Album not found'}),
            }

        # Delete all S3 objects under the album's prefix
        s3_prefix = album.get('s3Prefix', f'albums/{album_id}/')
        s3_response = s3.list_objects_v2(Bucket=BUCKET, Prefix=s3_prefix)
        objects = s3_response.get('Contents', [])

        if objects:
            s3.delete_objects(
                Bucket=BUCKET,
                Delete={'Objects': [{'Key': obj['Key']} for obj in objects]},
            )

        # Delete the DynamoDB record
        table.delete_item(Key={'albumId': album_id})

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'message': f'Album {album_id} deleted'}),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
