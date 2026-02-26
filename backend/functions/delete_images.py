import json
import os
import boto3

# S3 and DynamoDB clients
s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

BUCKET = os.environ['IMAGES_BUCKET']
TABLE_NAME = os.environ['ALBUMS_TABLE']
table = dynamodb.Table(TABLE_NAME)

from auth_helpers import require_admin


def handler(event, context):
    """POST /albums/{albumId}/delete-images — deletes specific images from S3 and DynamoDB."""
    denied = require_admin(event)
    if denied:
        return denied
    try:
        album_id = event['pathParameters']['albumId']
        body = json.loads(event.get('body', '{}'))
        keys = body.get('keys', [])  # These are the rawKey/key values to delete

        if not keys:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'keys array is required'}),
            }

        album = table.get_item(Key={'albumId': album_id}).get('Item')
        if not album:
            return {'statusCode': 404, 'body': json.dumps({'error': 'Album not found'})}

        images = album.get('images', [])
        
        objects_to_delete = []
        new_images = []
        
        for img in images:
            img_key = img.get('rawKey') or img.get('key')
            if img_key in keys:
                objects_to_delete.append({'Key': img_key})
                if 'thumbKey' in img and img['thumbKey']:
                    objects_to_delete.append({'Key': img['thumbKey']})
            else:
                new_images.append(img)
                
        # Update DynamoDB if any images were removed
        if len(new_images) != len(images):
            table.update_item(
                Key={'albumId': album_id},
                UpdateExpression='SET images = :images',
                ExpressionAttributeValues={':images': new_images}
            )

        # Delete the specified objects from S3
        if objects_to_delete:
            s3.delete_objects(
                Bucket=BUCKET,
                Delete={'Objects': objects_to_delete},
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
