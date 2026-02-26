import json
import os
import boto3

# Cognito client for listing users
cognito = boto3.client('cognito-idp')
USER_POOL_ID = os.environ['COGNITO_USER_POOL_ID']

from auth_helpers import require_admin


def handler(event, context):
    """GET /users — lists all Cognito users (admin-only)."""
    denied = require_admin(event)
    if denied:
        return denied
    try:
        response = cognito.list_users(UserPoolId=USER_POOL_ID)

        # Extract relevant user info
        users = []
        for user in response.get('Users', []):
            attrs = {a['Name']: a['Value'] for a in user.get('Attributes', [])}
            users.append({
                'email': attrs.get('email', ''),
                'status': user.get('UserStatus', ''),
                'enabled': user.get('Enabled', False),
                'createdAt': user.get('UserCreateDate', '').isoformat() if user.get('UserCreateDate') else '',
            })

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(users),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
