import os
import boto3

ses = boto3.client('ses')
SENDER_EMAIL = os.environ.get('SENDER_EMAIL', 'hello@iantruong.com')

def send_email(to_email, subject, html_body):
    """Utility function to send an HTML email via Amazon SES."""
    try:
        ses.send_email(
            Source=SENDER_EMAIL,
            Destination={'ToAddresses': [to_email]},
            Message={
                'Subject': {'Data': subject},
                'Body': {'Html': {'Data': html_body}}
            }
        )
        print(f"Email sent successfully to {to_email}")
    except Exception as e:
        print(f"Error sending email to {to_email}: {e}")
