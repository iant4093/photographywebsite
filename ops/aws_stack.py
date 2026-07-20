"""Small read-only AWS discovery helpers shared by guarded ops scripts."""

from __future__ import annotations

import json
import subprocess
from typing import Any


def aws_json(
    arguments: list[str], profile: str | None = None, region: str | None = None
) -> dict[str, Any]:
    command = ["aws"]
    if profile:
        command.extend(["--profile", profile])
    if region:
        command.extend(["--region", region])
    command.extend(arguments)
    command.extend(["--output", "json"])
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    return json.loads(result.stdout or "{}")


def stack_resource(
    stack_name: str, logical_id: str, profile: str | None, region: str | None
) -> str:
    response = aws_json(
        [
            "cloudformation",
            "describe-stack-resource",
            "--stack-name",
            stack_name,
            "--logical-resource-id",
            logical_id,
        ],
        profile,
        region,
    )
    physical_id = response.get("StackResourceDetail", {}).get("PhysicalResourceId")
    if not isinstance(physical_id, str) or not physical_id:
        raise RuntimeError(f"Stack resource {logical_id} has no physical ID")
    return physical_id


def discover_distribution_by_alias(
    domain: str, profile: str | None, region: str | None = None
) -> dict[str, Any]:
    matches = []
    marker: str | None = None
    seen_markers: set[str] = set()
    while True:
        arguments = ["cloudfront", "list-distributions", "--no-paginate"]
        if marker:
            arguments.extend(["--marker", marker])
        response = aws_json(arguments, profile, region)
        listing = response.get("DistributionList", {})
        for distribution in listing.get("Items", []) or []:
            aliases = distribution.get("Aliases", {}).get("Items", []) or []
            if domain in aliases:
                matches.append(distribution)
        if not listing.get("IsTruncated", False):
            break
        next_marker = listing.get("NextMarker")
        if not isinstance(next_marker, str) or not next_marker or next_marker in seen_markers:
            raise RuntimeError("CloudFront returned an incomplete distribution listing")
        seen_markers.add(next_marker)
        marker = next_marker
    if len(matches) != 1:
        raise RuntimeError(f"Expected exactly one CloudFront distribution with alias {domain}")
    return matches[0]


def discover_public_hosted_zone(
    domain: str, profile: str | None, region: str | None = None
) -> str:
    response = aws_json(
        ["route53", "list-hosted-zones-by-name", "--dns-name", domain, "--max-items", "10"],
        profile,
        region,
    )
    matches = [
        zone
        for zone in response.get("HostedZones", [])
        if zone.get("Name", "").rstrip(".") == domain.rstrip(".")
        and not zone.get("Config", {}).get("PrivateZone", False)
    ]
    if len(matches) != 1:
        raise RuntimeError(f"Expected exactly one public hosted zone for {domain}")
    return matches[0]["Id"].removeprefix("/hostedzone/")
