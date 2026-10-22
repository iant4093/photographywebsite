"""Trusted EventBridge entry point for hourly GitHub analytics refreshes."""

import logging

from github_analytics import REPOSITORIES, SCHEDULED_REFRESH_EVENT, build_report, load_cached_report, store_report

logger = logging.getLogger("photography_api.github_analytics_refresh")


def handler(event, _context):
    if not isinstance(event, dict) or event != SCHEDULED_REFRESH_EVENT:
        raise ValueError("GitHub analytics refresh event is invalid")
    refreshed = []
    failed = []
    for repository in REPOSITORIES:
        try:
            previous = load_cached_report(repository)
            report = build_report(previous, repository=repository)
            store_report(report, repository)
            refreshed.append(repository)
        except Exception as error:
            # Preserve the last successful snapshot and still refresh the other
            # repositories. Raising afterwards retains EventBridge retries.
            logger.error("github_refresh_failed repository=%s error_type=%s", repository, type(error).__name__)
            failed.append(repository)
    if failed:
        raise RuntimeError("GitHub analytics refresh failed for: " + ", ".join(failed))
    return {"refreshed": True, "repositories": refreshed}
