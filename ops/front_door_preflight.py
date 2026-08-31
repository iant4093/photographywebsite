#!/usr/bin/env python3
"""Read-only verification for the CloudFront/WAF/API single-front-door boundary.

This command never decrypts the SSM parameter and never prints custom
origin header values.  It is suitable before and after each staged change set.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from aws_stack import aws_json, discover_distribution_by_alias, stack_resource  # noqa: E402


def _stack_parameters(stack_name: str, profile: str | None, region: str) -> dict[str, str]:
    stack = aws_json(
        ["cloudformation", "describe-stacks", "--stack-name", stack_name], profile, region
    )["Stacks"][0]
    return {item["ParameterKey"]: item.get("ParameterValue", "") for item in stack.get("Parameters", [])}


def _stack_outputs(stack_name: str, profile: str | None, region: str) -> dict[str, str]:
    stack = aws_json(
        ["cloudformation", "describe-stacks", "--stack-name", stack_name], profile, region
    )["Stacks"][0]
    return {item["OutputKey"]: item.get("OutputValue", "") for item in stack.get("Outputs", [])}


def inspect(args: argparse.Namespace) -> dict[str, Any]:
    account = aws_json(["sts", "get-caller-identity"], args.profile, args.region).get("Account")
    if account != args.expected_account_id:
        raise RuntimeError("active AWS account does not match --expected-account-id")

    distribution_id = discover_distribution_by_alias(args.canonical_domain, args.profile, args.region)["Id"]
    distribution = aws_json(
        ["cloudfront", "get-distribution", "--id", distribution_id], args.profile, args.region
    )["Distribution"]
    config = distribution["DistributionConfig"]
    if config.get("WebACLId") != args.expected_web_acl_arn:
        raise RuntimeError("frontend distribution WAF association differs")

    origins = config.get("Origins", {}).get("Items", []) or []
    api_origins = [item for item in origins if item.get("DomainName") == args.api_origin_domain]
    if len(api_origins) != 1:
        raise RuntimeError("exact API custom origin is missing or ambiguous")
    custom_headers = api_origins[0].get("CustomHeaders", {}).get("Items", []) or []
    verification_headers = [
        item for item in custom_headers if item.get("HeaderName", "").lower() == "x-origin-verify"
    ]
    if len(verification_headers) != 1 or len(verification_headers[0].get("HeaderValue", "")) < 32:
        raise RuntimeError("CloudFront origin verification header contract is missing")

    patterns = {
        item.get("PathPattern"): item
        for item in config.get("CacheBehaviors", {}).get("Items", []) or []
    }
    for required in ("/api/public/stats", "/api/public/*", "/api/*"):
        if required not in patterns:
            raise RuntimeError(f"required CloudFront behavior is missing: {required}")
    for public_pattern in ("/api/public/stats", "/api/public/*"):
        if "Authorization" in json.dumps(patterns[public_pattern], sort_keys=True):
            raise RuntimeError("public API cache behavior unexpectedly references authorization")

    api_id = stack_resource(args.stack_name, "Api", args.profile, args.region)
    api = aws_json(["apigatewayv2", "get-api", "--api-id", api_id], args.profile, args.region)
    mappings = aws_json(
        ["apigatewayv2", "get-api-mappings", "--domain-name", args.api_origin_domain],
        args.profile,
        args.region,
    ).get("Items", [])
    if not any(item.get("ApiId") == api_id and item.get("ApiMappingKey") == "api" for item in mappings):
        raise RuntimeError("API custom-domain mapping key 'api' is missing")

    certificate_arn = stack_resource(
        args.stack_name, "ApiFrontDoorCertificate", args.profile, args.region
    )
    parameter_name = _stack_outputs(args.stack_name, args.profile, args.region).get(
        "FrontDoorConfigParameterName", ""
    )
    if certificate_arn != args.expected_certificate_arn:
        raise RuntimeError("regional certificate ARN differs")
    if parameter_name != args.expected_parameter_name:
        raise RuntimeError("origin parameter name differs")
    parameters = aws_json(
        [
            "ssm", "describe-parameters", "--parameter-filters",
            f"Key=Name,Option=Equals,Values={parameter_name}",
        ],
        args.profile,
        args.region,
    ).get("Parameters", [])
    if len(parameters) != 1 or parameters[0].get("Name") != parameter_name or parameters[0].get("Type") != "SecureString":
        raise RuntimeError("origin parameter metadata differs")

    parameters = _stack_parameters(args.stack_name, args.profile, args.region)
    return {
        "account": account,
        "distributionId": distribution_id,
        "distributionStatus": distribution.get("Status"),
        "apiOriginDomain": args.api_origin_domain,
        "apiBehaviorsPresent": True,
        "wafAssociated": True,
        "originHeaderPresent": True,
        "originParameterValueRead": False,
        "originEnforcementEnabled": parameters.get("FrontDoorEnforcementEnabled") == "true",
        "executeApiEndpointDisabled": bool(api.get("DisableExecuteApiEndpoint")),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--expected-account-id", required=True)
    parser.add_argument("--expected-certificate-arn", required=True)
    parser.add_argument(
        "--expected-parameter-name",
        "--expected-secret-arn",
        dest="expected_parameter_name",
        required=True,
    )
    parser.add_argument("--expected-web-acl-arn", required=True)
    parser.add_argument("--canonical-domain", default="iantruongphotography.com")
    parser.add_argument("--api-origin-domain", default="origin-api.iantruongphotography.com")
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    args = parser.parse_args()
    try:
        report = inspect(args)
    except (KeyError, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2))
        return 1
    print(json.dumps({"ok": True, **report}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
