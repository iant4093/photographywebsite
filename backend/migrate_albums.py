import os
import io
import boto3
import exifread

# Set up clients
dynamodb = boto3.resource('dynamodb', region_name='us-west-2')
s3 = boto3.client('s3', region_name='us-west-2')

TABLE_NAME = 'GoldenHour-Albums-prod'
BUCKET_NAME = 'goldenhour-images-428207759706-prod'

table = dynamodb.Table(TABLE_NAME)

def migrate():
    print("Starting EXIF migration...")
    
    # 1. Scan all albums
    response = table.scan()
    albums = response.get('Items', [])
    
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        albums.extend(response.get('Items', []))
        
    print(f"Found {len(albums)} albums.")
    
    for album in albums:
        album_id = album['albumId']
        images = album.get('images', [])
        
        needs_update = False
        
        for img in images:
            # If it already has exif data, or no rawKey (demo images), skip it
            if 'exif' in img or not img.get('rawKey'):
                continue
                
            raw_key = img['rawKey']
            print(f"Processing image {raw_key} in album {album_id}...")
            
            try:
                # Fetch first 64KB for EXIF
                resp = s3.get_object(Bucket=BUCKET_NAME, Key=raw_key, Range='bytes=0-65535')
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
                    needs_update = True
                    print(f"  Extracted EXIF: {exif_data}")
                else:
                    print(f"  No EXIF found for {raw_key}")
                    
            except Exception as e:
                print(f"  Error processing {raw_key}: {e}")
                
        if needs_update:
            print(f"Updating album {album_id} in DynamoDB...")
            table.update_item(
                Key={'albumId': album_id},
                UpdateExpression="SET images = :i",
                ExpressionAttributeValues={':i': images}
            )
            print(f"Album {album_id} updated successfully.")
            
    print("Migration complete!")

if __name__ == '__main__':
    migrate()
