import boto3
import json
import io
import urllib.request
from PIL import Image
import blurhash
from decimal import Decimal

# Configuration
REGION = 'us-west-2'
TABLE_NAME = 'GoldenHour-Albums-prod'
BUCKET_NAME = 'goldenhour-images-428207759706-prod'

dynamodb = boto3.resource('dynamodb', region_name=REGION)
table = dynamodb.Table(TABLE_NAME)
s3 = boto3.client('s3', region_name=REGION)

def process_image(img_data):
    """Generates an 800px thumbnail and a Blurhash from raw image bytes."""
    with Image.open(io.BytesIO(img_data)) as img:
        img = img.convert("RGB")
        width, height = img.size
        
        # Calculate Blurhash
        hash_size = 32
        hash_img = img.copy()
        hash_img.thumbnail((hash_size, hash_size))
        # Component X/Y up to 9 depending on aspect ratio
        componentX = 4
        componentY = max(1, min(4, round(componentX * (height / width))))
        blur_hash = blurhash.encode(hash_img, x_components=componentX, y_components=componentY)

        # Calculate Thumbnail
        MAX_SIZE = 800
        if width > height and width > MAX_SIZE:
            height = int(height * (MAX_SIZE / width))
            width = MAX_SIZE
        elif height > width and height > MAX_SIZE:
            width = int(width * (MAX_SIZE / height))
            height = MAX_SIZE
            
        thumb_img = img.copy()
        thumb_img.thumbnail((width, height), Image.Resampling.LANCZOS)
        
        output = io.BytesIO()
        thumb_img.save(output, format="JPEG", quality=85)
        output.seek(0)
        
        return output.read(), blur_hash, img.width, img.height

def migrate_albums():
    # Scan all albums
    response = table.scan()
    albums = response.get('Items', [])
    
    for album in albums:
        album_id = album['albumId']
        print(f"Processing Album: {album.get('title')} ({album_id})")
        
        # Skip if already migrated
        if 'images' in album and len(album['images']) > 0 and 'thumbKey' in album['images'][0]:
            print("  -> Already migrated. Skipping.")
            continue
            
        s3_prefix = album.get('s3Prefix', f"albums/{album_id}/")
        
        try:
            # 1. List objects in S3
            s3_response = s3.list_objects_v2(Bucket=BUCKET_NAME, Prefix=s3_prefix)
            objects = s3_response.get('Contents', [])
            
            new_images_manifest = []
            cover_thumb_key = ""
            cover_blurhash = ""
            
            # Sort chronologically to match frontend logic
            for i, obj in enumerate(sorted(objects, key=lambda x: x['Key'])):
                key = obj['Key']
                # Skip folders
                if key.endswith('/'): continue
                # Skip existing thumbnails
                if 'thumb_' in key: continue

                print(f"  -> Downloading {key}...")
                
                # Download original image
                response = s3.get_object(Bucket=BUCKET_NAME, Key=key)
                img_data = response['Body'].read()
                
                # Process
                thumb_bytes, b_hash, width, height = process_image(img_data)
                
                # Upload Thumbnail
                filename = key.split('/')[-1]
                thumb_key = f"{s3_prefix}thumb_{filename}"
                print(f"     Uploading thumbnail {thumb_key}...")
                
                s3.put_object(
                    Bucket=BUCKET_NAME,
                    Key=thumb_key,
                    Body=thumb_bytes,
                    ContentType='image/jpeg'
                )
                
                new_images_manifest.append({
                    'rawKey': key,
                    'thumbKey': thumb_key,
                    'blurhash': b_hash,
                    'width': Decimal(str(width)),
                    'height': Decimal(str(height))
                })
                
                # Store cover image info
                if i == 0 or not cover_thumb_key:
                    cover_thumb_key = thumb_key
                    cover_blurhash = b_hash
            
            if len(new_images_manifest) == 0:
                print("  -> No images found to migrate.")
                continue

            # 2. Update DynamoDB
            print(f"  -> Updating DynamoDB record for {album_id}")
            table.update_item(
                Key={'albumId': album_id},
                UpdateExpression="SET images = :images, coverThumbKey = :ctk, coverBlurhash = :cbh",
                ExpressionAttributeValues={
                    ':images': new_images_manifest,
                    ':ctk': cover_thumb_key,
                    ':cbh': cover_blurhash
                }
            )
            print("  -> Success!")
            
        except Exception as e:
            print(f"  -> Error migrating album: {e}")

if __name__ == "__main__":
    migrate_albums()
