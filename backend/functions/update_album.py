import json
import os
import boto3
import decimal

class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, decimal.Decimal):
            if obj % 1 > 0:
                return float(obj)
            else:
                return int(obj)
        return super(DecimalEncoder, self).default(obj)

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

        if 'coverThumbKey' in body:
            update_parts.append('#ct = :coverThumb')
            values[':coverThumb'] = body['coverThumbKey']
            names['#ct'] = 'coverThumbKey'

        if 'coverBlurhash' in body:
            update_parts.append('#cb = :coverBlur')
            values[':coverBlur'] = body['coverBlurhash']
            names['#cb'] = 'coverBlurhash'

        if 'createdAt' in body:
            update_parts.append('#ca = :created')
            values[':created'] = body['createdAt']
            names['#ca'] = 'createdAt'
            
        remove_parts = []
        if 'isShared' in body:
            update_parts.append('#is = :isShared')
            values[':isShared'] = body['isShared']
            names['#is'] = 'isShared'
            
            # If sharing is turned off, also remove the shareCode attribute
            if not body['isShared']:
                remove_parts.append('shareCode')
            
        if 'shareCode' in body:
            if body['shareCode']:
                update_parts.append('#sc = :shareCode')
                values[':shareCode'] = body['shareCode']
                names['#sc'] = 'shareCode'
            else:
                # If shareCode is explicitly cleared, remove it from the item
                remove_parts.append('shareCode')

        if not update_parts and not remove_parts:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'No fields to update'}),
            }

        update_expression = []
        if update_parts:
            update_expression.append('SET ' + ', '.join(update_parts))
        if remove_parts:
            # deduplicate and add to REMOVE clause
            update_expression.append('REMOVE ' + ', '.join(list(set(remove_parts))))

        response = table.update_item(
            Key={'albumId': album_id},
            UpdateExpression=' '.join(update_expression),
            ExpressionAttributeValues=values,
            ExpressionAttributeNames=names,
            ReturnValues='ALL_NEW',
        )

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(response.get('Attributes', {}), cls=DecimalEncoder),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }

