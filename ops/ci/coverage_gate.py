#!/usr/bin/env python3
"""Enforce line and branch coverage independently from coverage.py JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


def percentage(covered: int, total: int) -> float:
    return 100.0 if total == 0 else covered * 100.0 / total


def metrics(report: dict) -> tuple[float, float]:
    totals = report["totals"]
    return (
        percentage(totals["covered_lines"], totals["num_statements"]),
        percentage(totals["covered_branches"], totals["num_branches"]),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("report")
    parser.add_argument("--minimum-lines", type=float, default=80.0)
    parser.add_argument("--minimum-branches", type=float, default=80.0)
    args = parser.parse_args(argv)
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    lines, branches = metrics(report)
    print(f"line coverage: {lines:.2f}%")
    print(f"branch coverage: {branches:.2f}%")
    return 0 if lines >= args.minimum_lines and branches >= args.minimum_branches else 1


if __name__ == "__main__":
    raise SystemExit(main())
