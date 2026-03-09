import json
import os
import urllib.parse
import boto3
from botocore.exceptions import ClientError

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
lambda_client = boto3.client('lambda')

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

        # 2. File doesn't exist, asynchronously trigger the worker to build it.
        worker_func = os.environ.get('WORKER_FUNCTION_NAME')
        if worker_func:
            payload = {
                'albumId': album_id,
                'shareCode': share_code
            }
            lambda_client.invoke(
                FunctionName=worker_func,
                InvocationType='Event', # Asynchronous invocation
                Payload=json.dumps(payload)
            )
            print(f"Triggered async worker for album {album.get('albumId')}")

        # 3. Inform the frontend that the zip is being processed
        return {
            'statusCode': 202, # 202 Accepted implies background long-running task
            'headers': {'Content-Type': 'application/json'}, 
            'body': json.dumps({
                'status': 'processing'
            })
        }

    except Exception as e:
        print(e)
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}
