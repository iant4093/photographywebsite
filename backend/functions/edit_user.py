import json
import os
import boto3

# Cognito and DynamoDB for updating user credentials and album ownership
cognito = boto3.client('cognito-idp')
dynamodb = boto3.resource('dynamodb')
USER_POOL_ID = os.environ['COGNITO_USER_POOL_ID']
table = dynamodb.Table(os.environ['ALBUMS_TABLE'])
from auth_helpers import require_admin


def handler(event, context):
    """PUT /users/{email} — updates a Cognito user's email and/or password, migrates albums."""
    denied = require_admin(event)
    if denied:
        return denied
    try:
        old_email = event['pathParameters']['email']
        body = json.loads(event.get('body', '{}'))
        new_email = body.get('email', '').strip()
        new_password = body.get('password', '').strip()

        if not new_email and not new_password:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Provide email and/or password to update'}),
            }

        # Update email if changed
        if new_email and new_email != old_email:
            cognito.admin_update_user_attributes(
                UserPoolId=USER_POOL_ID,
                Username=old_email,
                UserAttributes=[
                    {'Name': 'email', 'Value': new_email},
                    {'Name': 'email_verified', 'Value': 'true'},
                ],
            )

            # Migrate all private albums from old email to new email
            response = table.scan()
            albums = [
                a for a in response.get('Items', [])
                if a.get('visibility') == 'private' and a.get('ownerEmail') == old_email
            ]
            for album in albums:
                table.update_item(
                    Key={'albumId': album['albumId']},
                    UpdateExpression='SET ownerEmail = :email',
                    ExpressionAttributeValues={':email': new_email},
                )

        # Update password if provided
        if new_password:
            cognito.admin_set_user_password(
                UserPoolId=USER_POOL_ID,
                Username=new_email or old_email,
                Password=new_password,
                Permanent=True,
            )

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'message': f'User updated successfully'}),
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
