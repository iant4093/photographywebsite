#!/usr/bin/env python3
"""Scan every reachable Git blob for credential material without echoing it."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ops.ci import credential_artifact_scan as artifact_scan


class HistoryScanError(ValueError):
    """Git history could not be enumerated or scanned completely."""


MAX_COMMITS = 20_000
MAX_BLOBS = 250_000
MAX_BLOB_BYTES = 25_000_000
MAX_TOTAL_BLOB_BYTES = 2_000_000_000
OBJECT_BATCH_SIZE = 128
SCANNER_SELF_TEST_PATH = "ops/tests/test_ci_release_guard.py"
SCANNER_SELF_TEST_CREDENTIALS = frozenset(
    {
        (b"alice", b"correct-horse-battery", b"production.example"),
        (b"username", b"password", b"production.example"),
        (b"deploy", b"supersecret123", b"10.0.0.5"),
    }
)


@dataclass(frozen=True)
class HistoryScanReport:
    commits_scanned: int
    blobs_scanned: int
    finding_kinds: tuple[str, ...]


def _git(repo: Path, arguments: list[str], *, stdin: bytes | None = None) -> bytes:
    try:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=repo,
            input=stdin,
            capture_output=True,
            check=False,
            timeout=300,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise HistoryScanError("git history is unavailable") from error
    if completed.returncode != 0:
        raise HistoryScanError("git history enumeration failed")
    return completed.stdout


def _history_entries(repo: Path) -> tuple[int, dict[str, set[str]]]:
    commits = [line for line in _git(repo, ["rev-list", "--all"]).decode("ascii").splitlines() if line]
    if not commits:
        raise HistoryScanError("git history contains no commits")
    if len(commits) > MAX_COMMITS:
        raise HistoryScanError("git history exceeds the reviewed commit bound")
    paths_by_blob: dict[str, set[str]] = {}
    for commit in commits:
        tree = _git(repo, ["ls-tree", "-rlz", commit])
        for entry in tree.split(b"\0"):
            if not entry:
                continue
            metadata, separator, raw_path = entry.partition(b"\t")
            fields = metadata.split()
            if not separator or len(fields) != 4 or fields[1] != b"blob":
                if fields and len(fields) >= 2 and fields[1] != b"blob":
                    continue
                raise HistoryScanError("git tree entry is malformed")
            try:
                object_id = fields[2].decode("ascii")
                path = raw_path.decode("utf-8")
            except UnicodeDecodeError as error:
                raise HistoryScanError("git tree contains a non-UTF-8 path") from error
            pure = PurePosixPath(path)
            if pure.is_absolute() or ".." in pure.parts or "\\" in path:
                raise HistoryScanError("git tree contains an unsafe path")
            paths_by_blob.setdefault(object_id, set()).add(path)
            if len(paths_by_blob) > MAX_BLOBS:
                raise HistoryScanError("git history exceeds the reviewed blob bound")
    if not paths_by_blob:
        raise HistoryScanError("git history contains no blobs")
    return len(commits), paths_by_blob


def _blob_payloads(repo: Path, object_ids: list[str]) -> dict[str, bytes]:
    batch = _git(
        repo,
        ["cat-file", "--batch"],
        stdin=("\n".join(object_ids) + "\n").encode("ascii"),
    )
    payloads: dict[str, bytes] = {}
    offset = 0
    while offset < len(batch):
        line_end = batch.find(b"\n", offset)
        if line_end < 0:
            raise HistoryScanError("git blob batch header is truncated")
        fields = batch[offset:line_end].split()
        if len(fields) != 3 or fields[1] != b"blob":
            raise HistoryScanError("git blob batch header is invalid")
        try:
            object_id = fields[0].decode("ascii")
            size = int(fields[2])
        except (UnicodeDecodeError, ValueError) as error:
            raise HistoryScanError("git blob batch metadata is invalid") from error
        start = line_end + 1
        end = start + size
        if size < 0 or end >= len(batch) or batch[end : end + 1] != b"\n":
            raise HistoryScanError("git blob batch payload is truncated")
        payloads[object_id] = batch[start:end]
        offset = end + 1
    if set(payloads) != set(object_ids):
        raise HistoryScanError("git blob batch is incomplete")
    return payloads


def _is_exact_scanner_self_test(paths: set[str], payload: bytes) -> bool:
    """Permit only the scanner's three reviewed synthetic URL fixtures.

    The history gate scans the commit that introduced its own detector tests.
    Skipping the test path wholesale would create a hiding place for real
    credentials, so the exception requires the exact path and exact complete
    component set. Any additional or changed credentialed URL still fails.
    """
    if paths != {SCANNER_SELF_TEST_PATH}:
        return False
    matches = [
        match
        for match in artifact_scan.CREDENTIALED_URL.finditer(payload)
        if not artifact_scan._is_synthetic_credentialed_url(match)
    ]
    components = {
        (
            artifact_scan._normalized_example_token(match.group("username")),
            artifact_scan._normalized_example_token(match.group("password")),
            artifact_scan._normalized_example_token(
                match.group("host").split(b":", 1)[0]
            ),
        )
        for match in matches
    }
    return len(matches) == 3 and components == SCANNER_SELF_TEST_CREDENTIALS


def scan_history(repo: Path) -> HistoryScanReport:
    if not repo.is_dir():
        raise HistoryScanError("repository is unavailable")
    commits, paths_by_blob = _history_entries(repo)
    object_ids = sorted(paths_by_blob)
    checks = _git(
        repo,
        ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        stdin=("\n".join(object_ids) + "\n").encode("ascii"),
    ).decode("ascii").splitlines()
    if len(checks) != len(object_ids):
        raise HistoryScanError("git blob size inventory is incomplete")
    total_bytes = 0
    for line in checks:
        fields = line.split()
        if len(fields) != 3 or fields[1] != "blob" or not fields[2].isdigit():
            raise HistoryScanError("git blob size inventory is malformed")
        size = int(fields[2])
        total_bytes += size
        if size > MAX_BLOB_BYTES or total_bytes > MAX_TOTAL_BLOB_BYTES:
            raise HistoryScanError("git history exceeds the reviewed content bound")
    finding_kinds: set[str] = set()
    for offset in range(0, len(object_ids), OBJECT_BATCH_SIZE):
        payloads = _blob_payloads(repo, object_ids[offset : offset + OBJECT_BATCH_SIZE])
        for object_id, payload in payloads.items():
            paths = paths_by_blob[object_id]
            for path in paths:
                if artifact_scan._forbidden_filename(PurePosixPath(path).name, path, payload):
                    finding_kinds.add("forbidden_credential_filename")
            if artifact_scan._contains_private_key_block(payload):
                finding_kinds.add("private_key_block")
            if any(
                match.group(0) not in artifact_scan.AWS_DOCUMENTATION_ACCESS_KEY_IDS
                for match in artifact_scan.AWS_ACCESS_KEY_ID.finditer(payload)
            ):
                finding_kinds.add("aws_access_key_id")
            for kind in artifact_scan._high_confidence_token_kinds(payload):
                if kind == "credentialed_url" and _is_exact_scanner_self_test(
                    paths, payload
                ):
                    continue
                finding_kinds.add(kind)
    return HistoryScanReport(commits, len(object_ids), tuple(sorted(finding_kinds)))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", nargs="?", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    try:
        report = scan_history(args.repo)
    except HistoryScanError:
        print("git history credential scan failed closed", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "blobsScanned": report.blobs_scanned,
                "commitsScanned": report.commits_scanned,
                "findingCount": len(report.finding_kinds),
                "findingKinds": list(report.finding_kinds),
            },
            sort_keys=True,
        )
    )
    return 1 if report.finding_kinds else 0


if __name__ == "__main__":
    raise SystemExit(main())
