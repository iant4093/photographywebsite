import json
import os
import boto3

# Cognito and DynamoDB/S3 for cascade-deleting a user and their data
cognito = boto3.client('cognito-idp')
dynamodb = boto3.resource('dynamodb')
s3 = boto3.client('s3')
USER_POOL_ID = os.environ['COGNITO_USER_POOL_ID']
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])
BUCKET = os.environ['IMAGES_BUCKET']
from auth_helpers import require_admin


def handler(event, context):
    """DELETE /users/{email} — deletes Cognito user + all their private albums + S3 objects."""
    denied = require_admin(event)
    if denied:
        return denied
    try:
        email = event['pathParameters']['email']

        # 1. Find all private albums owned by this user
        response = table.scan()
        albums = [
            a for a in response.get('Items', [])
            if a.get('visibility') == 'private' and a.get('ownerEmail') == email
        ]

        # 2. Delete all S3 objects and DynamoDB records for each album
        for album in albums:
            s3_prefix = album.get('s3Prefix', f'albums/{album["albumId"]}/')
            s3_resp = s3.list_objects_v2(Bucket=BUCKET, Prefix=s3_prefix)
            objects = s3_resp.get('Contents', [])
            if objects:
                s3.delete_objects(
                    Bucket=BUCKET,
                    Delete={'Objects': [{'Key': obj['Key']} for obj in objects]},
                )
            table.delete_item(Key={'albumId': album['albumId']})

        # 3. Delete the Cognito user
        cognito.admin_delete_user(
            UserPoolId=USER_POOL_ID,
            Username=email,
        )

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({
                'message': f'User {email} deleted',
                'albumsDeleted': len(albums),
            }),
        }
    except cognito.exceptions.UserNotFoundException:
        return {
            'statusCode': 404,
            'body': json.dumps({'error': 'User not found'}),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
