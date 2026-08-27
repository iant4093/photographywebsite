"""Read-only GitHub repository analytics collector and cache helpers."""

from __future__ import annotations

import datetime as dt
import io
import json
import logging
import os
import re
import statistics
import urllib.error
import urllib.request
import zipfile

import boto3


logger = logging.getLogger("photography_api.github_analytics")
logger.setLevel(logging.INFO)

CACHE_KEY = "github-analytics-v1"
CACHE_SCHEMA_VERSION = 1
MAX_CACHE_PAYLOAD_BYTES = 300_000
MAX_PROVIDER_RESPONSE_BYTES = 5_000_000
MAX_ARCHIVE_BYTES = 50_000_000
MAX_ARCHIVE_EXPANDED_BYTES = 160_000_000
MAX_ARCHIVE_FILES = 25_000
MAX_SOURCE_FILE_BYTES = 3_000_000
GITHUB_API_VERSION = "2026-03-10"
SCHEDULED_REFRESH_EVENT = {
    "source": "ian.photography.github-analytics-refresh",
    "action": "refresh",
}

OWNER = os.environ.get("GITHUB_REPOSITORY_OWNER", "iant4093").strip()
REPOSITORY = os.environ.get("GITHUB_REPOSITORY_NAME", "photographywebsite").strip()
BRANCH = os.environ.get("GITHUB_REPOSITORY_BRANCH", "main").strip()
API_BASE = "https://api.github.com"
ARCHIVE_BASE = "https://codeload.github.com"

cache_table = boto3.resource("dynamodb").Table(os.environ["GITHUB_ANALYTICS_CACHE_TABLE"])

_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_LINK_LAST_RE = re.compile(r"[?&]page=(\d+)>; rel=\"last\"")
_SOURCE_EXTENSIONS = {
    ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".ts": "TypeScript", ".tsx": "TypeScript", ".py": "Python", ".css": "CSS",
    ".scss": "SCSS", ".html": "HTML", ".sh": "Shell", ".yaml": "YAML", ".yml": "YAML",
    ".json": "JSON", ".toml": "TOML",
}
_EXCLUDED_PARTS = {
    ".git", ".aws-sam", "node_modules", "dist", "build", "coverage", "vendor",
    ".local-redesigns", "website_review", "__pycache__",
}
_EXCLUDED_NAMES = {
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
}


class ProviderContractError(ValueError):
    """GitHub returned data outside the collector's narrow public contract."""


def _utc_now():
    return dt.datetime.now(dt.timezone.utc)


