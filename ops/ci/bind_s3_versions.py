#!/usr/bin/env python3
"""Replace packaged SAM S3 URIs with exact bucket/key/version mappings."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Callable
import urllib.parse


class BindingError(ValueError):
    """The packaged template could not be bound safely and completely."""


CODE_URI_RE = re.compile(r'^(?P<indent>\s+)CodeUri:\s*["\']?(?P<uri>s3://[^"\'\s]+)["\']?\s*$')
VERSION_RE = re.compile(r"^[A-Za-z0-9._~+/=-]{1,1024}$")


def bind_versions(
    source: str,
    *,
    expected_bucket: str,
    expected_count: int,
    resolve_version: Callable[[str], str],
) -> tuple[str, int]:
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", expected_bucket):
        raise BindingError("expected artifact bucket is invalid")
    if not 1 <= expected_count <= 500:
        raise BindingError("expected artifact count is invalid")
    output: list[str] = []
    count = 0
    for line in source.splitlines():
        match = CODE_URI_RE.fullmatch(line)
        if not match:
            output.append(line)
            continue
        parsed = urllib.parse.urlsplit(match.group("uri"))
        if parsed.scheme != "s3" or parsed.netloc != expected_bucket or parsed.query or parsed.fragment:
            raise BindingError("packaged CodeUri is outside the exact release bucket")
        key = urllib.parse.unquote(parsed.path.lstrip("/"))
        if not key or ".." in key.split("/") or any(ord(character) < 32 for character in key):
            raise BindingError("packaged CodeUri key is invalid")
        version = resolve_version(key)
        if not isinstance(version, str) or not VERSION_RE.fullmatch(version) or version in {"None", "null"}:
            raise BindingError("packaged object has no safe exact S3 version")
        indent = match.group("indent")
        output.extend(
            (
                f"{indent}CodeUri:",
                f"{indent}  Bucket: {json.dumps(expected_bucket)}",
                f"{indent}  Key: {json.dumps(key)}",
                f"{indent}  Version: {json.dumps(version)}",
            )
        )
        count += 1
    if count != expected_count:
        raise BindingError("packaged CodeUri count differs from the reviewed contract")
    return "\n".join(output) + "\n", count


def aws_version(bucket: str, key: str, region: str) -> str:
    try:
        completed = subprocess.run(
            [
                "aws", "s3api", "head-object", "--region", region,
                "--bucket", bucket, "--key", key, "--query", "VersionId", "--output", "text",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise BindingError("unable to resolve an exact package object version") from error
    return completed.stdout.strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--expected-object-count", type=int, required=True)
    args = parser.parse_args(argv)
    try:
        source = args.input.read_text(encoding="utf-8")
        bound, count = bind_versions(
            source,
            expected_bucket=args.bucket,
            expected_count=args.expected_object_count,
            resolve_version=lambda key: aws_version(args.bucket, key, args.region),
        )
        args.output.write_text(bound, encoding="utf-8")
    except (BindingError, OSError, UnicodeError):
        print("packaged template version binding failed closed", file=sys.stderr)
        return 2
    digest = hashlib.sha256(bound.encode("utf-8")).hexdigest()
    print(json.dumps({"objectCount": count, "templateSha256": digest}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
