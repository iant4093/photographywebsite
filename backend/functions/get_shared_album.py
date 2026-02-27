import os
import json
import boto3
from boto3.dynamodb.conditions import Key
from decimal import Decimal

class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return int(obj) if obj % 1 == 0 else float(obj)
        return super(DecimalEncoder, self).default(obj)

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])

def handler(event, context):
    try:
        share_code = event['pathParameters'].get('shareCode')
        if not share_code:
            return {'statusCode': 400, 'body': json.dumps({'error': 'Share code is required'})}
            
        # Query the GSI for the provided share code
        response = table.query(
            IndexName='ShareCodeIndex',
            KeyConditionExpression=Key('shareCode').eq(share_code)
        )
        
        items = response.get('Items', [])
        
        # If no album or multiple (should be impossible but handle gracefully)
        if not items:
            return {'statusCode': 404, 'body': json.dumps({'error': 'Shared album not found or link is invalid.'})}
            
        album = items[0]
        
        # Security check: ensure the owner hasn't toggled sharing OFF manually since link generation
        if not album.get('isShared', False):
            return {'statusCode': 403, 'body': json.dumps({'error': 'This album is no longer being actively shared.'})}
            
        # Return the album safely
        return {
            'statusCode': 200,
            'body': json.dumps(album, cls=DecimalEncoder)
        }
    except Exception as e:
        print(f"Error fetching shared album: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Internal server error'})
        }
