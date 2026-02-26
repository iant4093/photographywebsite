import json
import os
import boto3

# DynamoDB resource for updating album records
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])

from auth_helpers import require_admin


def handler(event, context):
    """PUT /albums/{albumId} — updates an album's metadata (admin-only)."""
    denied = require_admin(event)
    if denied:
        return denied
    try:
        album_id = event['pathParameters']['albumId']
        body = json.loads(event.get('body', '{}'))

        # Build update expression dynamically from provided fields
        update_parts = []
        values = {}
        names = {}

        if 'title' in body:
            update_parts.append('#t = :title')
            values[':title'] = body['title']
            names['#t'] = 'title'

        if 'description' in body:
            update_parts.append('#d = :desc')
            values[':desc'] = body['description']
            names['#d'] = 'description'

        if 'category' in body:
            update_parts.append('#cat = :category')
            values[':category'] = body['category']
            names['#cat'] = 'category'

        if 'coverImageUrl' in body:
            update_parts.append('#c = :cover')
            values[':cover'] = body['coverImageUrl']
            names['#c'] = 'coverImageUrl'

        if 'createdAt' in body:
            update_parts.append('#ca = :created')
            values[':created'] = body['createdAt']
            names['#ca'] = 'createdAt'

        if not update_parts:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'No fields to update'}),
            }

        response = table.update_item(
            Key={'albumId': album_id},
            UpdateExpression='SET ' + ', '.join(update_parts),
            ExpressionAttributeValues=values,
            ExpressionAttributeNames=names,
            ReturnValues='ALL_NEW',
        )

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(response.get('Attributes', {})),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
