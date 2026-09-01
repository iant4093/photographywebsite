#!/usr/bin/env python3
"""Bounded, aggregate-only validation for a nonproduction public catalog."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Callable
import urllib.error
import urllib.parse
import urllib.request
import uuid


CONFIRMATION = "NONPRODUCTION_LOAD_TEST"
ACCOUNT_ID = re.compile(r"^[0-9]{12}$")
PRODUCTION_DOMAIN = "iantruongphotography.com"
SUMMARY_FIELDS = {
    "albumId",
    "type",
    "title",
    "description",
    "category",
    "createdAt",
    "uploadedAt",
    "visibility",
    "imageCount",
    "coverImageUrl",
    "coverThumbnailUrl",
    "coverBlurhash",
}
HOVER_PREVIEW_FIELDS = {
    "hoverPreviewStatus",
    "hoverPreviewManifestUrl",
    "hoverPreviewVersion",
}
SUMMARY_OPTIONAL_FIELDS = {
    "galleryCategoryOrder",
    "coverHlsUrl",
    "coverThumbnailTime",
} | HOVER_PREVIEW_FIELDS
DETAIL_FIELDS = (SUMMARY_FIELDS - {"imageCount"}) | {"qrCodeUrl"}
IMAGE_REQUIRED_FIELDS = {"id", "url", "thumbnailUrl", "downloadUrl"}
IMAGE_OPTIONAL_FIELDS = {
    "previewSrcSet",
    "width",
    "height",
    "blurhash",
    "exif",
    "thumbnailTime",
    "hlsUrl",
}
EXIF_FIELDS = {"model", "lens", "focalLength", "focalRatio", "shutterSpeed", "iso"}
FORBIDDEN_PUBLIC_FIELDS = {
    "ownerEmail",
    "ownerSub",
    "shareCode",
    "s3Prefix",
    "legacyS3Prefix",
    "rawKey",
    "thumbKey",
    "hlsKey",
    "previewKeys",
    "hoverPreviewManifestKey",
    "mediaConvertJobId",
    "backupToGoogleDrive",
    "expiresAt",
    "expiresIn",
}


class ProbeError(ValueError):
    """A guard, transport contract, or public schema invariant failed."""


def _safe_json(data: bytes) -> object:
    def no_duplicates(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ProbeError("JSON response contains duplicate keys")
            value[key] = item
        return value

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=no_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProbeError("response is not valid UTF-8 JSON") from error


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise ProbeError("redirects are forbidden during the load test")


def request_json(url: str, timeout: float) -> tuple[object, dict[str, str]]:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "photography-nonproduction-probe/1"},
        method="GET",
    )
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > 10_000_000:
                raise ProbeError("response exceeds the bounded body limit")
            body = response.read(10_000_001)
            if len(body) > 10_000_000:
                raise ProbeError("response exceeds the bounded body limit")
            headers = {name.lower(): value for name, value in response.headers.items()}
    except ProbeError:
        raise
    except urllib.error.HTTPError as error:
        raise ProbeError(f"endpoint returned HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise ProbeError("endpoint request failed") from error
    return _safe_json(body), headers


def _validate_cache_headers(headers: dict[str, str]) -> None:
    content_type = headers.get("content-type", "").lower()
    cache_control = headers.get("cache-control", "").lower()
    if "application/json" not in content_type:
        raise ProbeError("public response is not application/json")
    if "public" not in cache_control or "s-maxage=" not in cache_control:
        raise ProbeError("public response is not explicitly edge-cacheable")
    if "private" in cache_control or "no-store" in cache_control:
        raise ProbeError("public response contains a private cache directive")
    if "set-cookie" in headers:
        raise ProbeError("public response unexpectedly sets a cookie")


def _public_url(value: object, *, allow_empty: bool = False) -> None:
    if allow_empty and value == "":
        return
    if not isinstance(value, str):
        raise ProbeError("public URL is not a string")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ProbeError("public media URL is not a safe HTTPS URL")
    lowered_query = parsed.query.lower()
    if "x-amz-" in lowered_query or "x-goog-" in lowered_query:
        raise ProbeError("public DTO exposes a signed provider URL")


def _exact_fields(value: object, allowed: set[str], label: str) -> dict:
    if not isinstance(value, dict):
        raise ProbeError(f"{label} is not an object")
    if set(value) != allowed:
        raise ProbeError(f"{label} does not match the public field allowlist")
    if set(value) & FORBIDDEN_PUBLIC_FIELDS:
        raise ProbeError(f"{label} contains a forbidden field")
    return value


def validate_summary(value: object) -> dict:
    if not isinstance(value, dict):
        raise ProbeError("album summary is not an object")
    fields = set(value)
    if not SUMMARY_FIELDS <= fields or fields - SUMMARY_FIELDS - SUMMARY_OPTIONAL_FIELDS:
        raise ProbeError("album summary does not match the public field allowlist")
    if fields & FORBIDDEN_PUBLIC_FIELDS:
        raise ProbeError("album summary contains a forbidden field")
    item = value
    try:
        uuid.UUID(item["albumId"])
    except (AttributeError, TypeError, ValueError) as error:
        raise ProbeError("album summary has an invalid identifier") from error
    if item["visibility"] != "public" or item["type"] not in {"photo", "video"}:
        raise ProbeError("album summary has an invalid public classification")
    if isinstance(item["imageCount"], bool) or not isinstance(item["imageCount"], int) or item["imageCount"] < 0:
        raise ProbeError("album summary has an invalid image count")
    if "galleryCategoryOrder" in item and (
        isinstance(item["galleryCategoryOrder"], bool)
        or not isinstance(item["galleryCategoryOrder"], int)
        or item["galleryCategoryOrder"] < 0
    ):
        raise ProbeError("album summary has an invalid gallery category order")
    has_cover_stream = "coverHlsUrl" in item
    has_cover_time = "coverThumbnailTime" in item
    if has_cover_stream != has_cover_time or (has_cover_stream and item["type"] != "video"):
        raise ProbeError("album summary has invalid cover preview metadata")
    if has_cover_stream:
        _public_url(item["coverHlsUrl"])
        cover_time = item["coverThumbnailTime"]
        if (
            isinstance(cover_time, bool)
            or not isinstance(cover_time, (int, float))
            or not 0 <= cover_time <= 86400
        ):
            raise ProbeError("album summary has invalid cover preview metadata")
    hover_fields = fields & HOVER_PREVIEW_FIELDS
    if hover_fields:
        hover_status = item.get("hoverPreviewStatus")
        if item["type"] != "photo":
            raise ProbeError("album summary has invalid hover preview metadata")
        if hover_status == "unavailable":
            if hover_fields != {"hoverPreviewStatus"}:
                raise ProbeError("album summary has invalid hover preview metadata")
        elif hover_status == "ready":
            if hover_fields != HOVER_PREVIEW_FIELDS:
                raise ProbeError("album summary has invalid hover preview metadata")
            version = item["hoverPreviewVersion"]
            if not isinstance(version, str) or not re.fullmatch(r"[a-f0-9]{24}", version):
                raise ProbeError("album summary has invalid hover preview metadata")
            manifest_url = item["hoverPreviewManifestUrl"]
            _public_url(manifest_url)
            parsed_manifest = urllib.parse.urlsplit(manifest_url)
            expected_path = (
                f"/public-previews/{item['albumId']}/v3/hover-{version}.json"
            )
            if (
                parsed_manifest.path != expected_path
                or parsed_manifest.query
                or parsed_manifest.fragment
            ):
                raise ProbeError("album summary has invalid hover preview metadata")
            cover_url = item.get("coverImageUrl") or item.get("coverThumbnailUrl")
            if cover_url:
                parsed_cover = urllib.parse.urlsplit(cover_url)
                if (
                    parsed_cover.scheme,
                    parsed_cover.netloc,
                ) != (
                    parsed_manifest.scheme,
                    parsed_manifest.netloc,
                ):
                    raise ProbeError("album summary has invalid hover preview metadata")
        else:
            raise ProbeError("album summary has invalid hover preview metadata")
    for name in (
        "title",
        "description",
        "category",
        "createdAt",
        "uploadedAt",
        "coverBlurhash",
    ):
        if not isinstance(item[name], str):
            raise ProbeError("album summary has an invalid text field")
    _public_url(item["coverImageUrl"], allow_empty=True)
    _public_url(item["coverThumbnailUrl"], allow_empty=True)
    return item


def validate_detail(payload: object, expected_album_id: str) -> int:
    root = _exact_fields(payload, {"album", "images"}, "album detail response")
    album = root["album"]
    if not isinstance(album, dict):
        raise ProbeError("album detail is not an object")
    album_fields = set(album)
    if not DETAIL_FIELDS <= album_fields or album_fields - DETAIL_FIELDS - SUMMARY_OPTIONAL_FIELDS:
        raise ProbeError("album detail does not match the public field allowlist")
    if album_fields & FORBIDDEN_PUBLIC_FIELDS:
        raise ProbeError("album detail contains a forbidden field")
    # Reuse every summary value check; imageCount is the only list-only field.
    validate_summary({
        **{key: value for key, value in album.items() if key != "qrCodeUrl"},
        "imageCount": 0,
    })
    _public_url(album["qrCodeUrl"])
    if album.get("albumId") != expected_album_id or album.get("visibility") != "public":
        raise ProbeError("album detail does not match its public summary")
    if not isinstance(root["images"], list):
        raise ProbeError("album images is not an array")
    for image in root["images"]:
        if not isinstance(image, dict):
            raise ProbeError("public image is not an object")
        fields = set(image)
        if not IMAGE_REQUIRED_FIELDS <= fields or fields - IMAGE_REQUIRED_FIELDS - IMAGE_OPTIONAL_FIELDS:
            raise ProbeError("public image does not match the field allowlist")
        if fields & FORBIDDEN_PUBLIC_FIELDS:
            raise ProbeError("public image contains a forbidden field")
        if not isinstance(image["id"], str) or not image["id"]:
            raise ProbeError("public image has an invalid identifier")
        for name in ("url", "thumbnailUrl", "downloadUrl"):
            _public_url(image[name])
        if "hlsUrl" in image:
            _public_url(image["hlsUrl"])
        if "previewSrcSet" in image:
            preview = image["previewSrcSet"]
            if not isinstance(preview, list) or not preview:
                raise ProbeError("preview source set is invalid")
            for candidate in preview:
                if not isinstance(candidate, dict) or set(candidate) != {"width", "url"}:
                    raise ProbeError("preview candidate does not match its allowlist")
                if isinstance(candidate["width"], bool) or not isinstance(candidate["width"], int):
                    raise ProbeError("preview candidate width is invalid")
                _public_url(candidate["url"])
        if "exif" in image:
            exif = image["exif"]
            if not isinstance(exif, dict) or set(exif) - EXIF_FIELDS:
                raise ProbeError("EXIF data exceeds the safe public allowlist")
    return len(root["images"])


def run_catalog_probe(
    base_url: str,
    *,
    limit: int,
    max_pages: int,
    detail_sample: int,
    timeout: float,
    requester: Callable[[str, float], tuple[object, dict[str, str]]] = request_json,
) -> dict:
    album_ids: list[str] = []
    expected_counts: dict[str, int] = {}
    seen_cursors: set[str] = set()
    cursor = None
    pages = 0
    requests = 0
    while True:
        if pages >= max_pages:
            raise ProbeError("catalog did not complete within the page bound")
        query = {"limit": str(limit)}
        if cursor:
            query["cursor"] = cursor
        url = f"{base_url}/public/albums?{urllib.parse.urlencode(query)}"
        payload, headers = requester(url, timeout)
        requests += 1
        pages += 1
        _validate_cache_headers(headers)
        root = _exact_fields(payload, {"items", "nextCursor"}, "catalog page")
        if not isinstance(root["items"], list):
            raise ProbeError("catalog items is not an array")
        for value in root["items"]:
            item = validate_summary(value)
            album_id = item["albumId"]
            if album_id in expected_counts:
                raise ProbeError("catalog contains a duplicate album")
            album_ids.append(album_id)
            expected_counts[album_id] = item["imageCount"]
        cursor = root["nextCursor"]
        if cursor is None:
            break
        if not isinstance(cursor, str) or not cursor or len(cursor) > 4096:
            raise ProbeError("catalog cursor is invalid")
        if cursor in seen_cursors:
            raise ProbeError("catalog cursor repeated")
        seen_cursors.add(cursor)

    image_count = 0
    checked_details = 0
    for album_id in album_ids[:detail_sample]:
        encoded = urllib.parse.quote(album_id, safe="")
        payload, headers = requester(f"{base_url}/public/albums/{encoded}", timeout)
        requests += 1
        _validate_cache_headers(headers)
        count = validate_detail(payload, album_id)
        if count != expected_counts[album_id]:
            raise ProbeError("catalog and detail image counts do not match")
        image_count += count
        checked_details += 1

    return {
        "networkExecuted": True,
        "pageCount": pages,
        "requestCount": requests,
        "albumCount": len(album_ids),
        "detailCount": checked_details,
        "sampledImageCount": image_count,
        "cursorCount": len(seen_cursors),
        "complete": True,
    }


def validate_nonproduction_target(base_url: str) -> str:
    parsed = urllib.parse.urlsplit(base_url)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if not hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ProbeError("base URL must be a credential-free origin or stage URL")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and hostname in {"localhost", "127.0.0.1", "::1"}):
        raise ProbeError("base URL must use HTTPS except for loopback development")
    if hostname == PRODUCTION_DOMAIN or hostname.endswith(f".{PRODUCTION_DOMAIN}"):
        raise ProbeError("the production website domain is forbidden")
    labels = set(hostname.split(".")) | {part.lower() for part in parsed.path.split("/") if part}
    if labels & {"prod", "production"}:
        raise ProbeError("a production-labelled host or stage is forbidden")
    return base_url.rstrip("/")


def active_account_id(aws_cli: str) -> str:
    try:
        result = subprocess.run(
            [aws_cli, "sts", "get-caller-identity", "--output", "json"],
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
        )
        payload = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise ProbeError("unable to verify the active AWS account") from error
    account = payload.get("Account") if isinstance(payload, dict) else None
    if not isinstance(account, str) or not ACCOUNT_ID.fullmatch(account):
        raise ProbeError("AWS identity returned an invalid account")
    return account


def validate_apply_guards(args, account_lookup: Callable[[str], str] = active_account_id) -> str:  # noqa: ANN001
    if args.environment != "nonproduction" or args.confirm != CONFIRMATION:
        raise ProbeError("explicit nonproduction confirmation is required")
    if not all(
        isinstance(value, str) and ACCOUNT_ID.fullmatch(value)
        for value in (args.expected_account_id, args.confirm_account_id, args.production_account_id)
    ):
        raise ProbeError("three explicit 12-digit account guards are required")
    if args.expected_account_id != args.confirm_account_id:
        raise ProbeError("expected and confirmed accounts do not match")
    if args.expected_account_id == args.production_account_id:
        raise ProbeError("the production AWS account is forbidden")
    base_url = validate_nonproduction_target(args.base_url or "")
    if account_lookup(args.aws_cli) != args.expected_account_id:
        raise ProbeError("the active AWS account does not match the nonproduction guard")
    return base_url


def _write(path: Path, evidence: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="perform bounded network requests")
    parser.add_argument("--base-url")
    parser.add_argument("--environment")
    parser.add_argument("--confirm")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--confirm-account-id")
    parser.add_argument("--production-account-id")
    parser.add_argument("--aws-cli", default="aws")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--max-pages", type=int, default=20)
    parser.add_argument("--detail-sample", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--output", type=Path, default=Path("public-catalog-load-evidence.json"))
    args = parser.parse_args(argv)
    evidence = {
        "schemaVersion": 1,
        "kind": "public-catalog-load-test",
        "passed": False,
        "metrics": {"networkExecuted": False},
        "violations": [],
    }
    try:
        if not 1 <= args.limit <= 100 or not 1 <= args.max_pages <= 50:
            raise ProbeError("request bounds are invalid")
        if not 0 <= args.detail_sample <= 20 or not 1 <= args.timeout <= 30:
            raise ProbeError("detail or timeout bounds are invalid")
        if not args.apply:
            evidence["passed"] = True
            evidence["metrics"].update(
                {
                    "mode": "dry-run",
                    "requestLimit": args.limit,
                    "pageLimit": args.max_pages,
                    "detailLimit": args.detail_sample,
                }
            )
        else:
            base_url = validate_apply_guards(args)
            evidence["metrics"] = run_catalog_probe(
                base_url,
                limit=args.limit,
                max_pages=args.max_pages,
                detail_sample=args.detail_sample,
                timeout=args.timeout,
            )
            evidence["passed"] = True
    except ProbeError as error:
        evidence["violations"] = [{"code": "public_catalog_probe_failed"}]
        _write(args.output, evidence)
        print(f"public catalog load test failed: {error}", file=sys.stderr)
        return 2
    _write(args.output, evidence)
    print(json.dumps(evidence["metrics"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
