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

        if objects_to_delete:
            # Also check for HLS prefixes for each video being deleted
            hls_objects = []
            for obj in objects_to_delete:
                key = obj['Key']
                # If it's a raw video (not a thumb), check for its HLS folder
                if not key.endswith('.jpg') and '.' in key:
                    base_name = key.rsplit('.', 1)[0]
                    hls_prefix = f"{base_name}_hls/"
                    
                    # List all objects in the HLS folder
                    paginator = s3.get_paginator('list_objects_v2')
                    for page in paginator.paginate(Bucket=BUCKET, Prefix=hls_prefix):
                        if 'Contents' in page:
                            for item in page['Contents']:
                                hls_objects.append({'Key': item['Key']})
            
            # Combine all objects to delete
            all_to_delete = objects_to_delete + hls_objects
            
            # S3 delete_objects has a limit of 1000 keys per call
            for i in range(0, len(all_to_delete), 1000):
                chunk = all_to_delete[i:i + 1000]
                s3.delete_objects(
                    Bucket=BUCKET,
                    Delete={'Objects': chunk},
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
