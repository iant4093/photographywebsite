#!/usr/bin/env python3
"""Read-only preflight for the retained GitHub Actions OIDC bootstrap stack."""

from __future__ import annotations

import argparse
import json
import re
from typing import Any

from aws_stack import aws_json


OIDC_HOST = "token.actions.githubusercontent.com"
OIDC_URL = f"https://{OIDC_HOST}"
OIDC_AUDIENCE = "sts.amazonaws.com"
ACCOUNT_PATTERN = re.compile(r"^[0-9]{12}$")
STACK_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,127}$")


def provider_inventory(response: dict[str, Any], account_id: str) -> list[str]:
    matches = []
    for item in response.get("OpenIDConnectProviderList", []) or []:
        arn = item.get("Arn") if isinstance(item, dict) else None
        if (
            isinstance(arn, str)
            and arn.endswith(f":oidc-provider/{OIDC_HOST}")
            and f":iam::{account_id}:" in arn
        ):
            matches.append(arn)
    return sorted(set(matches))


def validate_preflight(
    *,
    provider_mode: str,
    existing_provider_arn: str,
    expected_account_id: str,
    stack_name: str,
    region: str,
    profile: str | None,
) -> dict[str, Any]:
    if region != "us-west-2":
        raise SystemExit("Refusing preflight: region must be us-west-2.")
    if not ACCOUNT_PATTERN.fullmatch(expected_account_id):
        raise SystemExit("Refusing preflight: expected account ID must be exactly 12 digits.")
    if not STACK_PATTERN.fullmatch(stack_name):
        raise SystemExit("Refusing preflight: bootstrap stack name is invalid.")

    identity = aws_json(["sts", "get-caller-identity"], profile, region)
    account_id = identity.get("Account")
    if account_id != expected_account_id:
        raise SystemExit("Refusing preflight: active AWS account does not match --expected-account-id.")

    inventory = aws_json(["iam", "list-open-id-connect-providers"], profile, region)
    providers = provider_inventory(inventory, account_id)
    if len(providers) > 1:
        raise SystemExit("Refusing preflight: multiple GitHub OIDC providers were discovered.")

    if provider_mode == "create":
        if existing_provider_arn:
            raise SystemExit("Refusing preflight: create mode cannot accept --existing-provider-arn.")
        if providers:
            raise SystemExit("Refusing preflight: GitHub OIDC provider already exists; use use-existing mode.")
        selected_provider = ""
    elif provider_mode == "use-existing":
        if not existing_provider_arn:
            raise SystemExit("Refusing preflight: use-existing mode requires --existing-provider-arn.")
        if providers != [existing_provider_arn]:
            raise SystemExit("Refusing preflight: supplied provider ARN is not the exact provider in this account.")
        details = aws_json(
            ["iam", "get-open-id-connect-provider", "--open-id-connect-provider-arn", existing_provider_arn],
            profile,
            region,
        )
        if details.get("Url") not in {OIDC_HOST, OIDC_URL}:
            raise SystemExit("Refusing preflight: existing provider URL is not GitHub Actions.")
        audiences = details.get("ClientIDList", [])
        if not isinstance(audiences, list) or OIDC_AUDIENCE not in audiences:
            raise SystemExit("Refusing preflight: existing provider lacks the sts.amazonaws.com audience.")
        selected_provider = existing_provider_arn
    else:
        raise SystemExit("Refusing preflight: provider mode must be create or use-existing.")

    return {
        "accountId": account_id,
        "bootstrapStackName": stack_name,
        "defaultBranch": "main",
        "githubRepository": "iant4093/photographywebsite",
        "oidcSubject": "repo:iant4093/photographywebsite:ref:refs/heads/main",
        "providerExists": bool(providers),
        "providerMode": provider_mode,
        "region": region,
        "selectedProviderArn": selected_provider,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider-mode", required=True, choices=("create", "use-existing"))
    parser.add_argument("--existing-provider-arn", default="")
    parser.add_argument("--expected-account-id", required=True)
    parser.add_argument("--stack-name", default="ian-photography-ci-bootstrap")
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    args = parser.parse_args()
    result = validate_preflight(
        provider_mode=args.provider_mode,
        existing_provider_arn=args.existing_provider_arn,
        expected_account_id=args.expected_account_id,
        stack_name=args.stack_name,
        region=args.region,
        profile=args.profile,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    print("Read-only preflight complete. No AWS or GitHub resource was changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
