"""
Backfill EXIF data for all photo album images that are missing it.

Scans all albums in DynamoDB, finds photo images without EXIF data,
downloads the first 64KB of each from S3, extracts EXIF, and updates
the database.

Usage:
    pip install boto3 exifread
    python scripts/backfill_exif.py
"""

import boto3
import exifread
import io

dynamodb = boto3.resource('dynamodb')
s3 = boto3.client('s3')

TABLE_NAME = 'GoldenHour-Albums-prod'
table = dynamodb.Table(TABLE_NAME)

# Automatically find the images bucket
buckets = s3.list_buckets()['Buckets']
try:
    BUCKET_NAME = next(
        b['Name'] for b in buckets
        if b['Name'].startswith('goldenhour-images') and b['Name'].endswith('prod')
    )
except StopIteration:
    print("Error: Could not find goldenhour-images bucket.")
    exit(1)


def format_fraction(tag):
    """Convert an exifread ratio tag to a human-readable string."""
    val = tag.values[0]
    if val.den == 0:
        return str(val.num)
    result = val.num / val.den
    # For shutter speeds like 1/200
    if result < 1 and val.den > 1:
        return f"{val.num}/{val.den}"
    if result.is_integer():
        return str(int(result))
    return f"{result:g}"


def extract_exif(bucket, key):
    """Download first 64KB and extract all EXIF fields matching the Lambda logic."""
    try:
        resp = s3.get_object(Bucket=bucket, Key=key, Range='bytes=0-65535')
        tags = exifread.process_file(io.BytesIO(resp['Body'].read()), details=False)

        exif_info = {}
        if 'Image Model' in tags:
            exif_info['model'] = str(tags['Image Model'])
        if 'EXIF LensModel' in tags:
            exif_info['lens'] = str(tags['EXIF LensModel'])
        if 'EXIF FocalLength' in tags:
            exif_info['focalLength'] = f"{format_fraction(tags['EXIF FocalLength'])}mm"
        if 'EXIF FNumber' in tags:
            exif_info['focalRatio'] = f"f/{format_fraction(tags['EXIF FNumber'])}"
        if 'EXIF ExposureTime' in tags:
            exif_info['shutterSpeed'] = f"{format_fraction(tags['EXIF ExposureTime'])}s"
        if 'EXIF ISOSpeedRatings' in tags:
            exif_info['iso'] = f"ISO {tags['EXIF ISOSpeedRatings']}"

        return exif_info if exif_info else None
    except Exception as e:
        print(f"  -> Error extracting EXIF from {key}: {e}")
        return None


def process_album(item):
    """Process one album: backfill EXIF for any images missing it."""
    images = item.get('images', [])
    album_title = item.get('title', item['albumId'])
    updated = False

    for img in images:
        # Skip images that already have EXIF data
        if img.get('exif'):
            continue

        raw_key = img.get('rawKey')
        if not raw_key:
            continue

        print(f"  Extracting EXIF for: {raw_key}")
        exif_data = extract_exif(BUCKET_NAME, raw_key)
        if exif_data:
            img['exif'] = exif_data
            updated = True
            print(f"    -> {exif_data}")
        else:
            print(f"    -> No EXIF data found")

    if updated:
        table.update_item(
            Key={'albumId': item['albumId']},
            UpdateExpression='SET images = :images',
            ExpressionAttributeValues={':images': images}
        )
        print(f"  ✓ Updated album '{album_title}' in DynamoDB")
    else:
        print(f"  — No changes needed for '{album_title}'")


def main():
    print(f"Table:  {TABLE_NAME}")
    print(f"Bucket: {BUCKET_NAME}")
    print("=" * 60)
    print("Starting full EXIF backfill...\n")

    stats = {'albums_scanned': 0, 'albums_updated': 0, 'images_backfilled': 0}

    response = table.scan()
    items = response.get('Items', [])

    while True:
        for item in items:
            # Skip video albums
            if item.get('type') == 'video':
                continue

            album_title = item.get('title', item['albumId'])
            images = item.get('images', [])
            missing = sum(1 for img in images if not img.get('exif') and img.get('rawKey'))

            stats['albums_scanned'] += 1

            if missing == 0:
                continue

            print(f"\nAlbum: '{album_title}' — {missing} image(s) missing EXIF")
            old_count = sum(1 for img in images if img.get('exif'))
            process_album(item)
            new_count = sum(1 for img in images if img.get('exif'))
            backfilled = new_count - old_count
            if backfilled > 0:
                stats['albums_updated'] += 1
                stats['images_backfilled'] += backfilled

        if 'LastEvaluatedKey' not in response:
            break
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items = response.get('Items', [])

    print("\n" + "=" * 60)
    print(f"Done! Albums scanned: {stats['albums_scanned']}, "
          f"updated: {stats['albums_updated']}, "
          f"images backfilled: {stats['images_backfilled']}")


if __name__ == '__main__':
    main()
