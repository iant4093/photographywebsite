"""Trusted EventBridge entry point for daily Drive and public stats refreshes."""

from get_google_drive_usage import refresh_handler
from photography_stats import refresh_photography_stats


def handler(event, context):
    result = refresh_handler(event, context)
    snapshot = refresh_photography_stats()
    return {
        **result,
        "photographyStatsRefreshed": True,
        "photographyStatsGeneratedAt": snapshot["generatedAt"],
    }
