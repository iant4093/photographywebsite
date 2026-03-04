import json
import os
import io
import boto3
import exifread

# DynamoDB and S3 resources
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])
s3 = boto3.client('s3')

from auth_helpers import require_admin

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
            for img in new_images:
                raw_key = img.get('rawKey')
                if not raw_key: continue

                if album_type == 'video':
                    # S3 input URI format: s3://bucket/key
                    s3_input_uri = f"s3://{bucket}/{raw_key}"
                    base_name = raw_key.rsplit('.', 1)[0]
                    s3_output_prefix = f"s3://{bucket}/{base_name}_hls/"
                    
                    try:
                        start_mediaconvert_job(s3_input_uri, s3_output_prefix)
                        filename = raw_key.split('/')[-1].rsplit('.', 1)[0]
                        img['hlsUrl'] = f"{base_name}_hls/{filename}.m3u8"
                    except Exception as e:
                        print(f"Failed to start MediaConvert for {raw_key}: {e}")
                else:
                    # Photo EXIF extraction
                    try:
                        resp = s3.get_object(Bucket=bucket, Key=raw_key, Range='bytes=0-65535')
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
