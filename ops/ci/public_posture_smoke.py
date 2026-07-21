#!/usr/bin/env python3
"""Credential-free production posture checks with aggregate-only output."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from typing import Callable
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ops import public_catalog_load_test as catalog_probe  # noqa: E402


MAX_JSON_BYTES = 10_000_000
MAX_HTML_BYTES = 2_000_000
MAX_SCRIPT_BYTES = 3_000_000
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$")
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
MEDIA_FIELDS = {
    "coverImageUrl": 2,
    "coverThumbnailUrl": 1,
    "downloadUrl": 3,
    "hlsUrl": 3,
    "thumbnailUrl": 1,
    "url": 3,
}
SENSITIVE_ROUTES = ("/login", "/admin", "/dashboard", "/sharedalbum/ci-posture-probe")


class PostureError(ValueError):
    """A public security, privacy, or availability invariant failed."""


@dataclass(frozen=True)
class RawResponse:
    status: int
    headers: dict[str, str]
    body: bytes


@dataclass(frozen=True)
class PostureConfig:
    site_url: str
    api_base_url: str
    api_origin_url: str
    execute_api_url: str
    media_domain: str
    media_bucket_name: str
    aws_region: str
    expected_public_album_count: int
    expected_release_sha: str = ""
    timeout: float = 20.0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


class _ModuleScriptParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.sources: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "script" and values.get("type") == "module" and values.get("src"):
            self.sources.append(values["src"] or "")


def _request_raw(url: str, timeout: float, headers: dict[str, str] | None = None, max_bytes: int = MAX_JSON_BYTES) -> RawResponse:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "*/*",
            "User-Agent": "ian-photography-public-posture/1",
            **(headers or {}),
        },
        method="GET",
    )
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=timeout) as response:
            status = response.status
            response_headers = {name.lower(): value for name, value in response.headers.items()}
            body = response.read(max_bytes + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        response_headers = {name.lower(): value for name, value in error.headers.items()}
        body = error.read(max_bytes + 1)
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise PostureError("public endpoint request failed") from error
    if len(body) > max_bytes:
        raise PostureError("public endpoint response exceeded its bounded limit")
    return RawResponse(status, response_headers, body)


def _https_base(value: str, label: str, *, path_required: str | None = None) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or not HOST_RE.fullmatch(parsed.hostname)
    ):
        raise PostureError(f"{label} is not a safe HTTPS URL")
    normalized_path = parsed.path.rstrip("/")
    if path_required is not None and normalized_path != path_required:
        raise PostureError(f"{label} has an unexpected path")
    return urllib.parse.urlunsplit(("https", parsed.netloc, normalized_path, "", ""))


def validate_config(config: PostureConfig) -> PostureConfig:
    site = _https_base(config.site_url, "site URL", path_required="")
    api = _https_base(config.api_base_url, "API base URL", path_required="/api")
    origin = _https_base(config.api_origin_url, "API origin URL", path_required="/api")
    execute = _https_base(config.execute_api_url, "execute API URL")
    if urllib.parse.urlsplit(api).hostname != urllib.parse.urlsplit(site).hostname:
        raise PostureError("API base URL must be same-origin")
    execute_host = urllib.parse.urlsplit(execute).hostname or ""
    if ".execute-api." not in execute_host or not execute_host.endswith(".amazonaws.com"):
        raise PostureError("execute API URL has an unexpected host")
    media_domain = config.media_domain.lower().rstrip(".")
    if not HOST_RE.fullmatch(media_domain) or ":" in media_domain or "/" in media_domain:
        raise PostureError("media domain is invalid")
    if not BUCKET_RE.fullmatch(config.media_bucket_name):
        raise PostureError("media bucket name is invalid")
    if not re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-[0-9]", config.aws_region):
        raise PostureError("AWS region is invalid")
    if config.expected_release_sha and not SHA_RE.fullmatch(config.expected_release_sha):
        raise PostureError("expected release SHA is invalid")
    if not 1 <= config.timeout <= 60:
        raise PostureError("timeout is invalid")
    if isinstance(config.expected_public_album_count, bool) or not 1 <= config.expected_public_album_count <= 10_000:
        raise PostureError("expected public album count is invalid")
    execute_path = urllib.parse.urlsplit(execute).path
    if not re.fullmatch(r"/[A-Za-z0-9_$-]+", execute_path):
        raise PostureError("execute API URL must identify one exact stage")
    return PostureConfig(
        site,
        api,
        origin,
        execute,
        media_domain,
        config.media_bucket_name,
        config.aws_region,
        config.expected_public_album_count,
        config.expected_release_sha,
        config.timeout,
    )


def _join(base: str, suffix: str) -> str:
    return f"{base.rstrip('/')}/{suffix.lstrip('/')}"


def _require_json(response: RawResponse, status: int) -> object:
    if response.status != status or "application/json" not in response.headers.get("content-type", "").lower():
        raise PostureError("JSON endpoint returned an unexpected status or content type")
    return catalog_probe._safe_json(response.body)


def _require_security_headers(response: RawResponse) -> None:
    if response.status != 200 or "text/html" not in response.headers.get("content-type", "").lower():
        raise PostureError("site route returned an unexpected status or content type")
    hsts = response.headers.get("strict-transport-security", "").lower()
    match = re.search(r"(?:^|;)\s*max-age=(\d+)(?:;|$)", hsts)
    if not match or int(match.group(1)) < 31_536_000:
        raise PostureError("site route has a weak HSTS policy")
    if response.headers.get("x-content-type-options", "").strip().lower() != "nosniff":
        raise PostureError("site route does not enforce nosniff")
    if response.headers.get("x-frame-options", "").strip().upper() != "DENY":
        raise PostureError("site route does not deny framing")
    if response.headers.get("referrer-policy", "").strip().lower() not in {
        "no-referrer", "strict-origin", "strict-origin-when-cross-origin"
    }:
        raise PostureError("site route has a weak referrer policy")
    permissions = response.headers.get("permissions-policy", "").lower().replace(" ", "")
    if not all(item in permissions for item in ("camera=()", "geolocation=()", "microphone=()")):
        raise PostureError("site route has a weak permissions policy")
    csp = response.headers.get("content-security-policy", "").lower()
    for directive in (
        "default-src 'self'", "base-uri 'self'", "object-src 'none'",
        "frame-ancestors 'none'", "form-action 'self'", "upgrade-insecure-requests",
    ):
        if directive not in csp:
            raise PostureError("site route has a weak content security policy")
    if "default-src *" in csp or "script-src *" in csp:
        raise PostureError("site route content security policy contains a wildcard")
    if "set-cookie" in response.headers:
        raise PostureError("public site route unexpectedly set a cookie")


def _inspect_media_urls(value: object, expected_host: str, candidates: list[tuple[int, str]]) -> None:
    if isinstance(value, list):
        for item in value:
            _inspect_media_urls(item, expected_host, candidates)
        return
    if not isinstance(value, dict):
        return
    for key, item in value.items():
        if key in MEDIA_FIELDS and item:
            if not isinstance(item, str):
                raise PostureError("public media URL is not a string")
            parsed = urllib.parse.urlsplit(item)
            if (
                parsed.scheme != "https"
                or parsed.hostname != expected_host
                or parsed.username
                or parsed.password
                or "x-amz-" in parsed.query.lower()
            ):
                raise PostureError("public media URL bypasses the exact CDN")
            candidates.append((MEDIA_FIELDS[key], item))
        _inspect_media_urls(item, expected_host, candidates)


def run_posture(
    config: PostureConfig,
    *,
    requester: Callable[[str, float, dict[str, str] | None, int], RawResponse] = _request_raw,
) -> dict[str, int | bool]:
    config = validate_config(config)
    homepage = requester(config.site_url + "/", config.timeout, None, MAX_HTML_BYTES)
    _require_security_headers(homepage)
    if b"aws-rum-web" in homepage.body.lower():
        raise PostureError("RUM SDK must not be eagerly embedded in HTML")

    privacy_routes = 0
    for route in SENSITIVE_ROUTES:
        response = requester(
            _join(config.site_url, route),
            config.timeout,
            {"DNT": "1", "Sec-GPC": "1"},
            MAX_HTML_BYTES,
        )
        _require_security_headers(response)
        if b"aws-rum-web" in response.body.lower():
            raise PostureError("sensitive route eagerly referenced the RUM SDK")
        privacy_routes += 1

    if config.expected_release_sha:
        parser = _ModuleScriptParser()
        try:
            parser.feed(homepage.body.decode("utf-8"))
        except UnicodeDecodeError as error:
            raise PostureError("homepage is not UTF-8") from error
        if len(parser.sources) != 1:
            raise PostureError("homepage must reference one entry module")
        entry_url = urllib.parse.urljoin(config.site_url + "/", parser.sources[0])
        entry = requester(entry_url, config.timeout, None, MAX_SCRIPT_BYTES)
        if entry.status != 200 or config.expected_release_sha.encode("ascii") not in entry.body:
            raise PostureError("deployed frontend release does not match the expected commit")

    origin = requester(
        _join(config.api_origin_url, "/public/albums?limit=1"), config.timeout, None, MAX_JSON_BYTES
    )
    _require_json(origin, 403)
    origin_cache = origin.headers.get("cache-control", "").lower()
    if "private" not in origin_cache or "no-store" not in origin_cache or "access-control-allow-origin" in origin.headers:
        raise PostureError("direct API origin denial is not fail-closed")

    execute = requester(
        _join(config.execute_api_url, "/public/albums?limit=1"), config.timeout, None, MAX_JSON_BYTES
    )
    execute_payload = _require_json(execute, 404)
    if (
        execute_payload != {"message": "Not Found"}
        or execute.headers.get("access-control-allow-origin")
    ):
        raise PostureError("default execute API endpoint is still reachable")

    hostile_origin = "https://cross-origin.invalid"
    hostile = requester(
        _join(config.api_base_url, "/public/albums?limit=1"),
        config.timeout,
        {"Origin": hostile_origin},
        MAX_JSON_BYTES,
    )
    _require_json(hostile, 200)
    if hostile.headers.get("access-control-allow-origin"):
        raise PostureError("hostile origin received an allow-origin response")

    protected = requester(
        _join(config.api_base_url, "/users"),
        config.timeout,
        {"Origin": hostile_origin},
        MAX_JSON_BYTES,
    )
    _require_json(protected, 401)
    protected_cache = protected.headers.get("cache-control", "").lower()
    # API Gateway's generated HTTP API authorizer denial does not currently
    # include Cache-Control. A 401 is not heuristically cacheable; if a cache
    # directive is present, however, require the stronger private/no-store
    # contract and always reject evidence that CloudFront served a cached copy.
    if protected_cache and (
        "private" not in protected_cache or "no-store" not in protected_cache
    ):
        raise PostureError("protected endpoint response is explicitly cacheable")
    if protected.headers.get("age") or "hit" in protected.headers.get("x-cache", "").lower():
        raise PostureError("protected endpoint response was served from cache")
    if protected.headers.get("access-control-allow-origin"):
        raise PostureError("protected endpoint allowed a hostile origin")

    media_candidates: list[tuple[int, str]] = []

    def catalog_request(url: str, timeout: float) -> tuple[object, dict[str, str]]:
        response = requester(url, timeout, {"Accept": "application/json"}, MAX_JSON_BYTES)
        payload = _require_json(response, 200)
        _inspect_media_urls(payload, config.media_domain, media_candidates)
        return payload, response.headers

    catalog_metrics = catalog_probe.run_catalog_probe(
        config.api_base_url,
        limit=100,
        max_pages=100,
        detail_sample=10,
        timeout=config.timeout,
        requester=catalog_request,
    )
    if catalog_metrics["albumCount"] < 1 or not catalog_metrics["complete"]:
        raise PostureError("public catalog is unexpectedly empty or incomplete")
    if catalog_metrics["albumCount"] != config.expected_public_album_count:
        raise PostureError("public catalog count differs from the reviewed production baseline")
    if not media_candidates:
        raise PostureError("public catalog did not expose a CDN media candidate")
    media_url = min(media_candidates, key=lambda item: item[0])[1]
    media = requester(media_url, config.timeout, {"Range": "bytes=0-0"}, 65_536)
    if media.status not in {200, 206} or "set-cookie" in media.headers:
        raise PostureError("public CDN media candidate is unavailable")

    media_path = urllib.parse.urlsplit(media_url).path
    bucket_url = (
        f"https://{config.media_bucket_name}.s3.{config.aws_region}.amazonaws.com"
        f"{media_path}"
    )
    direct_bucket = requester(bucket_url, config.timeout, None, 65_536)
    if direct_bucket.status != 403:
        raise PostureError("direct media bucket access is not denied")

    return {
        "albumCount": int(catalog_metrics["albumCount"]),
        "catalogComplete": True,
        "catalogPageCount": int(catalog_metrics["pageCount"]),
        "detailCount": int(catalog_metrics["detailCount"]),
        "directEndpointChecks": 2,
        "mediaAuthorizationChecks": 2,
        "privacyRouteChecks": privacy_routes,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-url", required=True)
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument("--api-origin-url", required=True)
    parser.add_argument("--execute-api-url", required=True)
    parser.add_argument("--media-domain", required=True)
    parser.add_argument("--media-bucket-name", required=True)
    parser.add_argument("--aws-region", required=True)
    parser.add_argument("--expected-public-album-count", required=True, type=int)
    parser.add_argument("--expected-release-sha", default="")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args(argv)
    try:
        metrics = run_posture(
            PostureConfig(
                args.site_url,
                args.api_base_url,
                args.api_origin_url,
                args.execute_api_url,
                args.media_domain,
                args.media_bucket_name,
                args.aws_region,
                args.expected_public_album_count,
                args.expected_release_sha,
                args.timeout,
            )
        )
    except (PostureError, catalog_probe.ProbeError):
        print("public posture smoke failed closed", file=sys.stderr)
        return 2
    print(json.dumps(metrics, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
