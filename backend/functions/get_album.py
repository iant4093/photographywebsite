import json
import os
import boto3
import jwt
from jwt import PyJWKClient

from decimal import Decimal
class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return int(obj) if obj % 1 == 0 else float(obj)
        return super(DecimalEncoder, self).default(obj)

# DynamoDB resource for fetching the album record
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])
BUCKET = os.environ['IMAGES_BUCKET']
s3 = boto3.client('s3')

USER_POOL_ID = os.environ.get('COGNITO_USER_POOL_ID', '')
REGION = os.environ.get('AWS_REGION', 'us-west-2')
jwks_url = f"https://cognito-idp.{REGION}.amazonaws.com/{USER_POOL_ID}/.well-known/jwks.json"
jwks_client = PyJWKClient(jwks_url)

def get_email_from_token(event):
    """Extract and cryptographically verify email and groups from the Bearer token."""
    headers = event.get('headers', {})
    auth_header = headers.get('authorization') or headers.get('Authorization', '')
    if not auth_header.lower().startswith('bearer '):
        return '', []
    
    token = auth_header.split(' ')[1]
    try:
        signing_key = jwks_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={"verify_aud": False}
        )
        return claims.get('email', ''), claims.get('cognito:groups', [])
    except Exception as e:
        print(f"Token validation error: {e}")
        return '', []

def handler(event, context):
    """GET /albums/{albumId} — returns album metadata and lists S3 images."""
    try:
        album_id = event['pathParameters']['albumId']

        # Fetch album metadata from DynamoDB
        response = table.get_item(Key={'albumId': album_id})
        album = response.get('Item')

        if not album:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': 'Album not found'}),
            }

        # Private album check — require matching owner or admin
        if album.get('visibility') == 'private':
            # API Gateway Authorizer is NONE, so we manually decode the token
            caller_email, groups = get_email_from_token(event)
            owner = album.get('ownerEmail', '')
            if caller_email != owner and 'Admins' not in groups:
                return {
                    'statusCode': 403,
                    'body': json.dumps({'error': 'Access denied — this album is private'}),
                }

        cf_domain = os.environ.get('CLOUDFRONT_DOMAIN', f'{BUCKET}.s3.amazonaws.com')
        # Convert coverImageUrl from S3 key to full public URL
        cover = album.get('coverImageUrl', '')
        if cover and not cover.startswith('http'):
            album['coverImageUrl'] = f'https://{cf_domain}/{cover}'

        # If the album already has the new image manifest (with thumbKeys/blurhashes), use it
        # This completely skips the slow S3 list_objects_v2 API call!
        images = album.get('images')
        
        if not images:
            # Fallback for old albums: List all objects in the S3 prefix
            s3_prefix = album.get('s3Prefix', f'albums/{album_id}/')
            s3_response = s3.list_objects_v2(Bucket=BUCKET, Prefix=s3_prefix)
            objects = s3_response.get('Contents', [])

            # Build image URLs sorted alphabetically by key (chronological order)
            images = []
            for obj in sorted(objects, key=lambda o: o['Key']):
                # Skip folder markers
                if obj['Key'].endswith('/'):
                    continue
                url = f'https://{cf_domain}/{obj["Key"]}'
                images.append({'key': obj['Key'], 'url': url})

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'album': album, 'images': images}, cls=DecimalEncoder),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
