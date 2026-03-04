import json
import os
import boto3
from auth import require_admin

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])


def handler(event, context):
    """Update a single image's thumbKey and/or blurhash within an album."""
    try:
        # Auth check — admin only
        claims = require_admin(event)
        if isinstance(claims, dict) and 'statusCode' in claims:
            return claims

        album_id = event.get('pathParameters', {}).get('albumId')
        if not album_id:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'albumId path parameter is required'}),
            }

        body = json.loads(event.get('body', '{}'))
        raw_key = body.get('rawKey')
        thumb_key = body.get('thumbKey')
        blurhash = body.get('blurhash')

        if not raw_key:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'rawKey is required'}),
            }

        # Fetch current album to find the target image index
        resp = table.get_item(Key={'albumId': album_id})
        album = resp.get('Item')
        if not album:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': 'Album not found'}),
            }

        images = album.get('images', [])

        # Find the index of the image matching rawKey
        target_index = None
        for i, img in enumerate(images):
            if img.get('rawKey') == raw_key or img.get('key') == raw_key:
                target_index = i
                break

        if target_index is None:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': f'Image with rawKey "{raw_key}" not found in album'}),
            }

        # Build a SET expression targeting the specific list index
        update_parts = []
        values = {}

        if thumb_key is not None:
            update_parts.append(f'images[{target_index}].thumbKey = :thumbKey')
            values[':thumbKey'] = thumb_key

        if blurhash is not None:
            update_parts.append(f'images[{target_index}].blurhash = :blurhash')
            values[':blurhash'] = blurhash

        if not update_parts:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'No fields to update (provide thumbKey and/or blurhash)'}),
            }

        table.update_item(
            Key={'albumId': album_id},
            UpdateExpression='SET ' + ', '.join(update_parts),
            ExpressionAttributeValues=values,
        )

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Image updated successfully',
                'rawKey': raw_key,
                'index': target_index,
            }),
        }

    except Exception as e:
        print(f'Error updating image: {e}')
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
