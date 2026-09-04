#!/usr/bin/env python3
"""Plan or apply the source-controlled frontend CloudFront security baseline.

Dry-run is the default. Applying requires both the exact current distribution
ETag and expected AWS account ID, preventing stale or wrong-account updates.
No certificate, DNS, origin, or logging change is made implicitly.
"""

from __future__ import annotations

import argparse
import base64
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
SOCIAL_ROUTER_SOURCE = HERE / "cloudfront_social_router.js"
FRONT_DOOR_CONFIRMATION = "ADD-SINGLE-API-FRONT-DOOR"
LEGACY_SPA_ERROR_CODES = frozenset({403, 404})


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


def normalize_policy(value: Any) -> Any:
    """Canonicalize CloudFront's non-semantic policy response normalization."""
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for key, item in sorted(value.items()):
            child = normalize_policy(item)
            if key in {"ContentSecurityPolicy", "XSSProtection"} and child == {}:
                continue
            if key in {"Headers", "Cookies", "QueryStrings"} and isinstance(child, dict):
                entries = child.get("Items")
                if isinstance(entries, list) and all(isinstance(entry, str) for entry in entries):
                    child = {**child, "Items": sorted(entries)}
            normalized[key] = child
        return normalized
    if isinstance(value, list):
        return [normalize_policy(item) for item in value]
    return value


def render_csp(
    baseline: dict[str, Any], *, media_domain: str, api_id: str, region: str, bucket: str,
    original_preview_bucket: str | None = None,
) -> str:
    s3_origins = " ".join(
        sorted(
            {
                f"https://{bucket}.s3.amazonaws.com",
                f"https://{bucket}.s3.{region}.amazonaws.com",
            }
        )
    )
    policy = baseline["content_security_policy_template"].format(
        media_origin=f"https://{media_domain}",
        api_origin=f"https://{api_id}.execute-api.{region}.amazonaws.com",
        cognito_origin=f"https://cognito-idp.{region}.amazonaws.com",
        s3_origins=s3_origins,
    )
    if original_preview_bucket:
        origins = (
            f"https://{original_preview_bucket}.s3.amazonaws.com "
            f"https://{original_preview_bucket}.s3.{region}.amazonaws.com"
        )
        policy = ";".join(
            f"{directive.rstrip()} {origins}"
            if directive.strip().split(" ", 1)[0] in {"img-src", "connect-src"}
            else directive
            for directive in policy.split(";")
        )
    return policy


def render_print_csp(baseline: dict[str, Any], *, media_domain: str) -> str:
    settings = baseline.get("fotomoto_print") or {}
    template = settings.get("content_security_policy_template")
    if not isinstance(template, str) or "{media_origin}" not in template:
        raise SystemExit("Refusing Fotomoto print setup: print CSP template is missing or invalid")
    return template.format(media_origin=f"https://{media_domain}")


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


def refresh_distribution_after_dependencies(
    distribution_id: str,
    expected_config: dict[str, Any],
    *,
    profile: str | None,
) -> tuple[str, dict[str, Any]]:
    """Refresh an ETag changed by dependency updates without masking real drift."""
    current = aws_json(
        ["cloudfront", "get-distribution-config", "--id", distribution_id],
        profile=profile,
    )
    config = current["DistributionConfig"]
    if normalize(config) != normalize(expected_config):
        raise SystemExit(
            "Refusing apply: distribution configuration changed while dependencies were updated."
        )
    return current["ETag"], config


def validate_cache_policy_ids(baseline: dict[str, Any], profile: str | None) -> None:
    """Fail before creating helper resources when a configured policy is invalid."""
    for purpose, policy_id in baseline.get("cache_policies", {}).items():
        try:
            aws_json(["cloudfront", "get-cache-policy", "--id", policy_id], profile=profile)
        except RuntimeError:
            raise SystemExit(f"Refusing update: configured {purpose} cache policy does not exist.") from None


def assert_no_foreign_viewer_request_function(
    config: dict[str, Any], managed_names: str | set[str]
) -> None:
    allowed = {managed_names} if isinstance(managed_names, str) else managed_names
    behaviors = [config["DefaultCacheBehavior"]]
    behaviors.extend(config.get("CacheBehaviors", {}).get("Items", []) or [])
    for behavior in behaviors:
        associations = behavior.get("FunctionAssociations", {}).get("Items", []) or []
        for association in associations:
            if association.get("EventType") != "viewer-request":
                continue
            arn = association.get("FunctionARN", "")
            if not any(arn.endswith(f":function/{name}") for name in allowed):
                raise RuntimeError(
                    "Refusing www redirect: an unmanaged viewer-request function is already associated"
                )


def associate_viewer_request(behavior: dict[str, Any], function_arn: str) -> None:
    associations = behavior.get("FunctionAssociations", {}).get("Items", []) or []
    retained = [item for item in associations if item.get("EventType") != "viewer-request"]
    retained.append({"EventType": "viewer-request", "FunctionARN": function_arn})
    behavior["FunctionAssociations"] = {"Quantity": len(retained), "Items": retained}


