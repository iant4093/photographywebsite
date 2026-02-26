import json
import os
import boto3

# Cognito client for user management
cognito = boto3.client('cognito-idp')
USER_POOL_ID = os.environ['COGNITO_USER_POOL_ID']

from auth_helpers import require_admin
from email_helpers import send_email


def handler(event, context):
    """POST /users — admin creates a new non-admin Cognito user."""
    denied = require_admin(event)
    if denied:
        return denied
    try:
        body = json.loads(event.get('body', '{}'))
        email = body.get('email')
        password = body.get('password')

        if not email or not password:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'email and password are required'}),
            }

        # Create user in Cognito
        cognito.admin_create_user(
            UserPoolId=USER_POOL_ID,
            Username=email,
            UserAttributes=[
                {'Name': 'email', 'Value': email},
                {'Name': 'email_verified', 'Value': 'true'},
            ],
            TemporaryPassword=password,
            MessageAction='SUPPRESS',
        )
        # Set the permanent password immediately
        cognito.admin_set_user_password(
            UserPoolId=USER_POOL_ID,
            Username=email,
            Password=password,
            Permanent=True,
        )

        portal_url = os.environ.get('FRONTEND_URL', 'https://iantruongphotography.com')
        subject = "Welcome to Ian Truong Photography"
        html = f"""
        <div style="font-family: sans-serif; max-width: 600px; margin: auto;">
            <h2 style="color: #4a4a4a;">Welcome!</h2>
            <p>An account has been created for you to access your private photography galleries.</p>
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p style="margin: 0 0 10px;"><strong>Login Portal:</strong> <a href="{portal_url}/login">{portal_url}/login</a></p>
                <p style="margin: 0 0 10px;"><strong>Email:</strong> {email}</p>
                <p style="margin: 0;"><strong>Password:</strong> {password}</p>
            </div>
        </div>
        """
        send_email(email, subject, html)

        return {
            'statusCode': 201,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'message': f'User {email} created successfully'}),
        }
    except cognito.exceptions.UsernameExistsException:
        return {
            'statusCode': 409,
            'body': json.dumps({'error': 'A user with that email already exists'}),
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }
