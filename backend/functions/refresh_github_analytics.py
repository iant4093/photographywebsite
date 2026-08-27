"""Trusted EventBridge entry point for hourly GitHub analytics refreshes."""

from github_analytics import SCHEDULED_REFRESH_EVENT, build_report, load_cached_report, store_report


def handler(event, _context):
    if not isinstance(event, dict) or event != SCHEDULED_REFRESH_EVENT:
        raise ValueError("GitHub analytics refresh event is invalid")
    previous = load_cached_report()
    report = build_report(previous)
    store_report(report)
    return {"refreshed": True, "generatedAt": report["generatedAt"], "headSha": report["repository"]["headSha"]}
