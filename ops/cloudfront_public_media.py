#!/usr/bin/env python3
"""Stage the public media behaviors on the existing, WAF-protected site distribution."""

import argparse
import copy
import json

from aws_stack import stack_resource
from cloudfront_frontend import (
    HERE,
    PUBLIC_MEDIA_PATH,
    PUBLIC_MEDIA_ORIGIN_ID,
    PUBLIC_MEDIA_FUNCTION_NAME,
    associate_viewer_request,
    aws_json,
    aws_with_json_file,
    ensure_cache_policy,
    ensure_edge_function,
    ensure_response_policy,
    normalize_policy,
    refresh_distribution_after_dependencies,
    stack_output,
    validate_apply_guards,
)

CACHE_HEADER = "x-public-media-cache"
LEGACY_REDIRECT_FUNCTION_NAME = "iantruongphotography-legacy-media-redirect-v1"
EXPECTED_LEGACY_PATTERNS = (
    "public-previews/*",
    "site/hero/versions/*",
    "site/hero/*",
    "albums/*/preview/v3/*",
    "albums/*/preview/v2/*",
)


def cache_policy(source, *, enable_cache):
    config = copy.deepcopy(source)
    config["Name"] = f"IanPublicMedia-{source['Name'].removeprefix('Managed-')}"
    config["Comment"] = "Isolate public media cache keys from signed requests"
    config["ParametersInCacheKeyAndForwardedToOrigin"]["HeadersConfig"] = {
        "HeaderBehavior": "whitelist",
        "Headers": {"Quantity": 1, "Items": [CACHE_HEADER]},
    }
    if not enable_cache or config["MaxTTL"] == 0:
        # CloudFront requires a nonzero maximum when the cache key uses headers.
        config.update(MinTTL=0, DefaultTTL=0, MaxTTL=1)
    return config


def response_policy(source):
    config = normalize_policy(source)
    config["Name"] = f"IanPublicMedia-{source['Name']}"
    config["Comment"] = "Preserve media response headers and sandbox direct website-origin documents"
    # Browsers taint the Origin of a cross-origin request redirected back to
    # the site. The access point serves only explicitly tagged public objects.
    config["CorsConfig"]["AccessControlAllowOrigins"] = {"Quantity": 1, "Items": ["*"]}
    config["SecurityHeadersConfig"]["ContentSecurityPolicy"] = {
        "ContentSecurityPolicy": "sandbox; default-src 'none'",
        "Override": True,
    }
    return config


