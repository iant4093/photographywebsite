"""Validated, CAPTCHA/rate-limited contact form."""

import os

from email_helpers import send_email
from response_helpers import error_response, internal_error, json_response
from security_helpers import check_rate_limit, sanitize_text, verify_turnstile
from validation_helpers import ValidationError, parse_json_body, require_string, validate_email


def handler(event, context):
    try:
        body = parse_json_body(event, max_bytes=16 * 1024)
        name = require_string(body.get("name"), "name", maximum=120)
        email = validate_email(body.get("email"))
        message = require_string(body.get("message"), "message", maximum=5000)
        token = require_string(body.get("turnstileToken"), "turnstileToken", maximum=4096)
        ip = ((event or {}).get("requestContext", {}).get("http", {}).get("sourceIp") or "unknown")

        if not verify_turnstile(token, ip, expected_action="contact"):
            return error_response(403, "Security verification failed", code="captcha_failed")
        if not check_rate_limit(ip, "contact", max_requests=3, window_seconds=600, fail_closed=True):
            return error_response(429, "Too many contact requests. Please try again later.", code="rate_limited")

        safe_name = sanitize_text(name, maximum=120)
        safe_email = sanitize_text(email, maximum=254)
        safe_message = sanitize_text(message, maximum=5000)
        html_body = f"""
        <div style="font-family:sans-serif;max-width:600px;margin:auto">
            <h2 style="color:#4a4a4a">New Message from Portfolio Website</h2>
            <p><strong>Name:</strong> {safe_name}</p>
            <p><strong>Reply-To:</strong> {safe_email}</p>
            <hr><p><strong>Message:</strong></p>
            <p style="white-space:pre-wrap">{safe_message}</p>
        </div>
        """
        recipient = os.environ.get("CONTACT_RECIPIENT", "iant4093@gmail.com")
        send_email(recipient, f"Portfolio Contact Form: {name}", html_body)
        return json_response(200, {"message": "Thank you! Your message has been sent."})
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_contact")
    except Exception as error:
        return internal_error(context, error, "contact")
