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
        # Use pagination for S3 deletion to handle >1000 objects
        if 'IMAGES_BUCKET' in os.environ:
            bucket = os.environ['IMAGES_BUCKET']
            prefix = album.get('s3Prefix', f'albums/{album_id}/') # Use album's s3Prefix if available
            
            paginator = s3.get_paginator('list_objects_v2')
            pages = paginator.paginate(Bucket=bucket, Prefix=prefix)
            
            objects_to_delete = []
            for page in pages:
                if 'Contents' in page:
                    for obj in page['Contents']:
                        objects_to_delete.append({'Key': obj['Key']})
                        
                    # Delete in batches of 1000
                    # S3 DeleteObjects API can take up to 1000 objects
                    if len(objects_to_delete) >= 1000:
                        s3.delete_objects(
                            Bucket=bucket,
                            Delete={'Objects': objects_to_delete}
                        )
                        objects_to_delete = []
            
            # Delete any remaining objects
            if objects_to_delete:
                s3.delete_objects(
                    Bucket=bucket,
                    Delete={'Objects': objects_to_delete}
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