def updated_distribution(config, legacy, origin_domain, function_arn, cache_ids, response_ids):
    if not config["WebACLId"] or legacy["WebACLId"] not in ("", config["WebACLId"]):
        raise RuntimeError("The frontend and legacy media edge must share the current WAF")

    source_behaviors = legacy["CacheBehaviors"]["Items"]
    if tuple(behavior["PathPattern"] for behavior in source_behaviors) != EXPECTED_LEGACY_PATTERNS:
        raise RuntimeError("The legacy media behavior order differs from the reviewed configuration")

    origins = legacy["Origins"]["Items"]
    if len(origins) != 1 or not origins[0].get("OriginAccessControlId"):
        raise RuntimeError("Expected one legacy media origin with signed origin access")
    origin = {**origins[0], "Id": PUBLIC_MEDIA_ORIGIN_ID, "DomainName": origin_domain}
    source_behaviors = [*source_behaviors, {**legacy["DefaultCacheBehavior"], "PathPattern": "*"}]
    public = []
    for source in source_behaviors:
        behavior = copy.deepcopy(source)
        behavior.update(
            PathPattern=PUBLIC_MEDIA_PATH.lstrip("/") + source["PathPattern"],
            TargetOriginId=PUBLIC_MEDIA_ORIGIN_ID,
            CachePolicyId=cache_ids[source["CachePolicyId"]],
            ResponseHeadersPolicyId=response_ids[source["ResponseHeadersPolicyId"]],
        )
        if behavior["TrustedKeyGroups"]["Enabled"] or behavior["TrustedSigners"]["Enabled"]:
            raise RuntimeError("The legacy behavior requires signed viewer requests")
        if behavior["LambdaFunctionAssociations"]["Quantity"]:
            raise RuntimeError("A legacy media behavior has an unexpected Lambda association")
        associate_viewer_request(behavior, function_arn)
        public.append(behavior)

    desired = copy.deepcopy(config)
    existing = desired["CacheBehaviors"]["Items"]
    public_patterns = {behavior["PathPattern"] for behavior in public}
    retained = []
    for behavior in existing:
        if behavior["PathPattern"].lstrip("/") in public_patterns:
            if behavior["TargetOriginId"] != PUBLIC_MEDIA_ORIGIN_ID:
                raise RuntimeError("A public media behavior already belongs to another origin")
        else:
            retained.append(behavior)
    desired["CacheBehaviors"] = {"Quantity": len(public) + len(retained), "Items": public + retained}
    retained_origins = [item for item in desired["Origins"]["Items"] if item["Id"] != PUBLIC_MEDIA_ORIGIN_ID]
    desired["Origins"] = {"Quantity": len(retained_origins) + 1, "Items": [*retained_origins, origin]}
    return desired


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frontend-distribution-id", required=True)
    parser.add_argument("--expected-account-id")
    parser.add_argument("--expected-etag")
    parser.add_argument("--profile")
    parser.add_argument("--enable-public-cache", action="store_true",
                        help="Restore legacy cache TTLs once both distributions receive revocation invalidations")
    parser.add_argument("--publish-legacy-redirect", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    profile = args.profile
    account = aws_json(["sts", "get-caller-identity"], profile=profile)["Account"]
    frontend = aws_json(
        ["cloudfront", "get-distribution-config", "--id", args.frontend_distribution_id], profile=profile
    )
    validate_apply_guards(
        apply=args.apply, expected_etag=args.expected_etag, current_etag=frontend["ETag"],
        expected_account=args.expected_account_id, account=account,
    )
    config = frontend["DistributionConfig"]
    apex = config["Aliases"]["Items"][0]
    if args.publish_legacy_redirect:
        arn, action = ensure_edge_function(
            name=LEGACY_REDIRECT_FUNCTION_NAME, apex=apex, www=f"www.{apex}",
            source_path=HERE / "cloudfront_legacy_media_redirect.js",
            comment="Keep old media URLs working on the protected website", apply=args.apply, profile=profile,
        )
        print(json.dumps({"legacyRedirect": action, "function": arn}))
        return
    region = "us-west-2"
    media_id = stack_resource("ian-website", "ImagesCloudFront", profile, region)
    legacy = aws_json(["cloudfront", "get-distribution-config", "--id", media_id], profile=profile)["DistributionConfig"]
    origin_domain = stack_output("ian-photography-public-media-origin", "OriginDomain", profile, region)
    if not origin_domain.endswith(f"-s3alias.s3.{region}.amazonaws.com"):
        raise RuntimeError("The public media origin stack did not provide an S3 access point alias")
    defaults = legacy["DefaultCacheBehavior"]
    behaviors = [defaults, *legacy["CacheBehaviors"]["Items"]]
    cache_ids = dict.fromkeys(item["CachePolicyId"] for item in behaviors)
    response_ids = dict.fromkeys(item["ResponseHeadersPolicyId"] for item in behaviors)
    function_arn = f"arn:aws:cloudfront::{account}:function/{PUBLIC_MEDIA_FUNCTION_NAME}"
    desired = updated_distribution(config, legacy, origin_domain, function_arn, cache_ids, response_ids)
    print(json.dumps({
        "frontend": args.frontend_distribution_id,
        "etag": frontend["ETag"],
        "origin": origin_domain,
        "publicCache": args.enable_public_cache,
        "behaviors": [item["PathPattern"] for item in desired["CacheBehaviors"]["Items"] if item["TargetOriginId"] == PUBLIC_MEDIA_ORIGIN_ID],
    }, indent=2))
    if not args.apply:
        return

    for source_id in cache_ids:
        source = aws_json(["cloudfront", "get-cache-policy-config", "--id", source_id], profile=profile)
        cache_ids[source_id], _ = ensure_cache_policy(
            cache_policy(source["CachePolicyConfig"], enable_cache=args.enable_public_cache), apply=True, profile=profile
        )
    for source_id in response_ids:
        source = aws_json(["cloudfront", "get-response-headers-policy-config", "--id", source_id], profile=profile)
        response_ids[source_id], _ = ensure_response_policy(
            response_policy(source["ResponseHeadersPolicyConfig"]), apply=True, profile=profile,
        )
    published, _ = ensure_edge_function(
        name=PUBLIC_MEDIA_FUNCTION_NAME, apex=apex, www=f"www.{apex}", source_path=HERE / "cloudfront_public_media.js",
        comment="Route tagged public media on the site", apply=True, profile=profile,
    )
    if published != function_arn:
        raise RuntimeError("CloudFront did not publish the expected public media function")
    etag, config = refresh_distribution_after_dependencies(args.frontend_distribution_id, config, profile=profile)
    desired = updated_distribution(config, legacy, origin_domain, function_arn, cache_ids, response_ids)
    if desired == config:
        return
    aws_with_json_file(
        ["cloudfront", "update-distribution", "--id", args.frontend_distribution_id, "--if-match", etag,
         "--distribution-config", "file://{json_file}"],
        desired, profile=profile,
    )


if __name__ == "__main__":
    main()
