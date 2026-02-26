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

        # Extract EXIF data from first 64KB of S3 object dynamically
        if 'IMAGES_BUCKET' in os.environ:
            for img in new_images:
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
