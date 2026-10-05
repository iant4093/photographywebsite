#!/usr/bin/env python3
"""Name what a failed CloudFormation drift detection could not check.

Reads DetectionStatusReason on stdin and prints only CloudFormation logical
resource IDs and IAM action names found in it, never the provider text itself,
so ARNs, account numbers and messages stay out of CI logs.
"""

from __future__ import annotations

import re
import sys

MAX_REASON_CHARS = 20_000
MAX_NAMES = 20
LOGICAL_ID = re.compile(r"[A-Za-z][A-Za-z0-9]{0,254}")
BRACKETED = re.compile(r"\[([^\[\]]{1,4000})\]")
IAM_ACTION = re.compile(r"(?<![A-Za-z0-9:/-])([a-z][a-z0-9-]{1,39}:[A-Z][A-Za-z0-9]{1,99})(?![A-Za-z0-9:/-])")


def _unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))[:MAX_NAMES]


def summarize(reason: str) -> str:
    reason = reason[:MAX_REASON_CHARS]
    resources = _unique([
        item.strip()
        for group in BRACKETED.findall(reason)
        for item in group.split(",")
        if LOGICAL_ID.fullmatch(item.strip())
    ])
    actions = _unique(IAM_ACTION.findall(reason))
    summary = "unchecked resources: " + (", ".join(resources) or "not named")
    if actions:
        summary += "; denied actions: " + ", ".join(actions)
    return summary


def main() -> int:
    print(summarize(sys.stdin.read(MAX_REASON_CHARS + 1)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
