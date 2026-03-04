import json
import os
import boto3

# DynamoDB resource for scanning the Albums table
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])
BUCKET = os.environ['IMAGES_BUCKET']
s3 = boto3.client('s3')

from decimal import Decimal
class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return int(obj) if obj % 1 == 0 else float(obj)
        return super(DecimalEncoder, self).default(obj)


def handler(event, context):
    """GET /albums — returns albums filtered by visibility and ownerEmail."""
    try:
        # Parse optional query params
        params = event.get('queryStringParameters') or {}
        visibility = params.get('visibility', 'public')
        owner_email = params.get('ownerEmail', '')

        # Filter by visibility or ownerEmail using GSI
        if owner_email:
            response = table.query(
                IndexName='ownerEmail-index',
                KeyConditionExpression=boto3.dynamodb.conditions.Key('ownerEmail').eq(owner_email)
            )
            # Since owner can be public or private albums they own, we might still need to filter by visibility
            # if specific visibility was passed, though usually user requests all their own albums.
            albums = response.get('Items', [])
            if visibility and visibility != 'all': # 'all' means no visibility filter
                albums = [item for item in albums if item.get('visibility') == visibility]
        elif visibility == 'all':
            # If 'all' visibility is requested without owner_email, we still need to scan or query all.
            # For now, let's do a full scan if 'all' is requested and no owner_email.
            # In a real-world scenario, you might have an 'all-albums-index' or handle admin access differently.
            response = table.scan()
            albums = response.get('Items', [])
        else:
            # Query by visibility index directly (e.g., 'public' or 'unlisted')
            response = table.query(
                IndexName='visibility-index',
                KeyConditionExpression=boto3.dynamodb.conditions.Key('visibility').eq(visibility)
            )
            albums = response.get('Items', [])

        # Sort by createdAt descending (newest first)
        albums.sort(key=lambda a: a.get('createdAt', ''), reverse=True)

        cf_domain = os.environ.get('CLOUDFRONT_DOMAIN', f'{BUCKET}.s3.amazonaws.com')
        # Convert coverImageUrl from S3 key to full public URL
        for album in albums:
            # Provide image count for frontend structural routing
            album['imageCount'] = len(album.get('images', []))
            
            cover = album.get('coverImageUrl', '')
            if cover and not cover.startswith('http'):
                album['coverImageUrl'] = f'https://{cf_domain}/{cover}'
            elif not cover:
                # Auto-set cover to first image in the album's S3 prefix
                s3_prefix = album.get('s3Prefix', '')
                if s3_prefix:
                    s3_resp = s3.list_objects_v2(Bucket=BUCKET, Prefix=s3_prefix, MaxKeys=2)
                    for obj in s3_resp.get('Contents', []):
                        if not obj['Key'].endswith('/'):
                            album['coverImageUrl'] = f'https://{cf_domain}/{obj["Key"]}'
                            break

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(albums, cls=DecimalEncoder),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
