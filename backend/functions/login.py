import os
import json
import boto3
from security_helpers import validate_turnstile, check_rate_limit

cognito = boto3.client('cognito-idp')
USER_POOL_ID = os.environ['COGNITO_USER_POOL_ID']
CLIENT_ID = os.environ['COGNITO_CLIENT_ID']

def handler(event, context):
    try:
        body = json.loads(event.get('body', '{}'))
        email = body.get('email')
        password = body.get('password')
        turnstile_token = body.get('turnstileToken')
        ip = event.get('requestContext', {}).get('http', {}).get('sourceIp')

        if not email or not password:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Email and password are required.'})
            }

        # 1. Validate Turnstile
        if not validate_turnstile(turnstile_token, ip):
            return {
                'statusCode': 403,
                'body': json.dumps({'error': 'Invalid CAPTCHA security token. Are you a robot?'})
            }

        # 2. Rate Limit by IP
        if not check_rate_limit(ip, 'login_attempt_ip', max_requests=10, window_seconds=600):
            return {
                'statusCode': 429,
                'body': json.dumps({'error': 'Too many login attempts from this IP. Please try again later.'})
            }

        # 3. Rate Limit by Username (to prevent brute force)
        if not check_rate_limit(email, 'login_attempt_user', max_requests=5, window_seconds=300):
            return {
                'statusCode': 429,
                'body': json.dumps({'error': 'Too many login attempts for this account. Please try again later.'})
            }

        # 4. Authenticate with Cognito
        try:
            response = cognito.admin_initiate_auth(
                UserPoolId=USER_POOL_ID,
                ClientId=CLIENT_ID,
                AuthFlow='ADMIN_NO_SRP_AUTH',
                AuthParameters={
                    'USERNAME': email,
                    'PASSWORD': password
                }
            )
            
            # Return tokens or challenges
            return {
                'statusCode': 200,
                'headers': {
                    'Content-Type': 'application/json'
                },
                'body': json.dumps(response, default=str)
            }

        except cognito.exceptions.NotAuthorizedException:
            return {
                'statusCode': 401,
                'body': json.dumps({'error': 'Incorrect email or password.'})
            }
        except cognito.exceptions.UserNotFoundException:
            return {
                'statusCode': 401,
                'body': json.dumps({'error': 'Incorrect email or password.'})
            }
        except Exception as e:
            print(f"Cognito auth error: {e}")
            return {
                'statusCode': 500,
                'body': json.dumps({'error': str(e)})
            }

    except Exception as e:
        print(f"Login handler error: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Internal server error'})
        }
