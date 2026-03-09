import json
import os
import io
import boto3
import exifread
from datetime import datetime
from botocore.exceptions import ClientError
import concurrent.futures
from auth_helpers import require_admin
from media_helpers import format_fraction, extract_exif_data, start_mediaconvert_job

# DynamoDB and S3 resources
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])
s3 = boto3.client('s3')


def get_image_dimensions_and_exif(bucket, key):
    """
    Dummy wrapper to keep existing signature if needed, or we just
    call extract_exif_data directly. We don't get dimensions from Exif
    easily without loading the whole image in memory, which we avoid here.
    """
    exif_data = extract_exif_data(bucket, key)
    # The frontend already handled dimensions and sent them in the payload.
    return {
        "width": None,
        "height": None,
        "exif": exif_data
    }

def handler(event, context):
    """POST /albums/{albumId}/images — appends new images to an existing album and extracts EXIF."""
    # Verify caller is admin
    denied = require_admin(event)
    if denied:
        return denied
    
    try:
        album_id = event['pathParameters']['albumId']
        body = json.loads(event.get('body', '{}'))
        new_images = body.get('images', [])

        if not new_images:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'No images provided in the payload'})
            }

        album = table.get_item(Key={'albumId': album_id}).get('Item', {})
        album_type = album.get('type', 'photo')

        # EXIF for photos / MediaConvert for videos
        if 'IMAGES_BUCKET' in os.environ:
            bucket = os.environ['IMAGES_BUCKET']
            
            def _process_img(img):
                raw_key = img.get('rawKey')
                if not raw_key: return

                if album_type == 'video':
                    s3_input_uri = f"s3://{bucket}/{raw_key}"
                    base_name = raw_key.rsplit('.', 1)[0]
                    s3_output_prefix = f"s3://{bucket}/albums/{album_id}/{base_name}_hls/"
                    
                    try:
                        job_id = start_mediaconvert_job(s3_input_uri, s3_output_prefix)
                        filename = raw_key.split('/')[-1].rsplit('.', 1)[0]
                        img['hlsUrl'] = f"albums/{album_id}/{base_name}_hls/{filename}.m3u8"
                        img['mediaConvertJobId'] = job_id
                    except Exception as e:
                        print(f"Failed to start MediaConvert for {raw_key}: {e}")
                else:
                    try:
                        exif_data = extract_exif_data(bucket, raw_key)
                        if exif_data:
                            img['exif'] = exif_data
                    except Exception as e:
                        print(f"EXIF extraction error for {raw_key}: {e}")

            with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
                executor.map(_process_img, new_images)

        # Append images to existing album in DynamoDB
        response = table.update_item(
            Key={'albumId': album_id},
            UpdateExpression="SET images = list_append(if_not_exists(images, :empty_list), :new_images)",
            ExpressionAttributeValues={
                ':empty_list': [],
                ':new_images': new_images
            },
            ReturnValues="UPDATED_NEW"
        )

        # Trigger Google Drive sync if requested
        backup_to_drive = body.get('backupToGoogleDrive', False)
        if backup_to_drive and 'GOOGLE_DRIVE_SYNC_FUNCTION_NAME' in os.environ:
            try:
                sync_payload = {
                    "albumType": album_type,
                    "albumTitle": album.get('title', 'Unknown Album'),
                    "bucket": os.environ.get('IMAGES_BUCKET'),
                    "keys": [img['rawKey'] for img in new_images if 'rawKey' in img]
                }
                lambda_client = boto3.client('lambda')
                lambda_client.invoke(
                    FunctionName=os.environ['GOOGLE_DRIVE_SYNC_FUNCTION_NAME'],
                    InvocationType='Event',
                    Payload=json.dumps(sync_payload)
                )
                print(f"Triggered Drive Sync for added images in album {album.get('title', 'Unknown')}")
            except Exception as e:
                print(f"Failed to trigger Google Drive sync: {e}")

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'message': 'Images appended successfully', 'images': new_images}),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
