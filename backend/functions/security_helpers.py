import os
import time
import json
import urllib.request
import urllib.parse
import html
import boto3

table = boto3.resource('dynamodb').Table(os.environ['RATE_LIMIT_TABLE'])
TURNSTILE_SECRET = os.environ.get('TURNSTILE_SECRET_KEY')

def verify_turnstile(token, ip_address=None):
    """
    Verifies a Cloudflare Turnstile CAPTCHA token against the site verify API.
    
    Args:
        token (str): The CAPTCHA token provided by the frontend.
        ip_address (str, optional): The physical IP address of the client making the request.

    Returns:
        bool: True if the token is valid, False otherwise.
    """
    if not token:
        print("Missing Turnstile token")
        return False
        
    data = {
        'secret': TURNSTILE_SECRET,
        'response': token
    }
    if ip:
        data['remoteip'] = ip

    try:
        url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
        req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode('utf-8'))
        response = urllib.request.urlopen(req)
        result = json.loads(response.read().decode('utf-8'))
        success = result.get('success', False)
        if success:
            print("Turnstile validation successful")
        else:
            print(f"Turnstile validation failed: {result}")
        return success
    except Exception as e:
        print(f"Turnstile error: {e}")
        return False

def check_rate_limit(identifier, action, max_requests, window_seconds):
    """
    Checks if a specific action by an identifier has exceeded its rate limit using DynamoDB.
    Increments an atomic counter and auto-expires using TTL.

    Args:
        identifier (str): The unique identifier for the caller (e.g., IP address, username).
        action (str): The type of action being performed (e.g., 'login', 'contact').
        max_requests (int): Maximum allowed attempts within the window.
        window_seconds (int): Time window for the limit in seconds.

    Returns:
        bool: True if the action is allowed (under limit), False if rate limited.
    """
    key_id = f"{identifier}#{action}"
    now = int(time.time())
    
    try:
        response = table.update_item(
            Key={'identifier': key_id},
            UpdateExpression="SET #cnt = if_not_exists(#cnt, :start) + :inc, #ttl = if_not_exists(#ttl, :exp)",
            ExpressionAttributeNames={'#cnt': 'count', '#ttl': 'ttl'},
            ExpressionAttributeValues={':start': 0, ':inc': 1, ':exp': now + window_seconds},
            ReturnValues="UPDATED_NEW"
        )
        current_count = response['Attributes']['count']
        if current_count > max_requests:
            print(f"Rate limit exceeded for {key_id}: {current_count} > {max_requests}")
            return False
        return True
    except Exception as e:
        print(f"Rate limit DynamoDB error: {e}")
        # Fail open
        return True

def sanitize_text(text):
    if not text:
        return ""
    # Convert string and html escape
    return html.escape(str(text))
