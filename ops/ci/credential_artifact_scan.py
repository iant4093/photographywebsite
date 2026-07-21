#!/usr/bin/env python3
"""Detect credential material in generated build artifacts without echoing it."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import fnmatch
import json
import os
from pathlib import Path
import re
import sys


AWS_ACCESS_KEY_ID = re.compile(rb"(?:AKIA|ASIA)[0-9A-Z]{16}")
PRIVATE_KEY_BEGIN = re.compile(rb"-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----")
PRIVATE_KEY_BODY_LINE = re.compile(rb"[A-Za-z0-9+/]+={0,2}")
PRIVATE_KEY_METADATA_LINE = re.compile(
    rb"(?:Proc-Type:[ \t]*4,ENCRYPTED|DEK-Info:[ \t]*[A-Z0-9-]+,[0-9A-Fa-f]+)"
)
AWS_DOCUMENTATION_ACCESS_KEY_IDS = {b"AKIA" + b"IOSFODNN7EXAMPLE"}
FORBIDDEN_FILENAMES = (
    "google_oauth_token.json",
    "voice-assistant-*.json",
    "*service-account*.json",
    "*service_account*.json",
    "*credentials*.json",
)
IAM_CREDENTIALS_DISCOVERY_PATH = (
    "GoogleDriveBackupFunction",
    "googleapiclient",
    "discovery_cache",
    "documents",
    "iamcredentials.v1.json",
)


class ScanError(ValueError):
    """The artifact tree could not be scanned safely and completely."""


@dataclass(frozen=True)
class Finding:
    kind: str
    path: str


@dataclass(frozen=True)
class ScanReport:
    files_scanned: int
    findings: tuple[Finding, ...]


def _is_iam_credentials_discovery_schema(relative: str, payload: bytes) -> bool:
    if tuple(Path(relative).parts) != IAM_CREDENTIALS_DISCOVERY_PATH:
        return False
    try:
        document = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return isinstance(document, dict) and {
        "discoveryVersion": document.get("discoveryVersion"),
        "id": document.get("id"),
        "name": document.get("name"),
        "rootUrl": document.get("rootUrl"),
        "version": document.get("version"),
    } == {
        "discoveryVersion": "v1",
        "id": "iamcredentials:v1",
        "name": "iamcredentials",
        "rootUrl": "https://iamcredentials.googleapis.com/",
        "version": "v1",
    }


def _forbidden_filename(name: str, relative: str, payload: bytes) -> bool:
    lowered = name.lower()
    if not any(fnmatch.fnmatchcase(lowered, pattern) for pattern in FORBIDDEN_FILENAMES):
        return False
    return not _is_iam_credentials_discovery_schema(relative, payload)


def _contains_private_key_block(payload: bytes) -> bool:
    for match in PRIVATE_KEY_BEGIN.finditer(payload):
        end_marker = b"-----END " + match.group(1) + b"-----"
        end = payload.find(end_marker, match.end())
        if end < 0:
            continue
        encoded_body = payload[match.end() : end]
        normalized_body = (
            encoded_body.replace(b"\\r\\n", b"\n")
            .replace(b"\\n", b"\n")
            .replace(b"\r\n", b"\n")
        )
        if not normalized_body.startswith(b"\n"):
            continue
        encoded_lines: list[bytes] = []
        structurally_valid = True
        for line in (item.strip() for item in normalized_body.strip().splitlines()):
            if not line or PRIVATE_KEY_METADATA_LINE.fullmatch(line):
                continue
            if PRIVATE_KEY_BODY_LINE.fullmatch(line):
                encoded_lines.append(line)
                continue
            structurally_valid = False
            break
        if structurally_valid and sum(len(line) for line in encoded_lines) >= 32:
            return True
    return False


def _artifact_entries(root: Path) -> list[Path]:
    pending = [root]
    files: list[Path] = []
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as iterator:
                entries = sorted(iterator, key=lambda entry: entry.name)
        except OSError as error:
            raise ScanError("artifact directory could not be enumerated") from error
        for entry in entries:
            path = Path(entry.path)
            try:
                if entry.is_symlink():
                    files.append(path)
                elif entry.is_dir(follow_symlinks=False):
                    pending.append(path)
                elif entry.is_file(follow_symlinks=False):
                    files.append(path)
                else:
                    raise ScanError("artifact tree contains an unsupported entry")
            except OSError as error:
                raise ScanError("artifact entry could not be inspected") from error
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def scan(root: Path) -> ScanReport:
    if not root.is_dir() or root.is_symlink():
        raise ScanError("artifact root must be a real directory")
    resolved_root = root.resolve(strict=True)
    findings: list[Finding] = []
    files_scanned = 0
    for path in _artifact_entries(root):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            try:
                resolved = path.resolve(strict=True)
                resolved.relative_to(resolved_root)
            except (OSError, ValueError):
                findings.append(Finding("unsafe_symlink", relative))
                continue
            if not resolved.is_file():
                findings.append(Finding("non_file_symlink", relative))
                continue
        elif not path.is_file():
            continue

        files_scanned += 1
        try:
            payload = path.read_bytes()
        except OSError as error:
            raise ScanError("artifact file could not be read") from error
        if _forbidden_filename(path.name, relative, payload):
            findings.append(Finding("forbidden_credential_filename", relative))
        if _contains_private_key_block(payload):
            findings.append(Finding("private_key_block", relative))
        if any(
            match.group(0) not in AWS_DOCUMENTATION_ACCESS_KEY_IDS
            for match in AWS_ACCESS_KEY_ID.finditer(payload)
        ):
            findings.append(Finding("aws_access_key_id", relative))
    if files_scanned == 0:
        raise ScanError("artifact root is empty")
    return ScanReport(files_scanned, tuple(findings))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args(argv)
    try:
        report = scan(args.root)
    except ScanError:
        print("credential artifact scan failed: artifact tree is unavailable", file=sys.stderr)
        return 2
    output = {
        "filesScanned": report.files_scanned,
        "findingCount": len(report.findings),
        "findings": [
            {"kind": finding.kind, "path": finding.path}
            for finding in report.findings
        ],
    }
    print(json.dumps(output, sort_keys=True))
    return 1 if report.findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
