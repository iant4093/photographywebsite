import json
from security_helpers import validate_turnstile, check_rate_limit, sanitize_text
from email_helpers import send_email

def handler(event, context):
    try:
        ip = event.get('requestContext', {}).get('http', {}).get('sourceIp', 'unknown_ip')
        body = json.loads(event.get('body', '{}'))
        
        name = sanitize_text(body.get('name', ''))
        email = sanitize_text(body.get('email', ''))
        message = sanitize_text(body.get('message', ''))
        token = body.get('turnstileToken')

        if not name or not email or not message:
            return {'statusCode': 400, 'body': json.dumps({'error': 'Missing contact fields'})}

        # 1. Turnstile explicitly required
        if not validate_turnstile(token, ip):
            return {'statusCode': 403, 'body': json.dumps({'error': 'Invalid CAPTCHA security token. Are you a robot?'})}

        # 2. Rate limit contact requests globally per IP (Max 3 every 10 minutes)
        if not check_rate_limit(ip, 'contact', max_requests=3, window_seconds=600):
            return {'statusCode': 429, 'body': json.dumps({'error': 'Too many contact requests. Please try again later.'})}

        subject = f"Portfolio Contact Form: {name}"
        html_body = f"""
        <div style="font-family: sans-serif; max-width: 600px; margin: auto;">
            <h2 style="color: #4a4a4a;">New Message from Portfolio Website</h2>
            <p><strong>Name:</strong> {name}</p>
            <p><strong>Reply-To:</strong> {email}</p>
            <hr />
            <p><strong>Message:</strong></p>
            <p style="white-space: pre-wrap;">{message}</p>
        </div>
        """
        
        # Forward directly to iant4093@gmail.com
        send_email('iant4093@gmail.com', subject, html_body)

        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Thank you! Your message has been sent.'})
        }
    except Exception as e:
        print(f"Contact API Error: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Internal configuration error.'})
        }
