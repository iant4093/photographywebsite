"""Trusted EventBridge entry point for the daily Google Drive usage refresh."""

from get_google_drive_usage import refresh_handler


def handler(event, context):
    return refresh_handler(event, context)
