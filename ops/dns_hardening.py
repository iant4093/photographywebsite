#!/usr/bin/env python3
"""Plan or apply CAA and canonical www Route 53 records.

The default is read-only. Apply requires exact hosted-zone, account, domain, and
CloudFront alias guards. DNSSEC is intentionally a separate explicit stack in
ops/dnssec-key-template.yaml because it creates a billable KMS key and requires
a registrar DS-record ceremony.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from typing import Any

from aws_stack import discover_distribution_by_alias, discover_public_hosted_zone


def aws_json(arguments: list[str], profile: str | None) -> dict[str, Any]:
    command = ["aws"]
    if profile:
        command.extend(["--profile", profile])
    command.extend(arguments)
    command.extend(["--output", "json"])
    completed = subprocess.run(command, check=True, text=True, capture_output=True)
    return json.loads(completed.stdout or "{}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", default="iantruongphotography.com")
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--caa-provider", action="append", default=[])
    parser.add_argument("--profile")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--confirm-domain")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    domain = args.domain.rstrip(".")
    zone_id = discover_public_hosted_zone(domain, args.profile, args.region)
    providers = args.caa_provider or ["amazon.com"]
    zone = aws_json(["route53", "get-hosted-zone", "--id", zone_id], args.profile)
    actual_zone = zone["HostedZone"]["Name"].rstrip(".")
    if actual_zone != domain or zone["HostedZone"].get("Config", {}).get("PrivateZone"):
        raise SystemExit("Refusing to continue: hosted-zone name/type does not match the public domain guard.")

    distribution_summary = discover_distribution_by_alias(domain, args.profile, args.region)
    distribution_id = distribution_summary["Id"]
    distribution = aws_json(
        ["cloudfront", "get-distribution", "--id", distribution_id], args.profile
    )["Distribution"]
    distribution_domain = distribution["DomainName"].rstrip(".")
    aliases = distribution["DistributionConfig"].get("Aliases", {}).get("Items", []) or []
    www_name = f"www.{domain}"
    www_ready = www_name in aliases
    redirect_name = f"{domain.replace('.', '-')}-www-redirect-v1"
    behaviors = [distribution["DistributionConfig"]["DefaultCacheBehavior"]]
    behaviors.extend(
        distribution["DistributionConfig"].get("CacheBehaviors", {}).get("Items", []) or []
    )
    redirect_ready = all(
        any(
            association.get("EventType") == "viewer-request"
            and association.get("FunctionARN", "").endswith(f":function/{redirect_name}")
            for association in behavior.get("FunctionAssociations", {}).get("Items", []) or []
        )
        for behavior in behaviors
    )
    distribution_deployed = distribution.get("Status") == "Deployed"

    apex_records = aws_json(
        [
            "route53",
            "list-resource-record-sets",
            "--hosted-zone-id",
            zone_id,
            "--start-record-name",
            domain,
            "--start-record-type",
            "A",
            "--max-items",
            "1",
        ],
        args.profile,
    ).get("ResourceRecordSets", [])
    apex = next(
        (
            record
            for record in apex_records
            if record.get("Name", "").rstrip(".") == domain and record.get("Type") == "A"
        ),
        None,
    )
    alias_target = (apex or {}).get("AliasTarget", {})
    if alias_target.get("DNSName", "").rstrip(".") != distribution_domain:
        raise SystemExit("Refusing to continue: apex DNS does not target the discovered distribution.")
    cloudfront_zone_id = alias_target.get("HostedZoneId")
    if not isinstance(cloudfront_zone_id, str) or not cloudfront_zone_id:
        raise SystemExit("Refusing to continue: apex alias has no target hosted-zone ID.")

    changes: list[dict[str, Any]] = [
        {
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": f"{domain}.",
                "Type": "CAA",
                "TTL": 300,
                "ResourceRecords": [
                    {"Value": f'0 issue "{provider}"'} for provider in sorted(set(providers))
                ],
            },
        }
    ]
    for record_type in ("A", "AAAA"):
        changes.append(
            {
                "Action": "UPSERT",
                "ResourceRecordSet": {
                    "Name": f"{www_name}.",
                    "Type": record_type,
                    "AliasTarget": {
                        "HostedZoneId": cloudfront_zone_id,
                        "DNSName": distribution_domain + ".",
                        "EvaluateTargetHealth": False,
                    },
                },
            }
        )

    change_batch = {
        "Comment": "Guarded CAA and canonical www records managed by ops/dns_hardening.py",
        "Changes": changes,
    }
    account = aws_json(["sts", "get-caller-identity"], args.profile)["Account"]
    print(
        json.dumps(
            {
                "mode": "apply" if args.apply else "dry-run",
                "account": account,
                "hostedZoneId": zone_id,
                "domain": domain,
                "distributionId": distribution_id,
                "cloudFrontWwwAliasReady": www_ready,
                "canonicalRedirectReady": redirect_ready,
                "distributionDeployed": distribution_deployed,
                "plannedRecordTypes": ["CAA", "www A alias", "www AAAA alias"],
                "caaProviders": sorted(set(providers)),
            },
            indent=2,
        )
    )

    if not args.apply:
        print("Dry run only. Add the www redirect/alias and wait for Deployed before DNS apply.")
        return 0
    if args.expected_account_id != account:
        raise SystemExit("Refusing apply: --expected-account-id does not match the active account.")
    if args.confirm_domain != domain:
        raise SystemExit("Refusing apply: --confirm-domain must exactly match the zone name.")
    if not www_ready:
        raise SystemExit("Refusing apply: CloudFront does not yet list the www alternate domain name.")
    if not redirect_ready or not distribution_deployed:
        raise SystemExit("Refusing apply: canonical redirect is absent or CloudFront is not Deployed.")

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json") as handle:
        json.dump(change_batch, handle, separators=(",", ":"))
        handle.flush()
        result = aws_json(
            [
                "route53",
                "change-resource-record-sets",
                "--hosted-zone-id",
                zone_id,
                "--change-batch",
                f"file://{handle.name}",
            ],
            args.profile,
        )
    print(json.dumps({"changeId": result["ChangeInfo"]["Id"], "status": result["ChangeInfo"]["Status"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
