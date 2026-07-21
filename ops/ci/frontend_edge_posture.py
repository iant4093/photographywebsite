#!/usr/bin/env python3
"""Verify exact, versioned frontend edge metadata without exposing secret headers."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any


class EdgePostureError(ValueError):
    """Frontend edge metadata differs from its reviewed contract."""


SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def _digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def sanitized_distribution(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict) or not isinstance(document.get("Distribution"), dict):
        raise EdgePostureError("distribution response is malformed")
    distribution = document["Distribution"]
    config = distribution.get("DistributionConfig")
    if not isinstance(config, dict):
        raise EdgePostureError("distribution config is missing")
    safe = json.loads(json.dumps(config))
    for origin in safe.get("Origins", {}).get("Items", []):
        headers = origin.get("CustomHeaders", {}).get("Items", [])
        for header in headers:
            value = header.get("HeaderValue")
            if not isinstance(value, str) or not value:
                raise EdgePostureError("origin custom header value is missing")
            header["HeaderValue"] = "<redacted-present>"
    return {
        "ARN": distribution.get("ARN"),
        "Status": distribution.get("Status"),
        "DistributionConfig": safe,
    }


def verify(contract: Any, documents: dict[str, Any]) -> dict[str, int | str]:
    required = {
        "version", "distributionId", "bucketName", "region", "distributionSha256",
        "publicAccessBlockSha256", "encryptionSha256", "ownershipSha256",
        "versioningSha256", "policyStatusSha256",
    }
    if (
        not isinstance(contract, dict)
        or set(contract) != required
        or contract.get("version") != 1
        or any(not isinstance(contract.get(name), str) for name in required - {"version"})
        or any(not SHA_RE.fullmatch(contract[name]) for name in required if name.endswith("Sha256"))
    ):
        raise EdgePostureError("frontend edge contract is invalid")
    actual = {
        "distributionSha256": _digest(sanitized_distribution(documents["distribution"])),
        "publicAccessBlockSha256": _digest(documents["publicAccessBlock"]),
        "encryptionSha256": _digest(documents["encryption"]),
        "ownershipSha256": _digest(documents["ownership"]),
        "versioningSha256": _digest(documents["versioning"]),
        "policyStatusSha256": _digest(documents["policyStatus"]),
    }
    if any(actual[name] != contract[name] for name in actual):
        raise EdgePostureError("frontend edge metadata differs from the reviewed contract")
    return {"metadataDocumentCount": len(actual), "status": "IN_SYNC"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", type=Path, required=True)
    for name in ("distribution", "public-access-block", "encryption", "ownership", "versioning", "policy-status"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        documents = {
            "distribution": json.loads(args.distribution.read_text(encoding="utf-8")),
            "publicAccessBlock": json.loads(args.public_access_block.read_text(encoding="utf-8")),
            "encryption": json.loads(args.encryption.read_text(encoding="utf-8")),
            "ownership": json.loads(args.ownership.read_text(encoding="utf-8")),
            "versioning": json.loads(args.versioning.read_text(encoding="utf-8")),
            "policyStatus": json.loads(args.policy_status.read_text(encoding="utf-8")),
        }
        result = verify(json.loads(args.contract.read_text(encoding="utf-8")), documents)
    except (EdgePostureError, OSError, UnicodeError, json.JSONDecodeError, KeyError):
        print("frontend edge posture audit failed closed", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
