#!/usr/bin/env python3
"""Wait until no production release is running, then report the deployed commit.

The scheduled audit compares production with what was released. Run while a
release is mid-flight, CloudFormation refuses to start drift detection and the
site still serves the previous commit, so the audit would report drift that is
only a deploy in progress. This waits for the release workflow to go idle and
prints the commit of the latest successful release.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable

RELEASE_WORKFLOW = "release-production.yml"
ACTIVE_STATUSES = {"queued", "in_progress", "waiting", "pending", "requested"}
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class ReleaseWaitError(RuntimeError):
    """The release state could not be established."""


def fetch_runs(api_url: str, repository: str, token: str) -> list[dict[str, Any]]:
    request = urllib.request.Request(
        f"{api_url}/repos/{repository}/actions/workflows/{RELEASE_WORKFLOW}/runs?branch=main&per_page=30",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - fixed GitHub API host
        payload = json.load(response)
    runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
    if not isinstance(runs, list):
        raise ReleaseWaitError("release runs response is malformed")
    return runs


def released_sha(runs: list[dict[str, Any]]) -> str | None:
    """None while a release is active; otherwise the newest successful release's commit."""
    if any(run.get("status") in ACTIVE_STATUSES for run in runs):
        return None
    for run in runs:  # The API lists the newest run first.
        if run.get("status") == "completed" and run.get("conclusion") == "success":
            sha = run.get("head_sha")
            if isinstance(sha, str) and SHA_RE.fullmatch(sha):
                return sha
            raise ReleaseWaitError("release run has an invalid commit")
    raise ReleaseWaitError("no successful production release was found")


def wait_for_idle(
    fetch: Callable[[], list[dict[str, Any]]],
    *,
    max_wait_seconds: int,
    poll_seconds: int,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> str:
    deadline = clock() + max_wait_seconds
    while True:
        sha = released_sha(fetch())
        if sha:
            return sha
        if clock() + poll_seconds > deadline:
            raise ReleaseWaitError("a production release is still running")
        print("A production release is running; waiting for it to finish.", file=sys.stderr)
        sleep(poll_seconds)


def main(argv: list[str] | None = None, environ: dict[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--max-wait-seconds", type=int, default=3600)
    parser.add_argument("--poll-seconds", type=int, default=30)
    args = parser.parse_args(argv)
    env = os.environ if environ is None else environ
    repository = env.get("GITHUB_REPOSITORY", "")
    token = env.get("GITHUB_TOKEN", "")
    api_url = env.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    try:
        if not REPOSITORY_RE.fullmatch(repository) or not token:
            raise ReleaseWaitError("GITHUB_REPOSITORY and GITHUB_TOKEN are required")
        if not (0 < args.poll_seconds <= 300 and 0 <= args.max_wait_seconds <= 7200):
            raise ReleaseWaitError("invalid wait limits")
        sha = wait_for_idle(
            lambda: fetch_runs(api_url, repository, token),
            max_wait_seconds=args.max_wait_seconds,
            poll_seconds=args.poll_seconds,
        )
    except (ReleaseWaitError, OSError, ValueError) as error:
        print(f"release wait failed closed: {error}", file=sys.stderr)
        return 2
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as output:
            output.write(f"release_sha={sha}\n")
    print(sha)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
