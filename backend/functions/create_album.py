import json
import os
import boto3

# DynamoDB resource for creating album records
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])

from auth_helpers import require_admin
from email_helpers import send_email


def handler(event, context):
    """POST /albums — creates a new album record in DynamoDB (admin-only)."""
    # Verify the caller is an admin
    denied = require_admin(event)
    if denied:
        return denied
    try:
        body = json.loads(event.get('body', '{}'))

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

        # Write the album record with visibility and ownerEmail
        item = {
            'albumId': body['albumId'],
            'title': body['title'],
            'description': body.get('description', ''),
            'category': body.get('category', 'Uncategorized'),
            'coverImageUrl': body.get('coverImageUrl', ''),
            's3Prefix': body['s3Prefix'],
            'createdAt': body['createdAt'],
            'visibility': body.get('visibility', 'public'),
            'ownerEmail': body.get('ownerEmail', ''),
        }
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
