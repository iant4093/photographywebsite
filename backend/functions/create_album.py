import json
import os
import io
import boto3
import exifread
import decimal

# DynamoDB and S3 resources
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])
s3 = boto3.client('s3')

from auth_helpers import require_admin
from email_helpers import send_email

def start_mediaconvert_job(s3_input_uri, s3_output_prefix):
    """Starts an AWS MediaConvert job to convert a video to HLS format."""
    mc_client = boto3.client('mediaconvert')
    # Get the account-specific MediaConvert endpoint
    endpoints = mc_client.describe_endpoints(MaxResults=1)
    endpoint_url = endpoints['Endpoints'][0]['Url']
    
    mc = boto3.client('mediaconvert', endpoint_url=endpoint_url)
    role_arn = os.environ.get('MEDIACONVERT_ROLE_ARN', '')
    
    if not role_arn:
        print("Warning: MEDIACONVERT_ROLE_ARN not set, skipping video processing")
        return
        
    job_settings = {
        "Inputs": [
            {
                "AudioSelectors": {
                    "Audio Selector 1": {
                        "DefaultSelection": "DEFAULT"
                    }
                },
                "VideoSelector": {},
                "TimecodeSource": "ZEROBASED",
                "FileInput": s3_input_uri
            }
        ],
        "OutputGroups": [
            {
                "Name": "Apple HLS",
                "OutputGroupSettings": {
                    "Type": "HLS_GROUP_SETTINGS",
                    "HlsGroupSettings": {
                        "SegmentLength": 10,
                        "Destination": s3_output_prefix,
                        "MinSegmentLength": 0
                    }
                },
                "Outputs": [
                    {
                        "ContainerSettings": {
                            "Container": "M3U8",
                            "M3u8Settings": {}
                        },
                        "VideoDescription": {
                            "CodecSettings": {
                                "Codec": "H_264",
                                "H264Settings": {
                                    "MaxBitrate": 5000000,
                                    "RateControlMode": "QVBR",
                                    "SceneChangeDetect": "TRANSITION_DETECTION"
                                }
                            },
                            "Width": 1920,
                            "Height": 1080
                        },
                        "AudioDescriptions": [
                            {
                                "CodecSettings": {
                                    "Codec": "AAC",
                                    "AacSettings": {
                                        "Bitrate": 96000,
                                        "CodingMode": "CODING_MODE_2_0",
                                        "SampleRate": 48000
                                    }
                                }
                            }
                        ],
                        "NameModifier": "_1080p"
                    },
                    {
                        "ContainerSettings": {
                            "Container": "M3U8",
                            "M3u8Settings": {}
                        },
                        "VideoDescription": {
                            "CodecSettings": {
                                "Codec": "H_264",
                                "H264Settings": {
                                    "MaxBitrate": 2000000,
                                    "RateControlMode": "QVBR",
                                    "SceneChangeDetect": "TRANSITION_DETECTION"
                                }
                            },
                            "Width": 1280,
                            "Height": 720
                        },
                        "AudioDescriptions": [
                            {
                                "CodecSettings": {
                                    "Codec": "AAC",
                                    "AacSettings": {
                                        "Bitrate": 96000,
                                        "CodingMode": "CODING_MODE_2_0",
                                        "SampleRate": 48000
                                    }
                                }
                            }
                        ],
                        "NameModifier": "_720p"
                    }
                ]
            }
        ]
    }
    
    mc.create_job(
        Role=role_arn,
        Settings=job_settings,
        Queue="Default"
    )


def handler(event, context):
    """POST /albums — creates a new album record in DynamoDB (admin-only)."""
    # Verify the caller is an admin
    denied = require_admin(event)
    if denied:
        return denied
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

        # Prevent creating private albums for the admin account
        if body.get('visibility') == 'private' and body.get('ownerEmail') == 'iant4093@gmail.com':
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Cannot create private albums for the admin account'}),
            }

        album_type = body.get('type', 'photo')
        images = body.get('images', [])
        
        # Extract EXIF data from first 64KB of S3 object dynamically
        if 'IMAGES_BUCKET' in os.environ:
            for img in images:
                raw_key = img.get('rawKey')
                if not raw_key: continue
                try:
                    resp = s3.get_object(Bucket=os.environ['IMAGES_BUCKET'], Key=raw_key, Range='bytes=0-65535')
                    tags = exifread.process_file(io.BytesIO(resp['Body'].read()), details=False)
                    
                    exif_data = {}
                    if 'Image Model' in tags:
                        exif_data['model'] = str(tags['Image Model']).strip()
                    if 'EXIF LensModel' in tags:
                        exif_data['lens'] = str(tags['EXIF LensModel']).strip()
                        
                    if 'EXIF FNumber' in tags:
                        val = tags['EXIF FNumber'].values[0]
                        if val.den != 0:
                            f_val = val.num / val.den
                            exif_data['focalRatio'] = f"f/{f_val:g}"
                            
                    if 'EXIF ExposureTime' in tags:
                        val = tags['EXIF ExposureTime'].values[0]
                        if val.den != 0 and val.num != 0:
                            if val.num >= val.den:
                                exif_data['shutterSpeed'] = f"{val.num / val.den:g}s"
                            else:
                                exif_data['shutterSpeed'] = f"{val.num}/{val.den}s"
                                
                    if 'EXIF ISOSpeedRatings' in tags:
                        exif_data['iso'] = f"ISO {tags['EXIF ISOSpeedRatings']}"
                        
                    if exif_data:
                        img['exif'] = exif_data
                except Exception as e:
                    print(f"EXIF extraction error for {raw_key}: {e}")

        import secrets
        
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
