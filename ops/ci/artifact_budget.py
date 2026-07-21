#!/usr/bin/env python3
"""Fail-closed size and source-isolation budgets for release artifacts."""

from __future__ import annotations

import argparse
import gzip
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from typing import Iterable


class BudgetError(ValueError):
    """Configuration or artifact structure is unsafe or incomplete."""


MAKEFILE_SOURCES = re.compile(r"^SOURCES_([A-Za-z0-9]+)\s*:=\s*(.*?)\s*$")
RESOURCE = re.compile(r"^  ([A-Za-z][A-Za-z0-9]+):\s*$")
HANDLER = re.compile(r"^\s{6}Handler:\s*([A-Za-z_][A-Za-z0-9_]*)\.handler\s*$")


class _EntryParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.javascript: list[str] = []
        self.css: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "script" and values.get("src"):
            self.javascript.append(values["src"] or "")
        if tag == "link" and values.get("href"):
            relationships = set((values.get("rel") or "").split())
            if "stylesheet" in relationships:
                self.css.append(values["href"] or "")
            if "modulepreload" in relationships:
                self.javascript.append(values["href"] or "")


def _integer(mapping: dict, key: str) -> int:
    value = mapping.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise BudgetError(f"budget {key!r} must be a positive integer")
    return value