def ensure_edge_function(
    *,
    name: str,
    apex: str,
    www: str,
    source_path: Path,
    comment: str,
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
    source = source_path.read_text(encoding="utf-8")
    source = source.replace("__APEX_HOST__", apex).replace("__WWW_HOST__", www)
    if not apply:
        arn = matches[0].get("FunctionMetadata", {}).get("FunctionARN") if matches else None
        return arn, "update-and-publish" if matches else "create-and-publish"

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".js") as handle:
        handle.write(source)
        handle.flush()
        config_argument = json.dumps(
            {
                "Comment": comment,
                "Runtime": "cloudfront-js-1.0",
            },
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


def ensure_www_redirect_function(
    *, name: str, apex: str, www: str, apply: bool, profile: str | None
) -> tuple[str | None, str]:
    return ensure_edge_function(
        name=name,
        apex=apex,
        www=www,
        source_path=WWW_REDIRECT_SOURCE,
        comment="Canonical www redirect and API-safe frontend SPA routing",
        apply=apply,
        profile=profile,
    )


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
                "IncludeSubdomains": True,
                "Preload": True,
            },
        },
        "CustomHeadersConfig": {
            "Quantity": 3,
            "Items": [
                {"Header": "Cache-Control", "Value": cache_control, "Override": True},
                {
                    "Header": "Permissions-Policy",
                    "Value": baseline["permissions_policy"],
                    "Override": True,
                },
                {
                    "Header": "Cross-Origin-Opener-Policy",
                    "Value": "same-origin",
                    "Override": True,
                },
            ],
        },
    }


