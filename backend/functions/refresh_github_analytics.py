"""Trusted EventBridge entry point for hourly GitHub analytics refreshes."""

import datetime as dt
import logging

from github_analytics import (
    REPOSITORIES,
    SCHEDULED_REFRESH_EVENT,
    build_report,
    load_cached_report,
    refresh_slot,
    repositories_for_refresh,
    store_report,
)

logger = logging.getLogger("photography_api.github_analytics_refresh")
# A report takes at most eight REST requests against GitHub's limit of 60 per hour.
MAX_REPORTS_PER_RUN = 7


def _already_refreshed(report, slot):
    try:
        generated = dt.datetime.fromisoformat(report["generatedAt"].replace("Z", "+00:00"))
        return generated >= slot
    except (AttributeError, KeyError, TypeError, ValueError):
        return False


def handler(event, _context):
    if not isinstance(event, dict) or event != SCHEDULED_REFRESH_EVENT:
        raise ValueError("GitHub analytics refresh event is invalid")
    slot = refresh_slot(dt.datetime.now(dt.timezone.utc))
    scheduled = repositories_for_refresh(slot)
    unscheduled = [name for name in REPOSITORIES if name not in scheduled]
    refreshed = []
    failed = []
    attempts = 0
    for repository in (*scheduled, *unscheduled):
        if attempts == MAX_REPORTS_PER_RUN:
            break
        try:
            previous = load_cached_report(repository)
            # Give new repositories a first snapshot even outside their batches.
            if (repository in unscheduled and previous is not None) or _already_refreshed(previous, slot):
                continue
            attempts += 1
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
