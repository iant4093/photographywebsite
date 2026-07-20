"""Minimal Resend email wrapper. Callers must context-escape HTML values."""

import os

import resend

from secret_helpers import resolve_secret


SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "admin@iantruongphotography.com")


def send_email(to_email, subject, html_body):
    resend.api_key = resolve_secret(
        direct_env="RESEND_API_KEY",
        arn_env="RESEND_API_KEY_SECRET_ARN",
        json_keys=("apiKey", "resendApiKey", "RESEND_API_KEY"),
    )
    safe_subject = str(subject).replace("\r", " ").replace("\n", " ")[:200]
    return resend.Emails.send(
        {
            "from": SENDER_EMAIL,
            "to": [to_email],
            "subject": safe_subject,
            "html": html_body,
        }
    )
