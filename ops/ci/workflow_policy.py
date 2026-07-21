#!/usr/bin/env python3
"""Small fail-closed policy check for tracked GitHub Actions workflows."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys


USE_RE = re.compile(r"(?m)^\s*-?\s*uses:\s*([^\s#]+)")
FULL_SHA_RE = re.compile(r"^[^@]+@[0-9a-f]{40}$")


def violations(path: Path) -> list[str]:
    source = path.read_text(encoding="utf-8")
    problems: list[str] = []
    if re.search(r"(?m)^\s*pull_request_target\s*:", source):
        problems.append("pull_request_target is forbidden")
    if re.search(r"(?m)^\s*permissions\s*:\s*write-all\s*$", source):
        problems.append("write-all permissions are forbidden")
    if re.search(r"(?m)^\s*persist-credentials\s*:\s*true\s*$", source):
        problems.append("checkout credentials must not persist")
    if re.search(r"(?m)^\s+environment\s*:", source):
        problems.append("GitHub Environments are forbidden; AWS trust is bound to the exact main ref")
    for use in USE_RE.findall(source):
        if use.startswith("./"):
            continue
        if not FULL_SHA_RE.fullmatch(use):
            problems.append(f"action is not pinned to a full SHA: {use}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args(argv)
    failed = False
    for name in args.paths:
        path = Path(name)
        for problem in violations(path):
            failed = True
            print(f"{path}: {problem}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
