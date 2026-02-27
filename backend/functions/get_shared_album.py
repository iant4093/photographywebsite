import os
import json
import boto3
from boto3.dynamodb.conditions import Key
from decimal import Decimal
from security_helpers import validate_turnstile, check_rate_limit

class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return int(obj) if obj % 1 == 0 else float(obj)
        return super(DecimalEncoder, self).default(obj)

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])

def handler(event, context):
    try:
        ip = event.get('requestContext', {}).get('http', {}).get('sourceIp', 'unknown_ip')
        share_code = event['pathParameters'].get('shareCode')
        
        headers = event.get('headers', {})
        # Normalize header keys to lowercase for standard retrieval
        normalized_headers = {k.lower(): v for k, v in headers.items()}
        token = normalized_headers.get('x-turnstile-token')
        
        print(f"Fetch Shared Album: Code={share_code}, IP={ip}")
        print(f"Headers: {json.dumps(headers)}")
        print(f"Token Found: {'Yes' if token else 'No'}")

        if not share_code:
            return {'statusCode': 400, 'body': json.dumps({'error': 'Share code is required'})}
            
        # 1. IP Rate Limit (max 20 requests per 60 seconds)
        # We removed Turnstile CAPTCHA for shared album fetches to allow direct links to work seamlessly.
        if not check_rate_limit(ip, 'shared_album_fetch', max_requests=20, window_seconds=60):
            return {'statusCode': 429, 'body': json.dumps({'error': 'Too many requests. Please try again later.'})}
            
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