def load_config(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BudgetError("budget configuration is unreadable") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise BudgetError("unsupported budget configuration")
    if not isinstance(value.get("frontend"), dict) or not isinstance(value.get("sam"), dict):
        raise BudgetError("budget configuration is incomplete")
    return value


def _artifact_files(root: Path, *, allow_internal_symlinks: bool = False) -> list[Path]:
    if not root.is_dir() or root.is_symlink():
        raise BudgetError("artifact root must be a real directory")
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            if not allow_internal_symlinks:
                raise BudgetError("artifact contains a symbolic link")
            try:
                path.resolve(strict=True).relative_to(root.resolve(strict=True))
            except (OSError, ValueError) as error:
                raise BudgetError("artifact contains an unsafe symbolic link") from error
            if not path.resolve(strict=True).is_file():
                raise BudgetError("artifact symbolic link does not target a file")
            files.append(path)
            continue
        if path.is_file():
            files.append(path)
    if not files:
        raise BudgetError("artifact is empty")
    return files


def _gzip_size(files: Iterable[Path]) -> int:
    return sum(len(gzip.compress(path.read_bytes(), compresslevel=9, mtime=0)) for path in files)


def _file_size(path: Path) -> int:
    return path.lstat().st_size if path.is_symlink() else path.stat().st_size


def _entry_files(root: Path, references: list[str], suffix: str) -> list[Path]:
    result: list[Path] = []
    for reference in references:
        clean = reference.split("?", 1)[0].split("#", 1)[0]
        if not clean.endswith(suffix) or clean.startswith(("http://", "https://", "//")):
            continue
        relative = Path(clean.lstrip("/"))
        if relative.is_absolute() or ".." in relative.parts:
            raise BudgetError("entrypoint contains an unsafe asset path")
        path = root / relative
        if not path.is_file() or path.is_symlink():
            raise BudgetError("entrypoint references a missing asset")
        result.append(path)
    if not result:
        raise BudgetError(f"entrypoint does not reference a {suffix} asset")
    return sorted(set(result))


def _violation(code: str, subject: str, actual: int, limit: int) -> dict:
    return {"code": code, "subject": subject, "actual": actual, "limit": limit}


def evaluate_frontend(root: Path, section: dict) -> dict:
    files = _artifact_files(root)
    index = root / "index.html"
    if not index.is_file() or index.is_symlink():
        raise BudgetError("frontend artifact has no regular index.html")
    parser = _EntryParser()
    parser.feed(index.read_text(encoding="utf-8"))
    entry_js = _entry_files(root, parser.javascript, ".js")
    entry_css = _entry_files(root, parser.css, ".css")
    chunks = [path for path in files if path.suffix in {".js", ".css"}]
    if not chunks:
        raise BudgetError("frontend artifact contains no JavaScript or CSS chunks")

    metrics = {
        "fileCount": len(files),
        "totalUncompressedBytes": sum(path.stat().st_size for path in files),
        "totalGzipBytes": _gzip_size(files),
        "entryJavaScriptBytes": sum(path.stat().st_size for path in entry_js),
        "entryJavaScriptGzipBytes": _gzip_size(entry_js),
        "entryCssBytes": sum(path.stat().st_size for path in entry_css),
        "entryCssGzipBytes": _gzip_size(entry_css),
        "largestChunkBytes": max(path.stat().st_size for path in chunks),
        "largestChunkGzipBytes": max(len(gzip.compress(path.read_bytes(), mtime=0)) for path in chunks),
    }
    violations = []
    for name, actual in metrics.items():
        if name == "fileCount":
            continue
        limit = _integer(section, name)
        if actual > limit:
            violations.append(_violation("budget_exceeded", name, actual, limit))
    return {
        "schemaVersion": 1,
        "kind": "frontend-artifact-budget",
        "passed": not violations,
        "metrics": metrics,
        "violations": violations,
    }


def parse_makefile_allowlists(path: Path) -> dict[str, set[str]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise BudgetError("Makefile is unreadable") from error
    allowlists: dict[str, set[str]] = {}
    for line in lines:
        match = MAKEFILE_SOURCES.fullmatch(line)
        if not match:
            continue
        names = match.group(2).split()
        if not names or any(Path(name).name != name or not name.endswith(".py") for name in names):
            raise BudgetError("Makefile source allowlist is malformed")
        if len(names) != len(set(names)):
            raise BudgetError("Makefile source allowlist contains duplicates")
        allowlists[match.group(1)] = set(names)
    if not allowlists:
        raise BudgetError("Makefile has no source allowlists")
    return allowlists


def parse_python_handlers(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise BudgetError("SAM template is unreadable") from error
    current = None
    handlers: dict[str, str] = {}
    for line in lines:
        resource = RESOURCE.fullmatch(line)
        if resource:
            current = resource.group(1)
            continue
        handler = HANDLER.fullmatch(line)
        if handler and current:
            handlers[current] = f"{handler.group(1)}.py"
    if not handlers:
        raise BudgetError("SAM template has no Python handlers")
    return handlers


def _sam_limit(section: dict, logical_id: str) -> dict:
    default = section.get("default")
    overrides = section.get("overrides", {})
    if not isinstance(default, dict) or not isinstance(overrides, dict):
        raise BudgetError("SAM budgets are malformed")
    override = overrides.get(logical_id, {})
    if not isinstance(override, dict):
        raise BudgetError("SAM budget override is malformed")
    return {
        "uncompressedBytes": _integer(override or default, "uncompressedBytes"),
        "fileCount": _integer(override or default, "fileCount"),
    }


def evaluate_sam(
    build_root: Path,
    section: dict,
    makefile: Path,
    template: Path,
    source_root: Path,
) -> dict:
    if not source_root.is_dir():
        raise BudgetError("function source directory is missing")
    allowlists = parse_makefile_allowlists(makefile)
    handlers = parse_python_handlers(template)
    # The sole Node.js Lambda uses a separate reproducible npm build rule.
    # Keep it in the size budget below, but out of Python source comparisons.
    handlers.pop("PreviewWorkerFunction", None)
    if set(allowlists) != set(handlers):
        raise BudgetError("Makefile allowlists and Python handlers do not match")
    overrides = section.get("overrides", {})
    if not isinstance(overrides, dict) or set(overrides) - (set(handlers) | {"PreviewWorkerFunction"}):
        raise BudgetError("SAM budget contains an unknown function override")

    local_modules = {path.name for path in source_root.glob("*.py") if path.is_file()}
    functions = sorted(set(handlers) | {"PreviewWorkerFunction"})
    function_metrics = []
    violations = []
    for logical_id in functions:
        artifact = build_root / logical_id
        try:
            files = _artifact_files(artifact, allow_internal_symlinks=True)
        except BudgetError:
            code = "artifact_missing" if not artifact.is_dir() else "artifact_invalid"
            violations.append({"code": code, "subject": logical_id})
            continue
        limits = _sam_limit(section, logical_id)
        metrics = {
            "logicalId": logical_id,
            "fileCount": len(files),
            "uncompressedBytes": sum(_file_size(path) for path in files),
            "limits": limits,
        }
        function_metrics.append(metrics)
        for name in ("uncompressedBytes", "fileCount"):
            if metrics[name] > limits[name]:
                violations.append(
                    _violation("budget_exceeded", f"{logical_id}:{name}", metrics[name], limits[name])
                )

        top_level = {path.name for path in artifact.glob("*.py") if path.is_file()}
        if logical_id == "PreviewWorkerFunction":
            unexpected = sorted(top_level & local_modules)
            missing = []
        else:
            allowed = allowlists[logical_id]
            unexpected = sorted((top_level & local_modules) - allowed)
            missing = sorted(allowed - top_level)
            if handlers[logical_id] not in allowed:
                violations.append({"code": "handler_not_allowlisted", "subject": logical_id})
        if unexpected:
            violations.append(
                {"code": "unrelated_local_modules", "subject": logical_id, "count": len(unexpected)}
            )
        if missing:
            violations.append(
                {"code": "allowlisted_modules_missing", "subject": logical_id, "count": len(missing)}
            )

    return {
        "schemaVersion": 1,
        "kind": "sam-artifact-budget",
        "passed": not violations,
        "metrics": {"functionCount": len(function_metrics), "functions": function_metrics},
        "violations": violations,
    }


def _write_evidence(path: Path, evidence: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("ops/ci/artifact_budgets.json"))
    parser.add_argument("--output", type=Path, required=True)
    subparsers = parser.add_subparsers(dest="kind", required=True)
    frontend = subparsers.add_parser("frontend")
    frontend.add_argument("--root", type=Path, required=True)
    sam = subparsers.add_parser("sam")
    sam.add_argument("--build-root", type=Path, required=True)
    sam.add_argument("--makefile", type=Path, default=Path("backend/Makefile"))
    sam.add_argument("--template", type=Path, default=Path("backend/template.yaml"))
    sam.add_argument("--source-root", type=Path, default=Path("backend/functions"))
    args = parser.parse_args(argv)

    try:
        config = load_config(args.config)
        if args.kind == "frontend":
            evidence = evaluate_frontend(args.root, config["frontend"])
        else:
            evidence = evaluate_sam(
                args.build_root,
                config["sam"],
                args.makefile,
                args.template,
                args.source_root,
            )
    except BudgetError as error:
        evidence = {
            "schemaVersion": 1,
            "kind": f"{args.kind}-artifact-budget",
            "passed": False,
            "metrics": {},
            "violations": [{"code": "invalid_artifact_or_configuration"}],
        }
        _write_evidence(args.output, evidence)
        print(f"artifact budget failed: {error}", file=sys.stderr)
        return 2

    _write_evidence(args.output, evidence)
    print(json.dumps(evidence["metrics"], sort_keys=True))
    if not evidence["passed"]:
        print("artifact budget exceeded", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
