import json
import os
import urllib.parse
import boto3
import jwt
from jwt import PyJWKClient
from botocore.exceptions import ClientError

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
lambda_client = boto3.client('lambda')

USER_POOL_ID = os.environ.get('COGNITO_USER_POOL_ID', '')
REGION = os.environ.get('AWS_REGION', 'us-west-2')
jwks_url = f"https://cognito-idp.{REGION}.amazonaws.com/{USER_POOL_ID}/.well-known/jwks.json"
jwks_client = PyJWKClient(jwks_url) if USER_POOL_ID else None

def get_email_from_token(event):
    """Extract and cryptographically verify email and groups from the Bearer token."""
    headers = event.get('headers', {})
    auth_header = headers.get('authorization') or headers.get('Authorization', '')
    if not auth_header.lower().startswith('bearer '):
        return '', []
    
    token = auth_header.split(' ')[1]
    try:
        if not jwks_client: return '', []
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

def get_album_record(album_id=None, share_code=None):
    if not os.environ.get('ALBUMS_TABLE'): return None
    table = dynamodb.Table(os.environ['ALBUMS_TABLE'])
    if album_id:
        return table.get_item(Key={'albumId': album_id}).get('Item')
    if share_code:
        resp = table.query(
            IndexName='ShareCodeIndex',
            KeyConditionExpression=boto3.dynamodb.conditions.Key('shareCode').eq(share_code)
        )
        items = resp.get('Items', [])
        return items[0] if items else None
    return None

def create_presigned_url(bucket_name, object_name, expiration=3600, download_filename=None):
    params = {'Bucket': bucket_name, 'Key': object_name}
    if download_filename:
        encoded_filename = urllib.parse.quote(download_filename)
        params['ResponseContentDisposition'] = f"attachment; filename*=UTF-8''{encoded_filename}"
    try:
        return s3.generate_presigned_url('get_object',
                                        Params=params,
                                        ExpiresIn=expiration)
    except Exception as e:
        print(e)
        return None

def handler(event, context):
    try:
        path_params = event.get('pathParameters', {})
        album_id = path_params.get('albumId')
        share_code = path_params.get('shareCode')
        
        if not album_id and not share_code:
            return {'statusCode': 400, 'body': json.dumps({'error': 'Missing identifier'})}
            
        album = get_album_record(album_id=album_id, share_code=share_code)
        if not album:
            return {'statusCode': 404, 'body': json.dumps({'error': 'Album not found'})}

        # Security Check: If accessed via albumId and it's private, verify token
        if not share_code and album.get('visibility') == 'private':
            caller_email, groups = get_email_from_token(event)
            owner = album.get('ownerEmail', '')
            if caller_email != owner and 'Admins' not in groups:
                return {
                    'statusCode': 403,
                    'body': json.dumps({'error': 'Access denied — this album is private'})
                }

        bucket = os.environ.get('IMAGES_BUCKET')
        zip_filename = f"album_{album.get('albumId')}.zip"
        zip_key = f"temp-zips/{zip_filename}"
        download_filename = f"{album.get('title', 'album')}.zip"

        # 1. Check if the zip already exists in S3
        try:
            s3.head_object(Bucket=bucket, Key=zip_key)
            # If it exists, return ready status with the pre-signed URL
            url = create_presigned_url(bucket, zip_key, download_filename=download_filename)
            return {
                'statusCode': 200, 
                'headers': {'Content-Type': 'application/json'}, 
                'body': json.dumps({
                    'status': 'ready',
                    'url': url
                })
            }
        except ClientError:
            # File doesn't exist yet, we need to generate it.
            pass

        # 2. Check if a worker is already running via a lock marker
        lock_key = f"temp-zips/album_{album.get('albumId')}.lock"
        worker_already_running = False
        try:
            lock_obj = s3.head_object(Bucket=bucket, Key=lock_key)
            # Lock exists — check if it's recent (< 10 minutes old)
            import datetime
            lock_age = (datetime.datetime.now(datetime.timezone.utc) - lock_obj['LastModified']).total_seconds()
            if lock_age < 600:
                worker_already_running = True
                print(f"Lock exists ({int(lock_age)}s old) — worker already running for album {album.get('albumId')}")
            else:
                print(f"Stale lock ({int(lock_age)}s old) — will re-trigger worker for album {album.get('albumId')}")
        except ClientError:
            # No lock exists
            pass

        # 3. Only invoke a new worker if one isn't already running
        if not worker_already_running:
            # Create lock marker before invoking worker
            s3.put_object(Bucket=bucket, Key=lock_key, Body=b'locked')
            print(f"Created lock for album {album.get('albumId')}")

            worker_func = os.environ.get('WORKER_FUNCTION_NAME')
            if worker_func:
                payload = {
                    'albumId': album_id,
                    'shareCode': share_code
                }
                lambda_client.invoke(
                    FunctionName=worker_func,
                    InvocationType='Event',  # Asynchronous invocation
                    Payload=json.dumps(payload)
                )
                print(f"Triggered async worker for album {album.get('albumId')}")

        # 4. Inform the frontend that the zip is being processed
        return {
            'statusCode': 202,  # 202 Accepted implies background long-running task
            'headers': {'Content-Type': 'application/json'}, 
            'body': json.dumps({
                'status': 'processing'
            })
        }

    except Exception as e:
        print(e)
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}
