#!/usr/bin/env python3
"""Compare backend inputs with the actual deployed backend, never a push parent.

Only explicitly frontend-owned paths may skip a backend release. Unknown paths,
missing Git history, changes to release controls, or a non-ancestor deployment
all require the normal guarded release. The stable protected stack is required
even when backend publication can be skipped.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ops.ci.aws_requests import client  # noqa: E402
from ops.ci.release_guard import require_stack_invariants  # noqa: E402

SHA = re.compile(r"[0-9a-f]{40}")
FRONTEND_ROOTS = {"src", "public", "tests"}
FRONTEND_FILES = {"index.html", "print.html", "package.json", "package-lock.json",
                  "vite.config.js", "eslint.config.js", "vitest.config.js"}


def requires_backend(deployed_sha, target_sha, *, git=subprocess.run):
    if not SHA.fullmatch(str(deployed_sha)) or not SHA.fullmatch(str(target_sha)):
        return True
    ancestry = git(["git", "merge-base", "--is-ancestor", deployed_sha, target_sha],
                   capture_output=True, timeout=30)
    if ancestry.returncode:
        return True
    result = git(["git", "diff", "--name-only", "--no-renames", "-z", deployed_sha, target_sha, "--"],
                 capture_output=True, timeout=30)
    if result.returncode:
        return True
    paths = result.stdout.decode("utf-8", errors="strict").split("\0")
    return any(path and path not in FRONTEND_FILES and path.split("/", 1)[0] not in FRONTEND_ROOTS
               for path in paths)


def scope(stack, target_sha):
    require_stack_invariants(stack)
    if not SHA.fullmatch(target_sha):
        raise ValueError("target revision must be exact")
    deployed = next((item.get("ParameterValue") for item in stack.get("Parameters", [])
                     if item.get("ParameterKey") == "ReleaseSha"), None)
    return {"backend_required": requires_backend(deployed, target_sha),
            "deployed_backend_sha": deployed if SHA.fullmatch(str(deployed)) else "unknown"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--github-output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        stack = client("cloudformation", args.region).describe_stacks(StackName=args.stack)["Stacks"][0]
        result = scope(stack, args.sha)
        with args.github_output.open("a", encoding="utf-8") as output:
            for key, value in result.items():
                output.write(f"{key}={str(value).lower()}\n")
        print(json.dumps(result))
    except Exception:
        print("backend scope could not be established safely", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
