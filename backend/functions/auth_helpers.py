import json


def require_admin(event):
    """Check if the caller is in the Admins Cognito group.

    Returns None if authorized, or a 403 response dict if not.
    """
    claims = (
        event.get('requestContext', {})
        .get('authorizer', {})
        .get('jwt', {})
        .get('claims', {})
    )
    groups = claims.get('cognito:groups', '')
    if 'Admins' not in groups:
        return {
            'statusCode': 403,
            'body': json.dumps({'error': 'Forbidden — admin access required'}),
        }
    return None


def get_caller_email(event):
    """Extract the caller's email from the JWT claims."""
    claims = (
        event.get('requestContext', {})
        .get('authorizer', {})
        .get('jwt', {})
        .get('claims', {})
    )
    return claims.get('email', '')
