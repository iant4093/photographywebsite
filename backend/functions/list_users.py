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
        query_params = event.get('queryStringParameters') or {}
        pagination_token = query_params.get('paginationToken')
        
        list_params = {
            'UserPoolId': os.environ['COGNITO_USER_POOL_ID'],
            'Limit': 60 # Cognito max limit
        }
        if pagination_token:
            list_params['PaginationToken'] = pagination_token

        response = cognito.list_users(**list_params)

        users = []
        for user in response.get('Users', []):
            attrs = {attr['Name']: attr['Value'] for attr in user['Attributes']}
            users.append({
                'username': user['Username'],
                'email': attrs.get('email', ''),
                'status': user['UserStatus'],
                'created': user['UserCreateDate'].isoformat()
            })

        body_data = {'users': users}
        if 'PaginationToken' in response:
            body_data['paginationToken'] = response['PaginationToken']

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps(body_data)
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