def _iso(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_configuration():
    if not all(_SAFE_NAME_RE.fullmatch(value or "") for value in (OWNER, REPOSITORY, BRANCH)):
        raise ProviderContractError("GitHub repository configuration is invalid")


def _read_bounded(response, maximum):
    content_length = response.headers.get("Content-Length")
    if content_length:
        try:
            if int(content_length) > maximum:
                raise ProviderContractError("GitHub response exceeded the safe size limit")
        except ValueError:
            raise ProviderContractError("GitHub response length was invalid") from None
    payload = response.read(maximum + 1)
    if len(payload) > maximum:
        raise ProviderContractError("GitHub response exceeded the safe size limit")
    return payload


def _request(path, *, accepted_statuses=(200,)):
    if not isinstance(path, str) or not path.startswith("/repos/") or "\n" in path or "\r" in path:
        raise ProviderContractError("GitHub request path is invalid")
    request = urllib.request.Request(
        API_BASE + path,
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": "IanTruongPhotography-GitHubAnalytics",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            if not response.geturl().startswith(API_BASE + "/"):
                raise ProviderContractError("GitHub API redirect was rejected")
            status = int(response.status)
            if status not in accepted_statuses:
                raise ProviderContractError("GitHub returned an unexpected status")
            raw = _read_bounded(response, MAX_PROVIDER_RESPONSE_BYTES)
            headers = dict(response.headers.items())
    except urllib.error.HTTPError as error:
        if error.code in accepted_statuses:
            raw = _read_bounded(error, MAX_PROVIDER_RESPONSE_BYTES)
            status = error.code
            headers = dict(error.headers.items())
        else:
            raise ProviderContractError("GitHub request failed") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ProviderContractError("GitHub request failed") from None
    if not raw and status == 202:
        return status, None, headers
    try:
        return status, json.loads(raw), headers
    except (UnicodeDecodeError, ValueError):
        raise ProviderContractError("GitHub returned invalid JSON") from None


def _dict(value, label):
    if not isinstance(value, dict):
        raise ProviderContractError(f"GitHub {label} response was invalid")
    return value


def _list(value, label):
    if not isinstance(value, list):
        raise ProviderContractError(f"GitHub {label} response was invalid")
    return value


def _text(value, maximum=300):
    return str(value or "").strip()[:maximum]


def _integer(value, minimum=0, maximum=9_223_372_036_854_775_807):
    if isinstance(value, bool):
        return minimum
    try:
        number = int(value)
    except (TypeError, ValueError):
        return minimum
    return min(maximum, max(minimum, number))


def _recent_commits(payload):
    result = []
    for item in _list(payload, "commits")[:10]:
        item = _dict(item, "commit")
        commit = _dict(item.get("commit"), "commit detail")
        author_detail = commit.get("author") if isinstance(commit.get("author"), dict) else {}
        actor = item.get("author") if isinstance(item.get("author"), dict) else {}
        sha = _text(item.get("sha"), 40)
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            continue
        message = _text(commit.get("message"), 400).splitlines()[0]
        result.append({
            "sha": sha,
            "shortSha": sha[:7],
            "message": message,
            "author": _text(actor.get("login") or author_detail.get("name") or "Unknown", 100),
            "date": _text(author_detail.get("date"), 64),
            "url": _text(item.get("html_url"), 500),
            "verified": bool((commit.get("verification") or {}).get("verified")),
        })
    return result


def _recent_runs(payload):
    runs = _list(_dict(payload, "workflow runs").get("workflow_runs"), "workflow runs")[:30]
    result = []
    for item in runs:
        item = _dict(item, "workflow run")
        started = _text(item.get("run_started_at"), 64)
        updated = _text(item.get("updated_at"), 64)
        duration = None
        try:
            duration = max(0, round((dt.datetime.fromisoformat(updated.replace("Z", "+00:00")) - dt.datetime.fromisoformat(started.replace("Z", "+00:00"))).total_seconds()))
        except (TypeError, ValueError):
            pass
        result.append({
            "id": _integer(item.get("id")),
            "name": _text(item.get("name") or item.get("display_title") or "Workflow", 160),
            "title": _text(item.get("display_title"), 240),
            "event": _text(item.get("event"), 50),
            "status": _text(item.get("status"), 40),
            "conclusion": _text(item.get("conclusion"), 40),
            "branch": _text(item.get("head_branch"), 100),
            "sha": _text(item.get("head_sha"), 40),
            "createdAt": _text(item.get("created_at"), 64),
            "updatedAt": updated,
            "durationSeconds": duration,
            "url": _text(item.get("html_url"), 500),
        })
    return result


def _workflow_summary(runs):
    terminal = [run for run in runs if run["status"] == "completed" and run["conclusion"] not in ("", "skipped", "neutral")]
    successes = sum(run["conclusion"] == "success" for run in terminal)
    durations = [run["durationSeconds"] for run in terminal if isinstance(run["durationSeconds"], int)]
    return {
        "successRate": round(successes / len(terminal) * 100, 1) if terminal else None,
        "successfulRuns": successes,
        "completedRuns": len(terminal),
        "medianDurationSeconds": round(statistics.median(durations)) if durations else None,
        "latestConclusion": runs[0]["conclusion"] if runs else "",
    }


def _commit_total(headers, returned_count):
    link = headers.get("Link") or headers.get("link") or ""
    matches = _LINK_LAST_RE.findall(link)
    return _integer(matches[-1], 0) if matches else returned_count


def _language_summary(payload):
    values = _dict(payload, "languages")
    total = sum(_integer(value) for value in values.values())
    return [
        {"name": _text(name, 80), "bytes": _integer(value), "percent": round(_integer(value) / total * 100, 1) if total else 0}
        for name, value in sorted(values.items(), key=lambda item: (-_integer(item[1]), str(item[0]).lower()))
    ]


def _activity(payload, previous):
    if payload is None:
        return previous if isinstance(previous, dict) else {"status": "preparing", "weeks": []}
    weeks = []
    for row in _list(payload, "code frequency")[-52:]:
        if not isinstance(row, list) or len(row) != 3:
            raise ProviderContractError("GitHub code frequency response was invalid")
        weeks.append({"week": _integer(row[0]), "additions": _integer(row[1]), "deletions": abs(int(row[2])) if not isinstance(row[2], bool) else 0})
    return {"status": "ready", "weeks": weeks}


def _source_area(path):
    normalized = path.lower()
    name = normalized.rsplit("/", 1)[-1]
    if "/tests/" in f"/{normalized}" or ".test." in name or name.startswith("test_") or name.endswith("_test.py"):
        return "Tests"
    if normalized.startswith("src/"):
        return "Frontend"
    if normalized.startswith("ops/") or normalized.startswith(".github/") or normalized in {"backend/template.yaml", "backend/makefile"}:
        return "Infrastructure & Ops"
    if normalized.startswith("backend/"):
        return "Backend"
    return "Other"


def _source_extension(path):
    name = path.rsplit("/", 1)[-1].lower()
    if name in _EXCLUDED_NAMES or ".min." in name:
        return None
    for extension, language in _SOURCE_EXTENSIONS.items():
        if name.endswith(extension):
            return extension, language
    return None


def _count_archive(sha):
    if not re.fullmatch(r"[0-9a-f]{40}", sha or ""):
        raise ProviderContractError("GitHub archive revision was invalid")
    url = f"{ARCHIVE_BASE}/{OWNER}/{REPOSITORY}/zip/{sha}"
    request = urllib.request.Request(url, headers={"User-Agent": "IanTruongPhotography-GitHubAnalytics"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.geturl().split("?", 1)[0] != url:
                raise ProviderContractError("GitHub archive redirect was rejected")
            raw = _read_bounded(response, MAX_ARCHIVE_BYTES)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        raise ProviderContractError("GitHub archive could not be read") from None

    areas = {name: 0 for name in ("Frontend", "Backend", "Infrastructure & Ops", "Tests", "Other")}
    languages = {}
    files = 0
    expanded = 0
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
        members = archive.infolist()
        if len(members) > MAX_ARCHIVE_FILES:
            raise ProviderContractError("GitHub archive contained too many files")
        for member in members:
            if member.is_dir():
                continue
            relative = member.filename.split("/", 1)[-1] if "/" in member.filename else member.filename
            parts = set(relative.lower().split("/"))
            extension = _source_extension(relative)
            if parts & _EXCLUDED_PARTS or not extension or member.file_size > MAX_SOURCE_FILE_BYTES:
                continue
            expanded += member.file_size
            if expanded > MAX_ARCHIVE_EXPANDED_BYTES:
                raise ProviderContractError("GitHub archive expanded beyond the safe limit")
            content = archive.read(member)
            if b"\x00" in content[:4096]:
                continue
            nonblank = sum(bool(line.strip()) for line in content.decode("utf-8", errors="ignore").splitlines())
            if not nonblank:
                continue
            files += 1
            area = _source_area(relative)
            areas[area] += nonblank
            language = extension[1]
            languages[language] = languages.get(language, 0) + nonblank
    except (zipfile.BadZipFile, RuntimeError):
        raise ProviderContractError("GitHub archive was invalid") from None
    return {
        "revision": sha,
        "method": "Nonblank source lines; generated, dependency, lock, build, and media files excluded",
        "total": sum(areas.values()),
        "files": files,
        "areas": [{"name": name, "lines": value} for name, value in areas.items()],
        "languages": [{"name": name, "lines": value} for name, value in sorted(languages.items(), key=lambda item: (-item[1], item[0]))],
    }


def build_report(previous=None):
    _validate_configuration()
    previous = previous if isinstance(previous, dict) else {}
    prefix = f"/repos/{OWNER}/{REPOSITORY}"
    _, repo_payload, _ = _request(prefix)
    _, commits_payload, _ = _request(f"{prefix}/commits?sha={BRANCH}&per_page=10")
    _, count_payload, count_headers = _request(f"{prefix}/commits?sha={BRANCH}&per_page=1")
    since = _iso(_utc_now() - dt.timedelta(days=30))
    _, recent_count_payload, recent_count_headers = _request(f"{prefix}/commits?sha={BRANCH}&since={since}&per_page=1")
    _, languages_payload, _ = _request(f"{prefix}/languages")
    _, runs_payload, _ = _request(f"{prefix}/actions/runs?branch={BRANCH}&per_page=30")
    activity_status, activity_payload, _ = _request(f"{prefix}/stats/code_frequency", accepted_statuses=(200, 202))

    repo = _dict(repo_payload, "repository")
    commits = _recent_commits(commits_payload)
    if not commits:
        raise ProviderContractError("GitHub returned no branch commits")
    head_sha = commits[0]["sha"]
    previous_loc = previous.get("loc") if isinstance(previous.get("loc"), dict) else None
    loc = previous_loc if previous_loc and previous_loc.get("revision") == head_sha else _count_archive(head_sha)
    runs = _recent_runs(runs_payload)
    activity = _activity(activity_payload if activity_status == 200 else None, previous.get("activity"))
    now = _utc_now()
    return {
        "schemaVersion": CACHE_SCHEMA_VERSION,
        "generatedAt": _iso(now),
        "repository": {
            "name": _text(repo.get("name"), 100),
            "fullName": _text(repo.get("full_name"), 210),
            "url": _text(repo.get("html_url"), 500),
            "description": _text(repo.get("description"), 300),
            "defaultBranch": _text(repo.get("default_branch"), 100),
            "visibility": _text(repo.get("visibility"), 30),
            "createdAt": _text(repo.get("created_at"), 64),
            "pushedAt": _text(repo.get("pushed_at"), 64),
            "sizeKb": _integer(repo.get("size")),
            "stars": _integer(repo.get("stargazers_count")),
            "forks": _integer(repo.get("forks_count")),
            "openIssues": _integer(repo.get("open_issues_count")),
            "headSha": head_sha,
        },
        "totalCommits": _commit_total(count_headers, len(_list(count_payload, "commit count"))),
        "commits30d": _commit_total(recent_count_headers, len(_list(recent_count_payload, "recent commit count"))),
        "recentCommits": commits,
        "languages": _language_summary(languages_payload),
        "loc": loc,
        "workflow": _workflow_summary(runs),
        "recentRuns": runs[:15],
        "activity": activity,
    }


def load_cached_report():
    response = cache_table.get_item(Key={"cacheKey": CACHE_KEY}, ConsistentRead=True)
    item = response.get("Item")
    if not isinstance(item, dict):
        return None
    payload = item.get("payload")
    if not isinstance(payload, str) or not 1 <= len(payload.encode("utf-8")) <= MAX_CACHE_PAYLOAD_BYTES:
        return None
    try:
        report = json.loads(payload)
    except (TypeError, ValueError):
        return None
    if not isinstance(report, dict) or report.get("schemaVersion") != CACHE_SCHEMA_VERSION:
        return None
    return report


def store_report(report):
    payload = json.dumps(report, separators=(",", ":"), sort_keys=True)
    if len(payload.encode("utf-8")) > MAX_CACHE_PAYLOAD_BYTES:
        raise ValueError("GitHub analytics cache payload exceeded the safe limit")
    cache_table.put_item(Item={
        "cacheKey": CACHE_KEY,
        "schemaVersion": CACHE_SCHEMA_VERSION,
        "generatedAt": report["generatedAt"],
        "payload": payload,
    })
