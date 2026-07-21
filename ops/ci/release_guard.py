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
INTENT_RULE_KEYS = frozenset(
    {"logicalId", "resourceType", "action", "propertyPaths", "allowNoDetails"}
)
LOGICAL_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,254}$")
RESOURCE_TYPE_RE = re.compile(r"^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$")
PROPERTY_PATH_RE = re.compile(r"^[A-Za-z][A-Za-z0-9.]{0,254}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class GateError(ValueError):
    """A planned release violates a fail-closed safety invariant."""


def load_release_intent(
    document: Any,
) -> dict[tuple[str, str, str], tuple[frozenset[str], bool]]:
    """Validate the versioned, exact resource/property release allowlist."""

    if not isinstance(document, dict) or set(document) != {"version", "rules"}:
        raise GateError("release intent must contain only version and rules")
    if document.get("version") != 1 or not isinstance(document.get("rules"), list):
        raise GateError("release intent version or rules are invalid")
    rules: dict[tuple[str, str, str], tuple[frozenset[str], bool]] = {}
    for raw in document["rules"]:
        if not isinstance(raw, dict) or set(raw) != INTENT_RULE_KEYS:
            raise GateError("release intent rule shape is invalid")
        logical_id = raw.get("logicalId")
        resource_type = raw.get("resourceType")
        action = raw.get("action")
        property_paths = raw.get("propertyPaths")
        allow_no_details = raw.get("allowNoDetails")
        if not isinstance(logical_id, str) or not LOGICAL_ID_RE.fullmatch(logical_id):
            raise GateError("release intent logical ID is invalid")
        if not isinstance(resource_type, str) or not RESOURCE_TYPE_RE.fullmatch(resource_type):
            raise GateError("release intent resource type is invalid")
        if action not in ALLOWED_ACTIONS:
            raise GateError("release intent action is invalid")
        if not isinstance(property_paths, list) or not all(
            isinstance(path, str) and PROPERTY_PATH_RE.fullmatch(path)
            for path in property_paths
        ):
            raise GateError("release intent property path is invalid")
        if len(property_paths) != len(set(property_paths)) or "*" in property_paths:
            raise GateError("release intent property paths must be unique and exact")
        if not isinstance(allow_no_details, bool):
            raise GateError("release intent detail policy is invalid")
        if allow_no_details and action != "Add":
            raise GateError("only an exact Add rule may allow missing change details")
        if not property_paths and not allow_no_details:
            raise GateError("release intent must name at least one exact property path")
        key = (logical_id, resource_type, action)
        if key in rules:
            raise GateError("release intent contains a duplicate rule")
        rules[key] = (frozenset(property_paths), allow_no_details)
    if not rules:
        raise GateError("release intent must contain at least one exact rule")
    return rules


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
    release_intent: dict[tuple[str, str, str], tuple[frozenset[str], bool]] | None = None,
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
        intended_properties: frozenset[str] | None = None
        allow_no_details = False
        if release_intent is not None:
            rule = release_intent.get((logical_id, resource_type, action))
            if rule is None:
                raise GateError("resource change is outside the versioned release intent")
            intended_properties, allow_no_details = rule
            if not details and not allow_no_details:
                raise GateError("resource change has no property evidence for its release intent")
        for detail in details:
            if not isinstance(detail, dict):
                raise GateError("resource change detail is malformed")
            target = detail.get("Target", {})
            if not isinstance(target, dict):
                raise GateError("resource change target is malformed")
            if target.get("RequiresRecreation") not in SAFE_RECREATION:
                raise GateError("resource property may require recreation")
            if intended_properties is not None:
                attribute = target.get("Attribute")
                name = target.get("Name")
                if (
                    attribute != "Properties"
                    or not isinstance(name, str)
                    or name not in intended_properties
                ):
                    raise GateError("resource property is outside the versioned release intent")
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


def require_preserved_parameters(
    stack: dict[str, Any], change_parameters: Any, *, release_sha: str
) -> None:
    """Require UsePreviousValue for every existing parameter except ReleaseSha."""

    if not re.fullmatch(r"[0-9a-f]{40}", release_sha):
        raise GateError("release SHA must be an exact lowercase commit SHA")

    def indexed(items: Any, label: str) -> dict[str, dict[str, Any]]:
        if not isinstance(items, list):
            raise GateError(f"{label} parameters are missing")
        result: dict[str, dict[str, Any]] = {}
        for item in items:
            key = item.get("ParameterKey") if isinstance(item, dict) else None
            if (
                not isinstance(key, str)
                or not key
                or key in result
            ):
                raise GateError(f"{label} parameters are malformed")
            result[key] = item
        return result

    current = indexed(stack.get("Parameters"), "stack")
    planned = indexed(change_parameters, "change set")
    if set(planned) != set(current):
        raise GateError("change set parameter keys differ from the deployed stack")
    for key, parameter in planned.items():
        if key == "ReleaseSha":
            if (
                parameter.get("UsePreviousValue") is True
                or parameter.get("ParameterValue") != release_sha
            ):
                raise GateError("change set release SHA is not exact")
        elif parameter.get("UsePreviousValue") is not True:
            raise GateError("change set modifies a preserved stack parameter")


def environment_contract(source: str) -> dict[str, Any]:
    """Hash every exact YAML Environment block without parsing secret values."""

    lines = source.splitlines()
    blocks: list[str] = []
    index = 0
    while index < len(lines):
        match = re.fullmatch(r"(\s+)Environment:\s*", lines[index])
        if not match:
            index += 1
            continue
        indent = len(match.group(1))
        block = [lines[index].rstrip()]
        index += 1
        while index < len(lines):
            line = lines[index]
            stripped = line.strip()
            current_indent = len(line) - len(line.lstrip())
            if stripped and not stripped.startswith("#") and current_indent <= indent:
                break
            if stripped and not stripped.startswith("#"):
                block.append(line.rstrip())
            index += 1
        blocks.append("\n".join(block))
    if not blocks:
        raise GateError("template contains no Environment blocks")
    payload = "\n---\n".join(blocks).encode("utf-8")
    return {
        "blockCount": len(blocks),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def require_environment_contract(source: str, policy: Any, *, template_kind: str) -> None:
    if (
        not isinstance(policy, dict)
        or set(policy) != {"version", "blockCount", "sourceSha256", "builtSha256"}
        or policy.get("version") != 1
        or not isinstance(policy.get("blockCount"), int)
        or policy["blockCount"] < 1
        or any(
            not isinstance(policy.get(name), str)
            or not SHA256_RE.fullmatch(policy[name])
            for name in ("sourceSha256", "builtSha256")
        )
        or template_kind not in {"source", "built"}
    ):
        raise GateError("template environment policy is invalid")
    actual = environment_contract(source)
    expected_digest = policy[f"{template_kind}Sha256"]
    if actual != {"blockCount": policy["blockCount"], "sha256": expected_digest}:
        raise GateError("template Environment blocks differ from the reviewed policy")


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
    if str(outputs.get("FrontDoorEnforcementEnabled", "")).lower() != "true":
        raise GateError("front-door enforcement invariant failed")
    if str(outputs.get("ExecuteApiEndpointDisabled", "")).lower() != "true":
        raise GateError("execute-api endpoint invariant failed")


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
    change_set.add_argument("--intent", required=True)
    preserved = subparsers.add_parser("preserved-parameters")
    preserved.add_argument("stack_json")
    preserved.add_argument("change_parameters_json")
    preserved.add_argument("--release-sha", required=True)
    environment = subparsers.add_parser("template-environment-policy")
    environment.add_argument("template")
    environment.add_argument("policy_json")
    environment.add_argument("--template-kind", choices=("source", "built"), required=True)
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
            intent = load_release_intent(_read_json(args.intent))
            summary = gate_change_set(
                _read_json(args.pages_json), release_intent=intent
            )
            print(json.dumps(summary, sort_keys=True))
        elif args.command == "preserved-parameters":
            require_preserved_parameters(
                _read_json(args.stack_json),
                _read_json(args.change_parameters_json),
                release_sha=args.release_sha,
            )
        elif args.command == "template-environment-policy":
            require_environment_contract(
                Path(args.template).read_text(encoding="utf-8"),
                _read_json(args.policy_json),
                template_kind=args.template_kind,
            )
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
