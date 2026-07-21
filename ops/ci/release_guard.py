#!/usr/bin/env python3
"""Fail-closed release guards with no AWS SDK or application-data access.

Inputs are sanitized AWS CLI JSON documents. This module never prints stack
parameters or resource identifiers. The workflows retain the sensitive AWS CLI
responses only in their ephemeral runner workspace.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
from typing import Any, Iterable


PROTECTED_LOGICAL_IDS = frozenset(
    {
        "AlbumsTable",
        "RateLimitTable",
        "RateLimitHashSecret",
        "ImagesBucket",
        "ImagesBucketPolicy",
        "MediaResponseHeadersPolicy",
        "MediaAccessLogsBucket",
        "MediaAccessLogsBucketPolicy",
        "ImagesOriginAccessControl",
        "ImagesCloudFront",
        "MediaConvertRole",
        "UserPool",
        "UserPoolClient",
        "AdminsGroup",
        "ApiAccessLogGroup",
        "ApplicationLogGroup",
        "Api",
        "AsyncFailureQueue",
        "AlarmTopic",
    }
)
PROTECTED_RESOURCE_TYPES = frozenset(
    {
        "AWS::DynamoDB::Table",
        "AWS::IAM::ManagedPolicy",
        "AWS::IAM::Policy",
        "AWS::IAM::Role",
        "AWS::KMS::Key",
        "AWS::S3::Bucket",
        "AWS::S3::BucketPolicy",
        "AWS::SecretsManager::Secret",
        "AWS::CloudFront::Distribution",
        "AWS::CloudFront::OriginAccessControl",
        "AWS::Cognito::UserPool",
        "AWS::Cognito::UserPoolClient",
        "AWS::Cognito::UserPoolGroup",
    }
)
ALLOWED_ACTIONS = frozenset({"Add", "Modify"})
SAFE_REPLACEMENTS = frozenset({None, "False"})
SAFE_RECREATION = frozenset({None, "Never"})


class GateError(ValueError):
    """A planned release violates a fail-closed safety invariant."""


def _resource_changes(pages: Iterable[dict[str, Any]]) -> Iterable[dict[str, Any]]:
    for page in pages:
        changes = page.get("Changes")
        if not isinstance(changes, list):
            raise GateError("change-set page is missing a Changes list")
        for change in changes:
            resource = change.get("ResourceChange") if isinstance(change, dict) else None
            if not isinstance(resource, dict):
                raise GateError("change-set entry is missing ResourceChange")
            yield resource


def gate_change_set(
    pages: Iterable[dict[str, Any]],
    *,
    protected_ids: frozenset[str] = PROTECTED_LOGICAL_IDS,
) -> dict[str, int]:
    """Validate every paginated resource change and return aggregate counts."""

    counts = {"Add": 0, "Modify": 0}
    seen = 0
    for resource in _resource_changes(pages):
        seen += 1
        action = resource.get("Action")
        logical_id = resource.get("LogicalResourceId")
        resource_type = resource.get("ResourceType")
        replacement = resource.get("Replacement")
        if action not in ALLOWED_ACTIONS:
            raise GateError("resource removal or unknown action is not allowed")
        if not isinstance(logical_id, str) or not logical_id:
            raise GateError("resource change has no logical ID")
        if not isinstance(resource_type, str) or not resource_type:
            raise GateError("resource change has no resource type")
        if logical_id in protected_ids or resource_type in PROTECTED_RESOURCE_TYPES:
            raise GateError("protected resource change requires exceptional approval")
        if replacement not in SAFE_REPLACEMENTS:
            raise GateError("resource replacement or unknown replacement state is not allowed")
        details = resource.get("Details", [])
        if not isinstance(details, list):
            raise GateError("resource change Details must be a list")
        for detail in details:
            if not isinstance(detail, dict):
                raise GateError("resource change detail is malformed")
            target = detail.get("Target", {})
            if not isinstance(target, dict):
                raise GateError("resource change target is malformed")
            if target.get("RequiresRecreation") not in SAFE_RECREATION:
                raise GateError("resource property may require recreation")
        counts[action] += 1
    counts["Total"] = seen
    return counts


def previous_parameter_payload(
    stack: dict[str, Any], *, release_sha: str | None = None
) -> list[dict[str, Any]]:
    """Produce UsePreviousValue entries without reading or reproducing values."""

    parameters = stack.get("Parameters")
    if not isinstance(parameters, list):
        raise GateError("stack is missing Parameters")
    if release_sha is not None and not re.fullmatch(r"[0-9a-f]{40}", release_sha):
        raise GateError("release SHA must be an exact lowercase commit SHA")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for parameter in parameters:
        key = parameter.get("ParameterKey") if isinstance(parameter, dict) else None
        if not isinstance(key, str) or not key or key in seen:
            raise GateError("stack contains an invalid or duplicate parameter key")
        seen.add(key)
        if key == "ReleaseSha" and release_sha is not None:
            result.append({"ParameterKey": key, "ParameterValue": release_sha})
        else:
            result.append({"ParameterKey": key, "UsePreviousValue": True})
    if release_sha is not None and "ReleaseSha" not in seen:
        result.append({"ParameterKey": "ReleaseSha", "ParameterValue": release_sha})
    return result


def require_stack_invariants(stack: dict[str, Any]) -> None:
    status = stack.get("StackStatus")
    if status not in {"CREATE_COMPLETE", "UPDATE_COMPLETE"}:
        raise GateError("stack is not in a deployable stable state")
    if stack.get("EnableTerminationProtection") is not True:
        raise GateError("stack termination protection invariant failed")
    outputs = {
        item.get("OutputKey"): item.get("OutputValue")
        for item in stack.get("Outputs", [])
        if isinstance(item, dict)
    }
    if outputs.get("AlbumIndexDeploymentPhase") != "both":
        raise GateError("album index deployment phase invariant failed")
    if str(outputs.get("PrivateMediaCloudFrontDenyEnforced", "")).lower() != "true":
        raise GateError("private-media CloudFront deny invariant failed")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_manifest(
    root: Path,
    manifest: dict[str, Any],
    *,
    allowed_extras: frozenset[str] = frozenset(),
) -> int:
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise GateError("artifact manifest must contain files")
    seen: set[str] = set()
    for item in files:
        relative = item.get("path") if isinstance(item, dict) else None
        expected = item.get("sha256") if isinstance(item, dict) else None
        if not isinstance(relative, str) or not isinstance(expected, str):
            raise GateError("artifact manifest entry is malformed")
        pure = PurePosixPath(relative)
        if pure.is_absolute() or ".." in pure.parts or "\\" in relative or relative in seen:
            raise GateError("artifact manifest contains an unsafe or duplicate path")
        seen.add(relative)
        candidate = root.joinpath(*pure.parts)
        if candidate.is_symlink() or not candidate.is_file() or sha256_file(candidate) != expected.lower():
            raise GateError("artifact manifest verification failed")
    actual_paths: set[str] = set()
    for candidate in root.rglob("*"):
        if candidate.is_symlink():
            raise GateError("artifact contains a symbolic link")
        if candidate.is_file():
            relative = candidate.relative_to(root).as_posix()
            if relative not in allowed_extras:
                actual_paths.add(relative)
    if actual_paths != seen:
        raise GateError("artifact contains unmanifested or missing files")
    return len(seen)


def build_manifest(root: Path) -> dict[str, Any]:
    if not root.is_dir():
        raise GateError("artifact root is not a directory")
    candidates = sorted(item for item in root.rglob("*") if item.is_file() or item.is_symlink())
    if any(path.is_symlink() for path in candidates):
        raise GateError("artifact root contains a symbolic link")
    files = [
        {"path": path.relative_to(root).as_posix(), "sha256": sha256_file(path)}
        for path in candidates
    ]
    if not files:
        raise GateError("artifact root is empty")
    return {"files": files}


def validate_tar(
    path: Path, *, max_members: int = 25_000, max_bytes: int = 1_500_000_000
) -> int:
    """Refuse path traversal, links, devices, and archive expansion bombs."""

    if path.is_symlink() or not path.is_file():
        raise GateError("release archive is missing or is a symbolic link")
    total = 0
    count = 0
    try:
        with tarfile.open(path, mode="r:gz") as archive:
            for member in archive:
                count += 1
                pure = PurePosixPath(member.name)
                if (
                    count > max_members
                    or pure.is_absolute()
                    or ".." in pure.parts
                    or "\\" in member.name
                    or member.issym()
                    or member.islnk()
                    or member.isdev()
                ):
                    raise GateError("release archive contains an unsafe member")
                total += member.size
                if total > max_bytes:
                    raise GateError("release archive exceeds the expansion limit")
    except (tarfile.TarError, OSError) as error:
        raise GateError("release archive is unreadable") from error
    if count == 0:
        raise GateError("release archive is empty")
    return count


def frontend_upload_plan(root: Path) -> list[dict[str, str]]:
    """Return a deterministic, no-delete upload plan with index.html last."""

    if not root.is_dir() or not (root / "index.html").is_file():
        raise GateError("frontend artifact is missing index.html")
    entries: list[dict[str, str]] = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        if relative == "index.html":
            continue
        immutable = relative.startswith("assets/")
        entries.append(
            {
                "path": relative,
                "cache_control": (
                    "public,max-age=31536000,immutable"
                    if immutable
                    else "public,max-age=300,must-revalidate"
                ),
            }
        )
    entries.append(
        {
            "path": "index.html",
            "cache_control": "no-cache,max-age=0,must-revalidate",
        }
    )
    return entries


def _read_json(path: str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    parameters = subparsers.add_parser("previous-parameters")
    parameters.add_argument("stack_json")
    parameters.add_argument("output_json")
    parameters.add_argument("--release-sha")
    invariants = subparsers.add_parser("stack-invariants")
    invariants.add_argument("stack_json")
    change_set = subparsers.add_parser("gate-change-set")
    change_set.add_argument("pages_json")
    manifest = subparsers.add_parser("verify-manifest")
    manifest.add_argument("root")
    manifest.add_argument("manifest_json")
    manifest.add_argument("--allow-sibling-manifest", action="store_true")
    generate = subparsers.add_parser("build-manifest")
    generate.add_argument("root")
    generate.add_argument("output_json")
    tar = subparsers.add_parser("verify-tar")
    tar.add_argument("archive")
    upload = subparsers.add_parser("frontend-plan")
    upload.add_argument("root")
    upload.add_argument("output_json")
    args = parser.parse_args(argv)

    try:
        if args.command == "previous-parameters":
            payload = previous_parameter_payload(
                _read_json(args.stack_json), release_sha=args.release_sha
            )
            Path(args.output_json).write_text(json.dumps(payload), encoding="utf-8")
        elif args.command == "stack-invariants":
            require_stack_invariants(_read_json(args.stack_json))
        elif args.command == "gate-change-set":
            summary = gate_change_set(_read_json(args.pages_json))
            print(json.dumps(summary, sort_keys=True))
        elif args.command == "verify-manifest":
            extras = frozenset({"manifest.json"}) if args.allow_sibling_manifest else frozenset()
            count = validate_manifest(
                Path(args.root), _read_json(args.manifest_json), allowed_extras=extras
            )
            print(json.dumps({"verified_files": count}))
        elif args.command == "build-manifest":
            payload = build_manifest(Path(args.root))
            Path(args.output_json).write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
        elif args.command == "verify-tar":
            count = validate_tar(Path(args.archive))
            print(json.dumps({"verified_members": count}))
        elif args.command == "frontend-plan":
            plan = frontend_upload_plan(Path(args.root))
            Path(args.output_json).write_text(json.dumps(plan), encoding="utf-8")
        return 0
    except (GateError, OSError, json.JSONDecodeError) as error:
        print(f"release guard failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