def print_policy_config(baseline: dict[str, Any]) -> dict[str, Any]:
    settings = baseline["fotomoto_print"]
    return {
        "Name": settings["response_policy_name"],
        "Comment": "Isolated Fotomoto checkout bridge; managed in source control",
        "SecurityHeadersConfig": {
            "ReferrerPolicy": {"Override": True, "ReferrerPolicy": "no-referrer"},
            "ContentSecurityPolicy": {
                "Override": True,
                "ContentSecurityPolicy": settings["content_security_policy"],
            },
            "ContentTypeOptions": {"Override": True},
            "StrictTransportSecurity": {
                "Override": True,
                "AccessControlMaxAgeSec": 31536000,
                "IncludeSubdomains": True,
                "Preload": True,
            },
        },
        "CustomHeadersConfig": {
            "Quantity": 4,
            "Items": [
                {"Header": "Cache-Control", "Value": "no-cache, max-age=0, must-revalidate", "Override": True},
                {"Header": "Permissions-Policy", "Value": settings["permissions_policy"], "Override": True},
                {"Header": "Cross-Origin-Opener-Policy", "Value": "same-origin", "Override": True},
                {"Header": "X-Robots-Tag", "Value": "noindex, nofollow, noarchive", "Override": True},
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
    if normalize_policy(current["ResponseHeadersPolicyConfig"]) == normalize_policy(desired):
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


def _custom_policy_listing(kind: str, profile: str | None) -> list[dict[str, Any]]:
    response = aws_json(["cloudfront", f"list-{kind}-policies", "--type", "custom"], profile=profile)
    key = "CachePolicyList" if kind == "cache" else "OriginRequestPolicyList"
    return response.get(key, {}).get("Items", []) or []


def ensure_cache_policy(
    desired: dict[str, Any], *, apply: bool, profile: str | None
) -> tuple[str | None, str]:
    matches = [
        item["CachePolicy"]
        for item in _custom_policy_listing("cache", profile)
        if item["CachePolicy"]["CachePolicyConfig"]["Name"] == desired["Name"]
    ]
    if len(matches) > 1:
        raise RuntimeError("Multiple custom cache policies have the managed front-door name")
    if not matches:
        if not apply:
            return None, "create"
        created = aws_with_json_file(
            ["cloudfront", "create-cache-policy", "--cache-policy-config", "file://{json_file}"],
            desired,
            profile=profile,
        )
        return created["CachePolicy"]["Id"], "created"
    policy_id = matches[0]["Id"]
    current = aws_json(["cloudfront", "get-cache-policy-config", "--id", policy_id], profile=profile)
    if normalize_policy(current["CachePolicyConfig"]) == normalize_policy(desired):
        return policy_id, "unchanged"
    if not apply:
        return policy_id, "update"
    aws_with_json_file(
        [
            "cloudfront", "update-cache-policy", "--id", policy_id, "--if-match", current["ETag"],
            "--cache-policy-config", "file://{json_file}",
        ],
        desired,
        profile=profile,
    )
    return policy_id, "updated"


def ensure_origin_request_policy(
    desired: dict[str, Any], *, apply: bool, profile: str | None
) -> tuple[str | None, str]:
    matches = [
        item["OriginRequestPolicy"]
        for item in _custom_policy_listing("origin-request", profile)
        if item["OriginRequestPolicy"]["OriginRequestPolicyConfig"]["Name"] == desired["Name"]
    ]
    if len(matches) > 1:
        raise RuntimeError("Multiple origin request policies have the managed front-door name")
    if not matches:
        if not apply:
            return None, "create"
        created = aws_with_json_file(
            [
                "cloudfront", "create-origin-request-policy", "--origin-request-policy-config",
                "file://{json_file}",
            ],
            desired,
            profile=profile,
        )
        return created["OriginRequestPolicy"]["Id"], "created"
    policy_id = matches[0]["Id"]
    current = aws_json(
        ["cloudfront", "get-origin-request-policy-config", "--id", policy_id], profile=profile
    )
    if normalize_policy(current["OriginRequestPolicyConfig"]) == normalize_policy(desired):
        return policy_id, "unchanged"
    if not apply:
        return policy_id, "update"
    aws_with_json_file(
        [
            "cloudfront", "update-origin-request-policy", "--id", policy_id, "--if-match",
            current["ETag"], "--origin-request-policy-config", "file://{json_file}",
        ],
        desired,
        profile=profile,
    )
    return policy_id, "updated"


def public_api_cache_policy_config(settings: dict[str, Any]) -> dict[str, Any]:
    query_items = settings["public_query_strings"]
    return {
        "Name": settings["public_cache_policy_name"],
        "Comment": "Anonymous allowlisted public catalog only; managed in source control",
        "DefaultTTL": 60,
        "MaxTTL": 300,
        "MinTTL": 0,
        "ParametersInCacheKeyAndForwardedToOrigin": {
            "EnableAcceptEncodingGzip": True,
            "EnableAcceptEncodingBrotli": True,
            "CookiesConfig": {"CookieBehavior": "none"},
            "HeadersConfig": {"HeaderBehavior": "none"},
            "QueryStringsConfig": {
                "QueryStringBehavior": "whitelist",
                "QueryStrings": {"Quantity": len(query_items), "Items": query_items},
            },
        },
    }


def public_stats_cache_policy_config(settings: dict[str, Any]) -> dict[str, Any]:
    policy = public_api_cache_policy_config(settings)
    policy.update({
        "Name": settings["stats_cache_policy_name"],
        "Comment": "Daily materialized public statistics; managed in source control",
        "DefaultTTL": 86400,
        "MaxTTL": 86400,
    })
    return policy


def api_origin_request_policy_config(settings: dict[str, Any], *, public: bool) -> dict[str, Any]:
    headers = settings["public_forward_headers"] if public else settings["private_forward_headers"]
    query_config: dict[str, Any] = {"QueryStringBehavior": "all"}
    if public:
        query_items = settings["public_query_strings"]
        query_config = {
            "QueryStringBehavior": "whitelist",
            "QueryStrings": {"Quantity": len(query_items), "Items": query_items},
        }
    return {
        "Name": settings["public_origin_request_policy_name"] if public else settings["private_origin_request_policy_name"],
        "Comment": "Same-origin API forwarding; never forwards viewer cookies or host",
        "CookiesConfig": {"CookieBehavior": "none"},
        "HeadersConfig": {
            "HeaderBehavior": "whitelist",
            "Headers": {"Quantity": len(headers), "Items": headers},
        },
        "QueryStringsConfig": query_config,
    }


def api_response_policy_config(settings: dict[str, Any]) -> dict[str, Any]:
    return {
        "Name": settings["response_policy_name"],
        "Comment": "Security headers for same-origin API responses; cache directives remain origin-owned",
        "SecurityHeadersConfig": {
            "ContentTypeOptions": {"Override": True},
            "FrameOptions": {"FrameOption": "DENY", "Override": True},
            "ReferrerPolicy": {"ReferrerPolicy": "no-referrer", "Override": True},
            "StrictTransportSecurity": {
                "AccessControlMaxAgeSec": 31536000,
                "IncludeSubdomains": True,
                "Preload": True,
                "Override": True,
            },
        },
        "CustomHeadersConfig": {
            "Quantity": 1,
            "Items": [
                {
                    "Header": "Cross-Origin-Opener-Policy",
                    "Value": "same-origin",
                    "Override": True,
                }
            ],
        },
    }


def _arn_account(arn: str) -> str:
    parts = arn.split(":")
    return parts[4] if len(parts) > 5 else ""


def waf_search_string_matches(value: Any, expected: str) -> bool:
    """Match the exact WAF byte string returned by AWS CLI JSON.

    Botocore serializes blob fields such as SearchString as base64 in JSON.
    Keep accepting the decoded form used by tests/SDK callers, but do not
    weaken the guard to a prefix or substring comparison.
    """
    if value == expected:
        return True
    if not isinstance(value, str):
        return False
    try:
        return base64.b64decode(value, validate=True).decode("utf-8") == expected
    except (ValueError, UnicodeDecodeError):
        return False


def validate_front_door_resources(
    *, domain: str, certificate_arn: str, parameter_name: str, web_acl_arn: str,
    account: str, region: str, profile: str | None,
) -> None:
    if _arn_account(certificate_arn) != account or _arn_account(web_acl_arn) != account:
        raise SystemExit("Refusing front door: certificate and WAF must belong to the active account")
    if certificate_arn.split(":")[3] != region:
        raise SystemExit("Refusing front door: API certificate must be regional with the API")
    if not parameter_name.startswith("/ian-website/") or not parameter_name.endswith("/front-door-config"):
        raise SystemExit("Refusing front door: origin parameter name is outside the approved path")
    if web_acl_arn.split(":")[3] != "us-east-1" or ":global/webacl/" not in web_acl_arn:
        raise SystemExit("Refusing front door: CloudFront WAF must be a global web ACL in us-east-1")

    certificate = aws_json(
        ["acm", "describe-certificate", "--certificate-arn", certificate_arn, "--region", region],
        profile=profile,
    )["Certificate"]
    certificate_names = [
        certificate.get("DomainName", ""), *(certificate.get("SubjectAlternativeNames", []) or [])
    ]
    if certificate.get("Status") != "ISSUED" or not certificate_covers(domain, certificate_names):
        raise SystemExit("Refusing front door: issued regional certificate does not cover the API origin domain")

    parameters = aws_json(
        [
            "ssm", "describe-parameters", "--parameter-filters",
            f"Key=Name,Option=Equals,Values={parameter_name}", "--region", region,
        ],
        profile=profile,
    ).get("Parameters", [])
    if len(parameters) != 1 or parameters[0].get("Name") != parameter_name or parameters[0].get("Type") != "SecureString":
        raise SystemExit("Refusing front door: origin parameter metadata did not match")

    resource = web_acl_arn.split(":", 5)[5]
    _, _, name, identifier = resource.split("/", 3)
    web_acl = aws_json(
        [
            "wafv2", "get-web-acl", "--scope", "CLOUDFRONT", "--name", name, "--id",
            identifier, "--region", "us-east-1",
        ],
        profile=profile,
    )["WebACL"]
    if web_acl.get("ARN") != web_acl_arn:
        raise SystemExit("Refusing front door: WAF metadata did not match the exact ARN")
    if "Allow" not in web_acl.get("DefaultAction", {}):
        raise SystemExit("Refusing front door: WAF default action must remain allow")
    actual_rules = {
        rule.get("Name"): rule for rule in web_acl.get("Rules", [])
        if isinstance(rule, dict)
    }
    expected_actions = {
        "ExplorePerIpRateLimit": ("Action", "Block"),
        "ExploreGlobalCircuitBreaker": ("Action", "Block"),
        "ApiPerIpRateLimit": ("Action", "Block"),
        "ApiGlobalCircuitBreaker": ("Action", "Block"),
        "AWSManagedKnownBadInputs": ("OverrideAction", "None"),
        "AWSManagedAmazonIpReputation": ("OverrideAction", "None"),
    }
    if set(actual_rules) != set(expected_actions) or any(
        action not in actual_rules[name].get(container, {})
        for name, (container, action) in expected_actions.items()
    ):
        raise SystemExit("Refusing front door: WAF selective-block rule contract differs")
    for name, aggregate_key, limit, path, positional_constraint in (
        ("ExplorePerIpRateLimit", "IP", 300, "/api/public/explore", "EXACTLY"),
        ("ExploreGlobalCircuitBreaker", "CONSTANT", 1500, "/api/public/explore", "EXACTLY"),
        ("ApiPerIpRateLimit", "IP", 1200, "/api/", "STARTS_WITH"),
        ("ApiGlobalCircuitBreaker", "CONSTANT", 3000, "/api/", "STARTS_WITH"),
    ):
        rate = actual_rules[name].get("Statement", {}).get("RateBasedStatement", {})
        scope = rate.get("ScopeDownStatement", {}).get("ByteMatchStatement", {})
        if (
            rate.get("AggregateKeyType") != aggregate_key
            or rate.get("EvaluationWindowSec") != 300
            or rate.get("Limit") != limit
            or not waf_search_string_matches(scope.get("SearchString"), path)
            or scope.get("PositionalConstraint") != positional_constraint
            or scope.get("FieldToMatch") != {"UriPath": {}}
        ):
            raise SystemExit("Refusing front door: WAF API rate-limit contract differs")

    api_domain = aws_json(
        ["apigatewayv2", "get-domain-name", "--domain-name", domain, "--region", region],
        profile=profile,
    )
    configurations = api_domain.get("DomainNameConfigurations", []) or []
    if api_domain.get("DomainName") != domain or not any(
        item.get("CertificateArn") == certificate_arn
        and item.get("EndpointType") == "REGIONAL"
        and item.get("SecurityPolicy") == "TLS_1_2"
        for item in configurations
    ):
        raise SystemExit("Refusing front door: regional API custom domain/certificate contract differs")


def validate_front_door_apply_guards(
    *, apply: bool, confirmation: str | None, expected_frontend_origin_id: str | None,
    frontend_origin_id: str, expected_frontend_origin_domain: str | None,
    frontend_origin_domain: str, expected_api_domain: str | None, api_domain: str,
    expected_certificate_arn: str | None, certificate_arn: str,
    expected_parameter_name: str | None, parameter_name: str,
    expected_web_acl_arn: str | None, web_acl_arn: str,
) -> None:
    if not apply:
        return
    checks = (
        (expected_frontend_origin_id, frontend_origin_id),
        (expected_frontend_origin_domain, frontend_origin_domain),
        (expected_api_domain, api_domain),
        (expected_certificate_arn, certificate_arn),
        (expected_parameter_name, parameter_name),
        (expected_web_acl_arn, web_acl_arn),
    )
    if any(expected != actual for expected, actual in checks):
        raise SystemExit("Refusing front-door apply: every expected origin/resource guard must match exactly")
    if confirmation != FRONT_DOOR_CONFIRMATION:
        raise SystemExit(f"Refusing front-door apply: --confirm-front-door must equal {FRONT_DOOR_CONFIRMATION}")


def load_origin_verification_value(parameter_name: str, *, region: str, profile: str | None) -> str:
    response = aws_json(
        ["ssm", "get-parameter", "--name", parameter_name, "--with-decryption", "--region", region],
        profile=profile,
    )
    try:
        contract = json.loads(response["Parameter"]["Value"])
        current = contract["current"]
    except (KeyError, TypeError, json.JSONDecodeError):
        raise SystemExit("Refusing front door: origin parameter does not satisfy the current/previous JSON contract") from None
    if (
        not isinstance(current, str)
        or not 32 <= len(current) <= 512
        or not current.isascii()
        or "\r" in current
        or "\n" in current
    ):
        raise SystemExit("Refusing front door: origin parameter current value is invalid")
    previous = contract.get("previous")
    if previous not in (None, "") and (
        not isinstance(previous, str)
        or not 32 <= len(previous) <= 512
        or not previous.isascii()
        or "\r" in previous
        or "\n" in previous
    ):
        raise SystemExit("Refusing front door: origin parameter previous value is invalid")
    return current


def cache_behavior(
    current_default: dict[str, Any],
    path_pattern: str,
    policy_id: str,
    baseline: dict[str, Any],
    *,
    cache_policy: str = "immutable",
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
            "CachePolicyId": baseline["cache_policies"][cache_policy],
            "ResponseHeadersPolicyId": policy_id,
        }
    )
    return behavior


def api_origin(settings: dict[str, Any], verification_value: str) -> dict[str, Any]:
    return {
        "Id": settings["origin_id"],
        "DomainName": settings["origin_domain"],
        "OriginPath": "",
        "CustomHeaders": {
            "Quantity": 1,
            "Items": [{
                "HeaderName": settings["verification_header"],
                "HeaderValue": verification_value,
            }],
        },
        "CustomOriginConfig": {
            "HTTPPort": 80,
            "HTTPSPort": 443,
            "OriginProtocolPolicy": "https-only",
            "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
            "OriginReadTimeout": 30,
            "OriginKeepaliveTimeout": 5,
        },
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10,
        "OriginShield": {"Enabled": False},
    }


def upsert_exact_api_origin(
    config: dict[str, Any], settings: dict[str, Any], verification_value: str
) -> None:
    origins = config.get("Origins", {}).get("Items", []) or []
    origin_id = settings["origin_id"]
    matches = [item for item in origins if item.get("Id") == origin_id]
    if len(matches) > 1:
        raise RuntimeError("Multiple origins use the managed API origin ID")
    if matches and matches[0].get("DomainName") != settings["origin_domain"]:
        raise RuntimeError("Managed API origin ID is already bound to another domain")
    retained = [item for item in origins if item.get("Id") != origin_id]
    retained.append(api_origin(settings, verification_value))
    config["Origins"] = {"Quantity": len(retained), "Items": retained}


def api_cache_behavior(
    default: dict[str, Any], *, settings: dict[str, Any], path_pattern: str,
    cache_policy_id: str, origin_request_policy_id: str, response_policy_id: str,
    public: bool,
) -> dict[str, Any]:
    behavior = {
        key: copy.deepcopy(value)
        for key, value in default.items()
        if key not in {"ForwardedValues", "MinTTL", "DefaultTTL", "MaxTTL"}
    }
    allowed_methods = ["GET", "HEAD", "OPTIONS"] if public else [
        "GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"
    ]
    behavior.update({
        "PathPattern": path_pattern,
        "TargetOriginId": settings["origin_id"],
        "ViewerProtocolPolicy": "https-only",
        "AllowedMethods": {
            "Quantity": len(allowed_methods),
            "Items": allowed_methods,
            "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
        },
        "Compress": True,
        "CachePolicyId": cache_policy_id,
        "OriginRequestPolicyId": origin_request_policy_id,
        "ResponseHeadersPolicyId": response_policy_id,
    })
    return behavior


def remove_legacy_spa_error_responses(config: dict[str, Any]) -> None:
    """Remove only the global S3 SPA mappings that would corrupt API errors."""
    existing = config.get("CustomErrorResponses", {}).get("Items", []) or []
    retained = [
        copy.deepcopy(item)
        for item in existing
        if not (
            item.get("ErrorCode") in LEGACY_SPA_ERROR_CODES
            and item.get("ResponsePagePath") == "/index.html"
            and str(item.get("ResponseCode")) == "200"
        )
    ]
    responses: dict[str, Any] = {"Quantity": len(retained)}
    if retained:
        responses["Items"] = retained
    config["CustomErrorResponses"] = responses


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--expected-etag")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--include-www", action="store_true")
    parser.add_argument("--include-fotomoto-print", action="store_true")
    parser.add_argument("--include-api-front-door", action="store_true")
    parser.add_argument("--api-certificate-arn")
    parser.add_argument("--origin-parameter-name", "--origin-secret-arn", dest="origin_parameter_name")
    parser.add_argument("--web-acl-arn")
    parser.add_argument("--expected-frontend-origin-id")
    parser.add_argument("--expected-frontend-origin-domain")
    parser.add_argument("--expected-api-origin-domain")
    parser.add_argument("--expected-api-certificate-arn")
    parser.add_argument(
        "--expected-origin-parameter-name",
        "--expected-origin-secret-arn",
        dest="expected_origin_parameter_name",
    )
    parser.add_argument("--expected-web-acl-arn")
    parser.add_argument("--confirm-front-door")
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
        original_preview_bucket=stack_resource(args.stack_name, "OriginalPreviewBucket", args.profile, args.region),
    )
    if args.include_fotomoto_print:
        baseline["fotomoto_print"]["content_security_policy"] = render_print_csp(
            baseline, media_domain=media_distribution["DomainName"]
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

    frontend_origin_id = config["DefaultCacheBehavior"].get("TargetOriginId", "")
    frontend_origin_matches = [origin for origin in origins if origin.get("Id") == frontend_origin_id]
    if len(frontend_origin_matches) != 1:
        raise SystemExit("Refusing to continue: the default frontend origin is missing or ambiguous")
    frontend_origin_domain = frontend_origin_matches[0].get("DomainName", "")

    account = aws_json(["sts", "get-caller-identity"], profile=args.profile).get("Account")
    validate_apply_guards(
        apply=args.apply,
        expected_etag=args.expected_etag,
        current_etag=etag,
        expected_account=args.expected_account_id,
        account=account,
    )
    validate_cache_policy_ids(baseline, args.profile)

    api_settings = baseline.get("api_front_door", {})
    public_api_cache_id = public_stats_cache_id = None
    public_api_origin_request_id = private_api_origin_request_id = None
    api_response_id = None
    api_policy_actions = {
        "publicCache": "disabled",
        "statsCache": "disabled",
        "publicOrigin": "disabled",
        "privateOrigin": "disabled",
        "response": "disabled",
    }
    if args.include_api_front_door:
        required = {
            "--api-certificate-arn": args.api_certificate_arn,
            "--origin-parameter-name": args.origin_parameter_name,
            "--web-acl-arn": args.web_acl_arn,
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise SystemExit(f"Refusing front door: required arguments missing: {', '.join(missing)}")
        if api_settings.get("origin_domain") != baseline.get("api_origin_domain"):
            raise SystemExit("Refusing front door: baseline API origin domain declarations differ")
        validate_front_door_resources(
            domain=api_settings["origin_domain"],
            certificate_arn=args.api_certificate_arn,
            parameter_name=args.origin_parameter_name,
            web_acl_arn=args.web_acl_arn,
            account=account,
            region=args.region,
            profile=args.profile,
        )
        validate_front_door_apply_guards(
            apply=args.apply,
            confirmation=args.confirm_front_door,
            expected_frontend_origin_id=args.expected_frontend_origin_id,
            frontend_origin_id=frontend_origin_id,
            expected_frontend_origin_domain=args.expected_frontend_origin_domain,
            frontend_origin_domain=frontend_origin_domain,
            expected_api_domain=args.expected_api_origin_domain,
            api_domain=api_settings["origin_domain"],
            expected_certificate_arn=args.expected_api_certificate_arn,
            certificate_arn=args.api_certificate_arn,
            expected_parameter_name=args.expected_origin_parameter_name,
            parameter_name=args.origin_parameter_name,
            expected_web_acl_arn=args.expected_web_acl_arn,
            web_acl_arn=args.web_acl_arn,
        )
        public_api_cache_id, api_policy_actions["publicCache"] = ensure_cache_policy(
            public_api_cache_policy_config(api_settings), apply=args.apply, profile=args.profile
        )
        public_stats_cache_id, api_policy_actions["statsCache"] = ensure_cache_policy(
            public_stats_cache_policy_config(api_settings), apply=args.apply, profile=args.profile
        )
        public_api_origin_request_id, api_policy_actions["publicOrigin"] = ensure_origin_request_policy(
            api_origin_request_policy_config(api_settings, public=True),
            apply=args.apply,
            profile=args.profile,
        )
        private_api_origin_request_id, api_policy_actions["privateOrigin"] = ensure_origin_request_policy(
            api_origin_request_policy_config(api_settings, public=False),
            apply=args.apply,
            profile=args.profile,
        )
        api_response_id, api_policy_actions["response"] = ensure_response_policy(
            api_response_policy_config(api_settings), apply=args.apply, profile=args.profile
        )

    redirect_name = f"{baseline['canonical_alias'].replace('.', '-')}-www-redirect-v1"
    social_router_name = f"{baseline['canonical_alias'].replace('.', '-')}-social-router-v1"
    redirect_arn: str | None = None
    redirect_action = "disabled"
    request_router_enabled = args.include_www or args.include_api_front_door
    if request_router_enabled:
        assert_no_foreign_viewer_request_function(config, {redirect_name, social_router_name})
    if args.include_www:
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
    if args.include_fotomoto_print:
        certificate_arn = config.get("ViewerCertificate", {}).get("ACMCertificateArn")
        if not certificate_arn:
            raise SystemExit("Refusing Fotomoto print alias: distribution does not use an ACM certificate")
        certificate_region = certificate_arn.split(":")[3]
        certificate = aws_json(
            ["acm", "describe-certificate", "--certificate-arn", certificate_arn, "--region", certificate_region],
            profile=args.profile,
        )["Certificate"]
        certificate_names = [
            certificate.get("DomainName", ""),
            *(certificate.get("SubjectAlternativeNames", []) or []),
        ]
        if certificate.get("Status") != "ISSUED" or not certificate_covers(
            baseline["fotomoto_print"]["alias"], certificate_names
        ):
            raise SystemExit("Refusing Fotomoto print alias: the issued ACM certificate does not cover it")
    if request_router_enabled:
        redirect_arn, redirect_action = ensure_www_redirect_function(
            name=redirect_name,
            apex=baseline["canonical_alias"],
            www=baseline["optional_www_alias"],
            apply=args.apply,
            profile=args.profile,
        )
    social_router_arn: str | None = None
    social_router_action = "disabled"
    if args.include_api_front_door:
        social_router_arn, social_router_action = ensure_edge_function(
            name=social_router_name,
            apex=baseline["canonical_alias"],
            www=baseline["optional_www_alias"],
            source_path=SOCIAL_ROUTER_SOURCE,
            comment="Canonical www redirect and public album social document routing",
            apply=args.apply,
            profile=args.profile,
        )

    names = baseline["response_policy_names"]
    html_desired = policy_config(names["html"], baseline, baseline["html_cache_control"])
    static_desired = policy_config(names["static"], baseline, baseline["static_cache_control"])
    immutable_desired = policy_config(
        names["immutable"], baseline, baseline["immutable_cache_control"]
    )
    html_id, html_action = ensure_response_policy(html_desired, apply=args.apply, profile=args.profile)
    static_id, static_action = ensure_response_policy(
        static_desired, apply=args.apply, profile=args.profile
    )
    immutable_id, immutable_action = ensure_response_policy(
        immutable_desired, apply=args.apply, profile=args.profile
    )
    print_id = None
    print_action = "disabled"
    if args.include_fotomoto_print:
        print_id, print_action = ensure_response_policy(
            print_policy_config(baseline), apply=args.apply, profile=args.profile
        )

    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "account": account,
        "stack": args.stack_name,
        "distributionId": distribution_id,
        "currentETag": etag,
        "responsePolicies": {
            "html": html_action,
            "static": static_action,
            "immutable": immutable_action,
            "fotomotoPrint": print_action,
        },
        "wwwRedirect": redirect_action,
        "socialPreviewRouter": social_router_action,
        "apiFrontDoor": {
            "enabled": args.include_api_front_door,
            "originDomain": api_settings.get("origin_domain") if args.include_api_front_door else None,
            "policies": api_policy_actions,
            "secretValueRead": bool(args.apply and args.include_api_front_door),
        },
    }, indent=2))
    if not args.apply:
        print("Dry run only. Re-run with --apply, --expected-etag, and --expected-account-id after review.")
        return 0

    assert html_id and static_id and immutable_id
    if args.include_fotomoto_print:
        assert print_id
    # Updating an already-associated response policy can rotate the
    # distribution ETag. Refresh only after proving that the distribution
    # configuration itself is byte-for-byte equivalent after normalization;
    # the final If-Match still protects the update race.
    etag, config = refresh_distribution_after_dependencies(
        distribution_id, config, profile=args.profile
    )
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
    if request_router_enabled:
        assert redirect_arn
        associate_viewer_request(default, redirect_arn)
    desired_distribution["HttpVersion"] = "http2and3"
    desired_distribution["IsIPV6Enabled"] = True
    aliases = [baseline["canonical_alias"]]
    if args.include_www:
        aliases.append(baseline["optional_www_alias"])
    if args.include_fotomoto_print:
        aliases.append(baseline["fotomoto_print"]["alias"])
    desired_distribution["Aliases"] = {"Quantity": len(aliases), "Items": aliases}

    origin_verification_value = None
    if args.include_api_front_door:
        origin_verification_value = load_origin_verification_value(
            args.origin_parameter_name, region=args.region, profile=args.profile
        )
        upsert_exact_api_origin(desired_distribution, api_settings, origin_verification_value)
        desired_distribution["WebACLId"] = args.web_acl_arn
        remove_legacy_spa_error_responses(desired_distribution)

    existing_behaviors = desired_distribution.get("CacheBehaviors", {}).get("Items", []) or []
    managed_patterns = set(baseline["immutable_path_patterns"])
    managed_patterns.update(baseline.get("static_path_patterns", []))
    if args.include_fotomoto_print:
        managed_patterns.add(baseline["fotomoto_print"]["path_pattern"])
    if args.include_api_front_door:
        managed_patterns.update({
            api_settings["stats_path_pattern"],
            api_settings["public_path_pattern"],
            api_settings["private_path_pattern"],
        })
        managed_patterns.update(api_settings.get("social_path_patterns", []))
    preserved = [item for item in existing_behaviors if item.get("PathPattern") not in managed_patterns]
    immutable = [
        cache_behavior(default, pattern, immutable_id, baseline)
        for pattern in baseline["immutable_path_patterns"]
    ]
    static = [
        cache_behavior(
            default,
            pattern,
            static_id,
            baseline,
            cache_policy="static",
        )
        for pattern in baseline.get("static_path_patterns", [])
    ]
    print_behaviors = []
    if args.include_fotomoto_print:
        print_behaviors = [cache_behavior(
            default,
            baseline["fotomoto_print"]["path_pattern"],
            print_id,
            baseline,
            cache_policy="html",
        )]
    api_behaviors = []
    if args.include_api_front_door:
        assert public_api_cache_id and public_stats_cache_id and public_api_origin_request_id
        assert private_api_origin_request_id and api_response_id
        api_behaviors = [
            api_cache_behavior(
                default,
                settings=api_settings,
                path_pattern=api_settings["stats_path_pattern"],
                cache_policy_id=public_stats_cache_id,
                origin_request_policy_id=public_api_origin_request_id,
                response_policy_id=api_response_id,
                public=True,
            ),
            api_cache_behavior(
                default,
                settings=api_settings,
                path_pattern=api_settings["public_path_pattern"],
                cache_policy_id=public_api_cache_id,
                origin_request_policy_id=public_api_origin_request_id,
                response_policy_id=api_response_id,
                public=True,
            ),
            api_cache_behavior(
                default,
                settings=api_settings,
                path_pattern=api_settings["private_path_pattern"],
                cache_policy_id=baseline["cache_policies"]["html"],
                origin_request_policy_id=private_api_origin_request_id,
                response_policy_id=api_response_id,
                public=False,
            ),
        ]
        assert social_router_arn
        for pattern in api_settings.get("social_path_patterns", []):
            social_behavior = api_cache_behavior(
                default,
                settings=api_settings,
                path_pattern=pattern,
                cache_policy_id=baseline["cache_policies"]["html"],
                origin_request_policy_id=public_api_origin_request_id,
                response_policy_id=html_id,
                public=True,
            )
            social_behavior["ViewerProtocolPolicy"] = "redirect-to-https"
            associate_viewer_request(social_behavior, social_router_arn)
            api_behaviors.append(social_behavior)
    # CloudFront selects the first matching ordered behavior, so the exact
    # daily stats path precedes the five-minute public wildcard, and both
    # precede the cache-disabled catch-all API path.
    managed = api_behaviors + print_behaviors + immutable + static
    if request_router_enabled:
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
            # CloudFront expects the S3 DNS name without a trailing root-label
            # dot. Supplying a fully-qualified name with the final dot causes
            # UpdateDistribution to reject an otherwise valid logging bucket.
            "Bucket": args.logging_bucket_domain.rstrip("."),
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
