import json
import os
import uuid
import io
import secrets
import boto3
import exifread
import decimal
from datetime import datetime
from botocore.exceptions import ClientError

# DynamoDB and S3 resources
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])
s3 = boto3.client('s3')

from auth_helpers import get_caller_email, require_admin
from email_helpers import send_email
from media_helpers import format_fraction, extract_exif_data, start_mediaconvert_job


def get_image_dimensions_and_exif(bucket, key):
    """
    Wrapper to extract EXIF data
    """
    exif_data = extract_exif_data(bucket, key)
    # The frontend already handled dimensions and sent them in the payload.
    return {
        "width": None,
        "height": None,
        "exif": exif_data
    }


def handler(event, context):
    """POST /albums — creates a new album record in DynamoDB (admin-only)."""
    # Verify the caller is an admin
    denied = require_admin(event)
    if denied:
        return denied

    owner_email = get_caller_email(event)
    if not owner_email:
        return {
            'statusCode': 401,
            'body': json.dumps({'error': 'Unauthorized'})
        }

    try:
        body = json.loads(event.get('body', '{}'), parse_float=decimal.Decimal)

        # Validate required fields
        required = ['albumId', 'title', 's3Prefix', 'createdAt']
        missing = [f for f in required if f not in body]
        if missing:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': f'Missing fields: {", ".join(missing)}'}),
            }

        visibility = body.get('visibility', 'public')

        album_type = body.get('type', 'photo')
        images = body.get('images', [])

        # Extract EXIF data from first 64KB of S3 object dynamically
        if 'IMAGES_BUCKET' in os.environ:
            for img in images:
                raw_key = img.get('rawKey')
                if not raw_key: continue
                try:
                    # Use the helper function for EXIF extraction
                    extracted_data = get_image_dimensions_and_exif(os.environ['IMAGES_BUCKET'], raw_key)
                    if extracted_data.get('exif'):
                        img['exif'] = extracted_data['exif']
                except Exception as e:
                    print(f"EXIF extraction error for {raw_key}: {e}")

        # If it's a video album, kick off MediaConvert jobs
        if album_type == 'video' and 'IMAGES_BUCKET' in os.environ:
            bucket = os.environ['IMAGES_BUCKET']
            for img in images:
                raw_key = img.get('rawKey')
                if not raw_key: continue
                # S3 input URI format: s3://bucket/key
                s3_input_uri = f"s3://{bucket}/{raw_key}"
                
                # S3 output prefix format: s3://bucket/albums/..../hls/
                # We'll save the output to an 'hls/' subdirectory next to the raw video
                base_name = raw_key.rsplit('.', 1)[0]
                s3_output_prefix = f"s3://{bucket}/{base_name}_hls/"
                
                # Start MediaConvert job asynchronously
                try:
                    start_mediaconvert_job(s3_input_uri, s3_output_prefix)
                    # The frontend will be looking for the .m3u8 file
                    # MediaConvert defaults the master playlist to the input base name
                    filename = raw_key.split('/')[-1].rsplit('.', 1)[0]
                    img['hlsUrl'] = f"{base_name}_hls/{filename}.m3u8"
                except Exception as e:
                    print(f"Failed to start MediaConvert for {raw_key}: {e}")

        is_shared = body.get('isShared', False)
        share_code = secrets.token_urlsafe(6) if is_shared else ''

        # Write the album record with visibility and ownerEmail
        item = {
            'albumId': body['albumId'],
            'type': album_type,
            'title': body['title'],
            'description': body.get('description', ''),
            'category': body.get('category', 'Uncategorized'),
            'coverImageUrl': body.get('coverImageUrl', ''),
            'coverThumbKey': body.get('coverThumbKey', ''),
            'coverBlurhash': body.get('coverBlurhash', ''),
            'images': images,
            's3Prefix': body['s3Prefix'],
            'createdAt': body['createdAt'],
            'visibility': body.get('visibility', 'public'),
            'ownerEmail': body.get('ownerEmail', ''),
            'isShared': is_shared,
        }
        
        # Sparse Indexing: Only include shareCode if the album is shared.
        # DynamoDB GSI keys cannot be empty strings.
        if is_shared:
            item['shareCode'] = share_code

        table.put_item(Item=item)

        if item.get('visibility') == 'private' and item.get('ownerEmail'):
            portal_url = os.environ.get('FRONTEND_URL', 'https://iantruongphotography.com')
            subject = f"Your New Photos Are Ready: {item['title']}"
            html = f"""
            <div style="font-family: sans-serif; max-width: 600px; margin: auto;">
                <h2 style="color: #4a4a4a;">Your gallery is ready!</h2>
                <p>I've just uploaded a new private album for you: <strong>{item['title']}</strong>.</p>
                <p>You can view and download your photos by logging into your client portal here:</p>
                <p style="margin: 20px 0;">
                    <a href="{portal_url}/login" style="background-color: #d1bfae; color: #333; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">View Album</a>
                </p>
            </div>
            """
            send_email(item['ownerEmail'], subject, html)

        # Trigger Google Drive sync if requested
        backup_to_drive = body.get('backupToGoogleDrive', False)
        if backup_to_drive and 'GOOGLE_DRIVE_SYNC_FUNCTION_NAME' in os.environ:
            try:
                sync_payload = {
                    "albumType": album_type,
                    "albumTitle": body['title'],
                    "bucket": os.environ.get('IMAGES_BUCKET'),
                    "keys": [img['rawKey'] for img in images if 'rawKey' in img]
                }
                lambda_client = boto3.client('lambda')
                lambda_client.invoke(
                    FunctionName=os.environ['GOOGLE_DRIVE_SYNC_FUNCTION_NAME'],
                    InvocationType='Event',
                    Payload=json.dumps(sync_payload)
                )
                print(f"Triggered Drive Sync for album {body['title']}")
            except Exception as e:
                print(f"Failed to trigger Google Drive sync: {e}")

        return {
            'statusCode': 201,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(item),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
