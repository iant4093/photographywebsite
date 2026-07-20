#!/usr/bin/env python3
"""Plan or apply the source-controlled frontend CloudFront security baseline.

Dry-run is the default. Applying requires both the exact current distribution
ETag and expected AWS account ID, preventing stale or wrong-account updates.
No certificate, DNS, origin, or logging change is made implicitly.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from aws_stack import discover_distribution_by_alias, stack_resource  # noqa: E402

DEFAULT_BASELINE = HERE / "frontend_cloudfront_baseline.json"
WWW_REDIRECT_SOURCE = HERE / "cloudfront_www_redirect.js"


def aws_json(arguments: list[str], *, profile: str | None = None) -> dict[str, Any]:
    command = ["aws"]
    if profile:
        command.extend(["--profile", profile])
    command.extend(arguments)
    command.extend(["--output", "json"])
    try:
        completed = subprocess.run(command, check=True, text=True, capture_output=True)
    except subprocess.CalledProcessError as error:
        # Surface the provider's validation message while keeping stdout (which
        # may contain configuration data) out of logs.
        detail = (error.stderr or "AWS command failed").strip()
        raise RuntimeError(detail) from None
    return json.loads(completed.stdout or "{}")


def aws_with_json_file(
    arguments: list[str], payload: dict[str, Any], *, profile: str | None = None
) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json") as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.flush()
        replaced = [part.replace("{json_file}", handle.name) for part in arguments]
        return aws_json(replaced, profile=profile)


def normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value


def render_csp(
    baseline: dict[str, Any], *, media_domain: str, api_id: str, region: str, bucket: str
) -> str:
    s3_origins = " ".join(
        sorted(
            {
                f"https://{bucket}.s3.amazonaws.com",
                f"https://{bucket}.s3.{region}.amazonaws.com",
            }
        )
    )
    return baseline["content_security_policy_template"].format(
        media_origin=f"https://{media_domain}",
        api_origin=f"https://{api_id}.execute-api.{region}.amazonaws.com",
        cognito_origin=f"https://cognito-idp.{region}.amazonaws.com",
        s3_origins=s3_origins,
    )


def certificate_covers(hostname: str, names: list[str]) -> bool:
    hostname = hostname.lower().rstrip(".")
    for raw_name in names:
        name = raw_name.lower().rstrip(".")
        if name == hostname:
            return True
        if name.startswith("*."):
            suffix = name[1:]
            if hostname.endswith(suffix) and hostname.count(".") == name.count("."):
                return True
    return False


def validate_apply_guards(
    *, apply: bool, expected_etag: str | None, current_etag: str, expected_account: str | None, account: str
) -> None:
    if not apply:
        return
    if not expected_etag or expected_etag != current_etag:
        raise SystemExit(
            f"Refusing apply: --expected-etag must exactly match current ETag {current_etag}."
        )
    if not expected_account or expected_account != account:
        raise SystemExit("Refusing apply: --expected-account-id does not match the active AWS account.")


def validate_cache_policy_ids(baseline: dict[str, Any], profile: str | None) -> None:
    """Fail before creating helper resources when a configured policy is invalid."""
    for purpose, policy_id in baseline.get("cache_policies", {}).items():
        try:
            aws_json(["cloudfront", "get-cache-policy", "--id", policy_id], profile=profile)
        except RuntimeError:
            raise SystemExit(f"Refusing update: configured {purpose} cache policy does not exist.") from None


def assert_no_foreign_viewer_request_function(
    config: dict[str, Any], managed_name: str
) -> None:
    behaviors = [config["DefaultCacheBehavior"]]
    behaviors.extend(config.get("CacheBehaviors", {}).get("Items", []) or [])
    for behavior in behaviors:
        associations = behavior.get("FunctionAssociations", {}).get("Items", []) or []
        for association in associations:
            if association.get("EventType") != "viewer-request":
                continue
            arn = association.get("FunctionARN", "")
            if not arn.endswith(f":function/{managed_name}"):
                raise RuntimeError(
                    "Refusing www redirect: an unmanaged viewer-request function is already associated"
                )


def associate_viewer_request(behavior: dict[str, Any], function_arn: str) -> None:
    associations = behavior.get("FunctionAssociations", {}).get("Items", []) or []
    retained = [item for item in associations if item.get("EventType") != "viewer-request"]
    retained.append({"EventType": "viewer-request", "FunctionARN": function_arn})
    behavior["FunctionAssociations"] = {"Quantity": len(retained), "Items": retained}


def ensure_www_redirect_function(
    *,
    name: str,
    apex: str,
    www: str,
    apply: bool,
    profile: str | None,
) -> tuple[str | None, str]:
    listing = aws_json(["cloudfront", "list-functions", "--stage", "DEVELOPMENT"], profile=profile)
    matches = [
        item
        for item in listing.get("FunctionList", {}).get("Items", []) or []
        if item.get("Name") == name
    ]
    if len(matches) > 1:
        raise RuntimeError("Multiple CloudFront Functions have the managed redirect name")
    source = WWW_REDIRECT_SOURCE.read_text(encoding="utf-8")
    source = source.replace("__APEX_HOST__", apex).replace("__WWW_HOST__", www)
    if not apply:
        arn = matches[0].get("FunctionMetadata", {}).get("FunctionARN") if matches else None
        return arn, "update-and-publish" if matches else "create-and-publish"

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".js") as handle:
        handle.write(source)
        handle.flush()
        config_argument = json.dumps(
            {"Comment": "Canonical www to apex redirect", "Runtime": "cloudfront-js-1.0"},
            separators=(",", ":"),
        )
        if matches:
            described = aws_json(
                ["cloudfront", "describe-function", "--name", name, "--stage", "DEVELOPMENT"],
                profile=profile,
            )
            updated = aws_json(
                [
                    "cloudfront",
                    "update-function",
                    "--name",
                    name,
                    "--if-match",
                    described["ETag"],
                    "--function-config",
                    config_argument,
                    "--function-code",
                    f"fileb://{handle.name}",
                ],
                profile=profile,
            )
        else:
            updated = aws_json(
                [
                    "cloudfront",
                    "create-function",
                    "--name",
                    name,
                    "--function-config",
                    config_argument,
                    "--function-code",
                    f"fileb://{handle.name}",
                ],
                profile=profile,
            )
    published = aws_json(
        ["cloudfront", "publish-function", "--name", name, "--if-match", updated["ETag"]],
        profile=profile,
    )
    return published["FunctionSummary"]["FunctionMetadata"]["FunctionARN"], "published"


def policy_config(name: str, baseline: dict[str, Any], cache_control: str) -> dict[str, Any]:
    return {
        "Name": name,
        "Comment": "Managed by ops/cloudfront_frontend.py; change through source control",
        "SecurityHeadersConfig": {
            "FrameOptions": {"Override": True, "FrameOption": "DENY"},
            "ReferrerPolicy": {
                "Override": True,
                "ReferrerPolicy": "strict-origin-when-cross-origin",
            },
            "ContentSecurityPolicy": {
                "Override": True,
                "ContentSecurityPolicy": baseline["content_security_policy"],
            },
            "ContentTypeOptions": {"Override": True},
            "StrictTransportSecurity": {
                "Override": True,
                "AccessControlMaxAgeSec": 31536000,
                "IncludeSubdomains": False,
                "Preload": False,
            },
        },
        "CustomHeadersConfig": {
            "Quantity": 2,
            "Items": [
                {"Header": "Cache-Control", "Value": cache_control, "Override": True},
                {
                    "Header": "Permissions-Policy",
                    "Value": baseline["permissions_policy"],
                    "Override": True,
                },
            ],
        },
    }


def list_custom_response_policies(profile: str | None) -> dict[str, dict[str, str]]:
    response = aws_json(
        ["cloudfront", "list-response-headers-policies", "--type", "custom"],
        profile=profile,
    )
    items = response.get("ResponseHeadersPolicyList", {}).get("Items", []) or []
    return {
        item["ResponseHeadersPolicy"]["ResponseHeadersPolicyConfig"]["Name"]: {
            "Id": item["ResponseHeadersPolicy"]["Id"]
        }
        for item in items
    }


def ensure_response_policy(
    desired: dict[str, Any], *, apply: bool, profile: str | None
) -> tuple[str | None, str]:
    policies = list_custom_response_policies(profile)
    existing = policies.get(desired["Name"])
    if not existing:
        if not apply:
            return None, "create"
        created = aws_with_json_file(
            [
                "cloudfront",
                "create-response-headers-policy",
                "--response-headers-policy-config",
                "file://{json_file}",
            ],
            desired,
            profile=profile,
        )
        return created["ResponseHeadersPolicy"]["Id"], "created"

    policy_id = existing["Id"]
    current = aws_json(
        ["cloudfront", "get-response-headers-policy-config", "--id", policy_id],
        profile=profile,
    )
    if normalize(current["ResponseHeadersPolicyConfig"]) == normalize(desired):
        return policy_id, "unchanged"
    if not apply:
        return policy_id, "update"
    aws_with_json_file(
        [
            "cloudfront",
            "update-response-headers-policy",
            "--id",
            policy_id,
            "--if-match",
            current["ETag"],
            "--response-headers-policy-config",
            "file://{json_file}",
        ],
        desired,
        profile=profile,
    )
    return policy_id, "updated"


def cache_behavior(
    current_default: dict[str, Any], path_pattern: str, policy_id: str, baseline: dict[str, Any]
) -> dict[str, Any]:
    behavior = {
        key: copy.deepcopy(value)
        for key, value in current_default.items()
        if key
        not in {
            "ForwardedValues",
            "MinTTL",
            "DefaultTTL",
            "MaxTTL",
        }
    }
    behavior.update(
        {
            "PathPattern": path_pattern,
            "ViewerProtocolPolicy": "redirect-to-https",
            "Compress": True,
            "CachePolicyId": baseline["cache_policies"]["immutable"],
            "ResponseHeadersPolicyId": policy_id,
        }
    )
    return behavior


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--expected-etag")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--include-www", action="store_true")
    parser.add_argument("--logging-bucket-domain", help="Opt-in standard-log S3 domain; never inferred")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    frontend_summary = discover_distribution_by_alias(
        baseline["canonical_alias"], args.profile, args.region
    )
    distribution_id = frontend_summary["Id"]
    media_distribution_id = stack_resource(
        args.stack_name, "ImagesCloudFront", args.profile, args.region
    )
    api_id = stack_resource(args.stack_name, "Api", args.profile, args.region)
    media_bucket = stack_resource(args.stack_name, "ImagesBucket", args.profile, args.region)
    media_distribution = aws_json(
        ["cloudfront", "get-distribution", "--id", media_distribution_id], profile=args.profile
    )["Distribution"]
    baseline["content_security_policy"] = render_csp(
        baseline,
        media_domain=media_distribution["DomainName"],
        api_id=api_id,
        region=args.region,
        bucket=media_bucket,
    )
    current = aws_json(
        ["cloudfront", "get-distribution-config", "--id", distribution_id],
        profile=args.profile,
    )
    etag = current["ETag"]
    config = current["DistributionConfig"]
    origins = config.get("Origins", {}).get("Items", []) or []
    domains = {origin.get("DomainName") for origin in origins}
    website_origin = any(
        isinstance(origin.get("DomainName"), str)
        and ".s3-website" in origin["DomainName"]
        and "CustomOriginConfig" in origin
        for origin in origins
    )
    private_rest_origin = any(
        isinstance(origin.get("DomainName"), str)
        and ".s3" in origin["DomainName"]
        and bool(origin.get("OriginAccessControlId"))
        and "S3OriginConfig" in origin
        for origin in origins
    )
    if not website_origin and not private_rest_origin:
        raise SystemExit("Refusing to continue: frontend origin is neither the staged S3 website nor REST/OAC form.")

    account = aws_json(["sts", "get-caller-identity"], profile=args.profile).get("Account")
    validate_apply_guards(
        apply=args.apply,
        expected_etag=args.expected_etag,
        current_etag=etag,
        expected_account=args.expected_account_id,
        account=account,
    )
    validate_cache_policy_ids(baseline, args.profile)

    redirect_name = f"{baseline['canonical_alias'].replace('.', '-')}-www-redirect-v1"
    redirect_arn: str | None = None
    redirect_action = "disabled"
    if args.include_www:
        assert_no_foreign_viewer_request_function(config, redirect_name)
        certificate_arn = config.get("ViewerCertificate", {}).get("ACMCertificateArn")
        if not certificate_arn:
            raise SystemExit("Refusing www alias: distribution does not use an ACM certificate")
        certificate_region = certificate_arn.split(":")[3]
        certificate = aws_json(
            [
                "acm",
                "describe-certificate",
                "--certificate-arn",
                certificate_arn,
                "--region",
                certificate_region,
            ],
            profile=args.profile,
        )["Certificate"]
        names = [certificate.get("DomainName", ""), *(certificate.get("SubjectAlternativeNames", []) or [])]
        if certificate.get("Status") != "ISSUED" or not certificate_covers(
            baseline["optional_www_alias"], names
        ):
            raise SystemExit("Refusing www alias: the issued ACM certificate does not cover www")
        redirect_arn, redirect_action = ensure_www_redirect_function(
            name=redirect_name,
            apex=baseline["canonical_alias"],
            www=baseline["optional_www_alias"],
            apply=args.apply,
            profile=args.profile,
        )

    names = baseline["response_policy_names"]
    html_desired = policy_config(names["html"], baseline, baseline["html_cache_control"])
    immutable_desired = policy_config(
        names["immutable"], baseline, baseline["immutable_cache_control"]
    )
    html_id, html_action = ensure_response_policy(html_desired, apply=args.apply, profile=args.profile)
    immutable_id, immutable_action = ensure_response_policy(
        immutable_desired, apply=args.apply, profile=args.profile
    )

    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "account": account,
        "stack": args.stack_name,
        "distributionId": distribution_id,
        "currentETag": etag,
        "responsePolicies": {"html": html_action, "immutable": immutable_action},
        "wwwRedirect": redirect_action,
    }, indent=2))
    if not args.apply:
        print("Dry run only. Re-run with --apply, --expected-etag, and --expected-account-id after review.")
        return 0

    assert html_id and immutable_id
    desired_distribution = copy.deepcopy(config)
    default = desired_distribution["DefaultCacheBehavior"]
    for legacy_key in ("ForwardedValues", "MinTTL", "DefaultTTL", "MaxTTL"):
        default.pop(legacy_key, None)
    default.update(
        {
            "ViewerProtocolPolicy": "redirect-to-https",
            "Compress": True,
            "CachePolicyId": baseline["cache_policies"]["html"],
            "ResponseHeadersPolicyId": html_id,
        }
    )
    if args.include_www:
        assert redirect_arn
        associate_viewer_request(default, redirect_arn)
    desired_distribution["HttpVersion"] = "http2and3"
    aliases = [baseline["canonical_alias"]]
    if args.include_www:
        aliases.append(baseline["optional_www_alias"])
    desired_distribution["Aliases"] = {"Quantity": len(aliases), "Items": aliases}

    existing_behaviors = desired_distribution.get("CacheBehaviors", {}).get("Items", []) or []
    managed_patterns = set(baseline["immutable_path_patterns"])
    preserved = [item for item in existing_behaviors if item.get("PathPattern") not in managed_patterns]
    managed = [
        cache_behavior(default, pattern, immutable_id, baseline)
        for pattern in baseline["immutable_path_patterns"]
    ]
    if args.include_www:
        for behavior in preserved:
            associate_viewer_request(behavior, redirect_arn)
    desired_distribution["CacheBehaviors"] = {
        "Quantity": len(managed) + len(preserved),
        "Items": managed + preserved,
    }

    if args.logging_bucket_domain:
        desired_distribution["Logging"] = {
            "Enabled": True,
            "IncludeCookies": False,
            "Bucket": args.logging_bucket_domain.rstrip(".") + ".",
            "Prefix": "frontend/",
        }

    aws_with_json_file(
        [
            "cloudfront",
            "update-distribution",
            "--id",
            distribution_id,
            "--if-match",
            etag,
            "--distribution-config",
            "file://{json_file}",
        ],
        desired_distribution,
        profile=args.profile,
    )
    print("CloudFront update submitted. Wait for Deployed, then run header/HTTP regression checks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
