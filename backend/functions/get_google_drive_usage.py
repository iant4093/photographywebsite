"""Admin-only, once-daily aggregate Google Drive storage report."""

from __future__ import annotations

import copy
import datetime as dt
import json
import logging
import os
import re
import time
from urllib.parse import urlencode
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request as UrlRequest, build_opener

import boto3
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import require_admin
from front_door import verify_front_door_request
from response_helpers import error_response, json_response


logger = logging.getLogger("photography_api.google_drive_usage")
logger.setLevel(logging.INFO)

CACHE_KEY = "google-drive-usage-v2"
CACHE_SCHEMA_VERSION = 2
DRIVE_SCOPE = ["https://www.googleapis.com/auth/drive.file"]
RAW_BACKUP_SCOPE = ["https://www.googleapis.com/auth/drive.metadata.readonly"]
DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"
MAX_CACHE_PAYLOAD_BYTES = 100_000
MAX_PROVIDER_RESPONSE_BYTES = 2_000_000
MAX_PROVIDER_PAGES = 500
MAX_BACKUP_ITEMS = 100_000
MAX_PROVIDER_ATTEMPTS = 3
MAX_BYTE_VALUE = 9_223_372_036_854_775_807
DRIVE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
SCHEDULED_REFRESH_EVENT = {
    "source": "ian.photography.drive-usage-refresh",
    "action": "refresh",
}
SCHEDULED_REFRESH_HOUR_UTC = 9
SCHEDULED_REFRESH_MINUTE_UTC = 15

cache_table = boto3.resource("dynamodb").Table(os.environ["DRIVE_USAGE_CACHE_TABLE"])
ssm_client = boto3.client("ssm")
_credential_payload_cache = None
_credentials_cache = None
_raw_backup_credentials_cache = None


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, _request, _file_pointer, _code, _message, _headers, _new_url):
        return None


_provider_opener = build_opener(_NoRedirectHandler)


class ProviderContractError(ValueError):
    """Google returned data outside the intentionally narrow report contract."""


def _utc_today():
    return dt.datetime.now(dt.timezone.utc).date()


def _credential_payload():
    global _credential_payload_cache
    if _credential_payload_cache is not None:
        return _credential_payload_cache
    parameter_name = os.environ.get("GOOGLE_OAUTH_PARAMETER", "").strip()
    if not parameter_name:
        raise ProviderContractError("Google credential parameter is unavailable")
    response = ssm_client.get_parameter(Name=parameter_name, WithDecryption=True)
    raw = response.get("Parameter", {}).get("Value")
    if not isinstance(raw, str) or not 2 <= len(raw) <= 64_000:
        raise ProviderContractError("Google credential parameter is invalid")
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        raise ProviderContractError("Google credential parameter is invalid") from None
    if not isinstance(payload, dict):
        raise ProviderContractError("Google credential parameter is invalid")
    _credential_payload_cache = payload
    return payload


def _credentials():
    global _credentials_cache
    if _credentials_cache is None:
        payload = _credential_payload()
        oauth_info = payload.get("oauth") if isinstance(payload.get("oauth"), dict) else None
        service_info = payload.get("service_account") if isinstance(payload.get("service_account"), dict) else None
        if oauth_info:
            _credentials_cache = Credentials.from_authorized_user_info(oauth_info, scopes=DRIVE_SCOPE)
        elif service_info:
            _credentials_cache = service_account.Credentials.from_service_account_info(
                service_info, scopes=DRIVE_SCOPE
            )
        elif payload.get("type") == "service_account":
            _credentials_cache = service_account.Credentials.from_service_account_info(
                payload, scopes=DRIVE_SCOPE
            )
        elif payload.get("refresh_token"):
            _credentials_cache = Credentials.from_authorized_user_info(payload, scopes=DRIVE_SCOPE)
        else:
            raise ProviderContractError("Google credential payload is unsupported")
    if not _credentials_cache.valid:
        _credentials_cache.refresh(GoogleAuthRequest())
    token = getattr(_credentials_cache, "token", None)
    if not isinstance(token, str) or not token:
        raise ProviderContractError("Google access token is unavailable")
    return _credentials_cache


def _raw_backup_credentials():
    global _raw_backup_credentials_cache
    if _raw_backup_credentials_cache is None:
        payload = _credential_payload()
        service_info = payload.get("service_account") if isinstance(payload.get("service_account"), dict) else None
        if service_info is None and payload.get("type") == "service_account":
            service_info = payload
        if service_info is None:
            raise ProviderContractError("Google service account credential is unavailable")
        _raw_backup_credentials_cache = service_account.Credentials.from_service_account_info(
            service_info, scopes=RAW_BACKUP_SCOPE
        )
    if not _raw_backup_credentials_cache.valid:
        _raw_backup_credentials_cache.refresh(GoogleAuthRequest())
    token = getattr(_raw_backup_credentials_cache, "token", None)
    if not isinstance(token, str) or not token:
        raise ProviderContractError("Google access token is unavailable")
    return _raw_backup_credentials_cache


def _authorized_json(resource, parameters, credential_source="primary"):
    if resource not in {"about", "files"}:
        raise ProviderContractError("Google API resource is invalid")
    if credential_source == "primary":
        credentials = _credentials()
    elif credential_source == "raw_backup":
        credentials = _raw_backup_credentials()
    else:
        raise ProviderContractError("Google credential source is invalid")
    url = f"{DRIVE_API_BASE}/{resource}?{urlencode(parameters)}"
    request = UrlRequest(
        url,
        headers={"Authorization": f"Bearer {credentials.token}", "Accept": "application/json"},
        method="GET",
    )
    payload = None
    for attempt in range(MAX_PROVIDER_ATTEMPTS):
        try:
            with _provider_opener.open(request, timeout=10) as response:
                if getattr(response, "status", 200) != 200:
                    raise ProviderContractError("Google Drive response status is invalid")
                payload = response.read(MAX_PROVIDER_RESPONSE_BYTES + 1)
            break
        except HTTPError as error:
            if error.code not in {429, 500, 502, 503, 504} or attempt + 1 >= MAX_PROVIDER_ATTEMPTS:
                raise ProviderContractError("Google Drive request failed") from None
        except (TimeoutError, URLError, OSError):
            if attempt + 1 >= MAX_PROVIDER_ATTEMPTS:
                raise ProviderContractError("Google Drive request failed") from None
        except ProviderContractError:
            raise
        except Exception:
            raise ProviderContractError("Google Drive request failed") from None
        time.sleep(0.25 * (2 ** attempt))
    if payload is None:
        raise ProviderContractError("Google Drive request failed")
    if not 1 <= len(payload) <= MAX_PROVIDER_RESPONSE_BYTES:
        raise ProviderContractError("Google Drive response size is invalid")
    try:
        document = json.loads(payload)
    except (TypeError, ValueError, UnicodeDecodeError):
        raise ProviderContractError("Google Drive response is invalid") from None
    if not isinstance(document, dict):
        raise ProviderContractError("Google Drive response is invalid")
    return document


def _optional_bytes(value):
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        raise ProviderContractError("Google Drive byte value is invalid")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ProviderContractError("Google Drive byte value is invalid") from None
    if parsed < 0 or parsed > MAX_BYTE_VALUE:
        raise ProviderContractError("Google Drive byte value is invalid")
    return parsed


def _drive_literal(value):
    return str(value).replace("\\", "\\\\").replace("'", "\\'")


def _category_for_root_folder(name):
    normalized = name.strip().lower() if isinstance(name, str) else ""
    if normalized == "photos":
        return "photos"
    if normalized == "videos":
        return "videos"
    return "other"


def _category_for_media(mime_type):
    if mime_type.startswith("image/"):
        return "images"
    if mime_type.startswith("video/"):
        return "videos"
    return "other"


def _empty_category():
    return {"bytes": 0, "fileCount": 0}


def _scan_backup_folder(root_folder_id, category_names, credential_source, categorize_root_folders):
    if not isinstance(root_folder_id, str) or not DRIVE_ID_RE.fullmatch(root_folder_id):
        raise ProviderContractError("Google Drive destination is invalid")
    categories = {name: _empty_category() for name in category_names}
    stack = [(root_folder_id, "other", True)]
    seen_ids = {root_folder_id}
    item_count = 0
    folder_count = 0
    page_count = 0

    while stack:
        parent_id, parent_category, is_root = stack.pop()
        page_token = None
        seen_tokens = set()
        while True:
            page_count += 1
            if page_count > MAX_PROVIDER_PAGES:
                raise ProviderContractError("Google Drive pagination exceeded safe limit")
            parameters = {
                "q": f"'{_drive_literal(parent_id)}' in parents and trashed=false",
                "spaces": "drive",
                "pageSize": "1000",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
                "fields": (
                    "nextPageToken,files(id,name,mimeType,size,quotaBytesUsed)"
                    if categorize_root_folders
                    else "nextPageToken,files(id,mimeType,size,quotaBytesUsed)"
                ),
            }
            if page_token:
                parameters["pageToken"] = page_token
            document = _authorized_json("files", parameters, credential_source)
            items = document.get("files")
            if not isinstance(items, list):
                raise ProviderContractError("Google Drive file list is invalid")
            for item in items:
                if not isinstance(item, dict):
                    raise ProviderContractError("Google Drive file item is invalid")
                item_id = item.get("id")
                mime_type = item.get("mimeType")
                if not isinstance(item_id, str) or not DRIVE_ID_RE.fullmatch(item_id):
                    raise ProviderContractError("Google Drive file identifier is invalid")
                if item_id in seen_ids:
                    raise ProviderContractError("Google Drive file traversal repeated an item")
                seen_ids.add(item_id)
                if not isinstance(mime_type, str) or not 1 <= len(mime_type) <= 200:
                    raise ProviderContractError("Google Drive MIME type is invalid")
                item_count += 1
                if item_count > MAX_BACKUP_ITEMS:
                    raise ProviderContractError("Google Drive backup exceeded safe item limit")
                category = (
                    _category_for_root_folder(item.get("name"))
                    if categorize_root_folders and is_root
                    else parent_category
                )
                if mime_type == FOLDER_MIME_TYPE:
                    folder_count += 1
                    stack.append((item_id, category, False))
                    continue
                if not categorize_root_folders:
                    category = _category_for_media(mime_type)
                used_bytes = _optional_bytes(item.get("quotaBytesUsed"))
                if used_bytes is None:
                    used_bytes = _optional_bytes(item.get("size")) or 0
                categories[category]["bytes"] += used_bytes
                if categories[category]["bytes"] > MAX_BYTE_VALUE:
                    raise ProviderContractError("Google Drive backup byte total is invalid")
                categories[category]["fileCount"] += 1

            next_token = document.get("nextPageToken")
            if not next_token:
                break
            if (
                not isinstance(next_token, str)
                or not 1 <= len(next_token) <= 8192
                or next_token in seen_tokens
            ):
                raise ProviderContractError("Google Drive pagination is invalid")
            seen_tokens.add(next_token)
            page_token = next_token

    return {
        "totalBytes": sum(value["bytes"] for value in categories.values()),
        "fileCount": sum(value["fileCount"] for value in categories.values()),
        "folderCount": folder_count,
        "categories": categories,
    }


def _scan_website_backup(root_folder_id):
    return _scan_backup_folder(
        root_folder_id,
        ("photos", "videos", "other"),
        "primary",
        True,
    )


def _raw_photo_backup_folder_id():
    folder_id = _credential_payload().get("raw_photo_backup_folder_id")
    if not isinstance(folder_id, str) or not DRIVE_ID_RE.fullmatch(folder_id):
        raise ProviderContractError("Raw photo backup destination is invalid")
    return folder_id


def _scan_raw_photo_backup(root_folder_id):
    if not isinstance(root_folder_id, str) or not DRIVE_ID_RE.fullmatch(root_folder_id):
        raise ProviderContractError("Raw photo backup destination is invalid")

    # The raw archive contains many nested folders. Listing each folder would
    # require one request per directory, so take one paginated metadata-only
    # inventory and rebuild the shared subtree from parent relationships.
    children_by_parent = {}
    inventory_ids = set()
    root_is_folder = False
    page_token = None
    seen_tokens = set()
    page_count = 0
    item_count = 0
    while True:
        page_count += 1
        if page_count > MAX_PROVIDER_PAGES:
            raise ProviderContractError("Google Drive pagination exceeded safe limit")
        parameters = {
            "q": "trashed=false",
            "spaces": "drive",
            "pageSize": "1000",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
            "fields": "nextPageToken,files(id,parents,mimeType,size,quotaBytesUsed)",
        }
        if page_token:
            parameters["pageToken"] = page_token
        document = _authorized_json("files", parameters, "raw_backup")
        items = document.get("files")
        if not isinstance(items, list):
            raise ProviderContractError("Google Drive file list is invalid")
        for item in items:
            if not isinstance(item, dict):
                raise ProviderContractError("Google Drive file item is invalid")
            item_id = item.get("id")
            mime_type = item.get("mimeType")
            parents = item.get("parents", [])
            if not isinstance(item_id, str) or not DRIVE_ID_RE.fullmatch(item_id):
                raise ProviderContractError("Google Drive file identifier is invalid")
            if item_id in inventory_ids:
                raise ProviderContractError("Google Drive file traversal repeated an item")
            inventory_ids.add(item_id)
            if not isinstance(mime_type, str) or not 1 <= len(mime_type) <= 200:
                raise ProviderContractError("Google Drive MIME type is invalid")
            if not isinstance(parents, list) or len(parents) > 10 or not all(
                isinstance(parent, str) and DRIVE_ID_RE.fullmatch(parent) for parent in parents
            ):
                raise ProviderContractError("Google Drive parent list is invalid")
            item_count += 1
            if item_count > MAX_BACKUP_ITEMS:
                raise ProviderContractError("Google Drive backup exceeded safe item limit")
            if item_id == root_folder_id:
                root_is_folder = mime_type == FOLDER_MIME_TYPE
            used_bytes = _optional_bytes(item.get("quotaBytesUsed"))
            if used_bytes is None:
                used_bytes = _optional_bytes(item.get("size")) or 0
            for parent in parents:
                children_by_parent.setdefault(parent, []).append((item_id, mime_type, used_bytes))

        next_token = document.get("nextPageToken")
        if not next_token:
            break
        if (
            not isinstance(next_token, str)
            or not 1 <= len(next_token) <= 8192
            or next_token in seen_tokens
        ):
            raise ProviderContractError("Google Drive pagination is invalid")
        seen_tokens.add(next_token)
        page_token = next_token

    if not root_is_folder:
        raise ProviderContractError("Raw photo backup destination is unavailable")

    categories = {"images": _empty_category(), "videos": _empty_category(), "other": _empty_category()}
    stack = [root_folder_id]
    seen_descendants = {root_folder_id}
    folder_count = 0
    while stack:
        parent_id = stack.pop()
        for item_id, mime_type, used_bytes in children_by_parent.get(parent_id, []):
            if item_id in seen_descendants:
                raise ProviderContractError("Google Drive file traversal repeated an item")
            seen_descendants.add(item_id)
            if mime_type == FOLDER_MIME_TYPE:
                folder_count += 1
                stack.append(item_id)
                continue
            category = _category_for_media(mime_type)
            categories[category]["bytes"] += used_bytes
            if categories[category]["bytes"] > MAX_BYTE_VALUE:
                raise ProviderContractError("Google Drive backup byte total is invalid")
            categories[category]["fileCount"] += 1

    return {
        "totalBytes": sum(value["bytes"] for value in categories.values()),
        "fileCount": sum(value["fileCount"] for value in categories.values()),
        "folderCount": folder_count,
        "categories": categories,
    }


def _build_report(today):
    about = _authorized_json(
        "about",
        {"fields": "storageQuota(limit,usage,usageInDrive,usageInDriveTrash),maxUploadSize"},
    )
    quota = about.get("storageQuota")
    if quota is None:
        quota = {}
    if not isinstance(quota, dict):
        raise ProviderContractError("Google Drive quota response is invalid")
    limit = _optional_bytes(quota.get("limit"))
    usage = _optional_bytes(quota.get("usage"))
    drive_usage = _optional_bytes(quota.get("usageInDrive"))
    trash_usage = _optional_bytes(quota.get("usageInDriveTrash"))
    maximum_upload = _optional_bytes(about.get("maxUploadSize"))
    remaining = max(limit - usage, 0) if limit is not None and usage is not None else None
    percent = round(min(100, usage / limit * 100), 2) if limit and usage is not None else None
    other_google = max(usage - drive_usage, 0) if usage is not None and drive_usage is not None else None
    website_backup = _scan_website_backup(os.environ.get("GOOGLE_DRIVE_FOLDER_ID", "").strip())
    raw_photo_backup = _scan_raw_photo_backup(_raw_photo_backup_folder_id())
    return {
        "schemaVersion": CACHE_SCHEMA_VERSION,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "quotaAvailable": any(value is not None for value in (limit, usage, drive_usage, trash_usage)),
        "limitBytes": limit,
        "usageBytes": usage,
        "driveBytes": drive_usage,
        "trashBytes": trash_usage,
        "otherGoogleBytes": other_google,
        "remainingBytes": remaining,
        "percentUsed": percent,
        "maxUploadBytes": maximum_upload,
        "websiteBackup": website_backup,
        "rawPhotoBackup": raw_photo_backup,
    }


def _valid_backup_aggregate(backup, expected_categories):
    if not isinstance(backup, dict) or set(backup) != {"totalBytes", "fileCount", "folderCount", "categories"}:
        return False
    for key in ("totalBytes", "fileCount", "folderCount"):
        value = backup.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_BYTE_VALUE:
            return False
    categories = backup.get("categories")
    if not isinstance(categories, dict) or set(categories) != set(expected_categories):
        return False
    if not all(
        isinstance(value, dict)
        and set(value) == {"bytes", "fileCount"}
        and all(
            isinstance(value[field], int)
            and not isinstance(value[field], bool)
            and 0 <= value[field] <= MAX_BYTE_VALUE
            for field in ("bytes", "fileCount")
        )
        for value in categories.values()
    ):
        return False
    return (
        backup["totalBytes"] == sum(value["bytes"] for value in categories.values())
        and backup["fileCount"] == sum(value["fileCount"] for value in categories.values())
    )


def _valid_cached_report(report):
    if not isinstance(report, dict) or report.get("schemaVersion") != CACHE_SCHEMA_VERSION:
        return False
    if not isinstance(report.get("generatedAt"), str) or not 1 <= len(report["generatedAt"]) <= 64:
        return False
    if not isinstance(report.get("quotaAvailable"), bool):
        return False
    for key in (
        "limitBytes", "usageBytes", "driveBytes", "trashBytes", "otherGoogleBytes",
        "remainingBytes", "maxUploadBytes",
    ):
        value = report.get(key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_BYTE_VALUE):
            return False
    percent = report.get("percentUsed")
    if percent is not None and (isinstance(percent, bool) or not isinstance(percent, (int, float)) or not 0 <= percent <= 100):
        return False
    return (
        _valid_backup_aggregate(report.get("websiteBackup"), ("photos", "videos", "other"))
        and _valid_backup_aggregate(report.get("rawPhotoBackup"), ("images", "videos", "other"))
    )


def _cached_item():
    response = cache_table.get_item(Key={"cacheKey": CACHE_KEY}, ConsistentRead=True)
    item = response.get("Item")
    if not isinstance(item, dict):
        return None, None
    payload = item.get("payload")
    if not isinstance(payload, str) or not 1 <= len(payload.encode("utf-8")) <= MAX_CACHE_PAYLOAD_BYTES:
        return None, item
    try:
        report = json.loads(payload)
    except (TypeError, ValueError):
        return None, item
    return (report if _valid_cached_report(report) else None), item


def _claim_daily_refresh(today):
    try:
        cache_table.update_item(
            Key={"cacheKey": CACHE_KEY},
            UpdateExpression="SET lastAttemptDate = :today",
            ConditionExpression="attribute_not_exists(lastAttemptDate) OR lastAttemptDate <> :today",
            ExpressionAttributeValues={":today": today.isoformat()},
        )
        return True
    except Exception as error:
        code = str(getattr(error, "response", {}).get("Error", {}).get("Code", ""))
        if code == "ConditionalCheckFailedException":
            return False
        raise


def _release_daily_refresh(today):
    try:
        cache_table.update_item(
            Key={"cacheKey": CACHE_KEY},
            UpdateExpression="REMOVE lastAttemptDate",
            ConditionExpression="lastAttemptDate = :today",
            ExpressionAttributeValues={":today": today.isoformat()},
        )
    except Exception as error:
        code = str(getattr(error, "response", {}).get("Error", {}).get("Code", ""))
        if code != "ConditionalCheckFailedException":
            raise


def _store_report(today, report):
    payload = json.dumps(report, separators=(",", ":"), sort_keys=True)
    if len(payload.encode("utf-8")) > MAX_CACHE_PAYLOAD_BYTES:
        raise ValueError("Google Drive usage cache payload exceeded safe limit")
    cache_table.put_item(
        Item={
            "cacheKey": CACHE_KEY,
            "schemaVersion": CACHE_SCHEMA_VERSION,
            "cacheDate": today.isoformat(),
            "lastAttemptDate": today.isoformat(),
            "payload": payload,
        }
    )


def _with_cache_status(report, status, today):
    result = copy.deepcopy(report)
    result["cacheStatus"] = status
    result["nextRefreshAt"] = dt.datetime.combine(
        today + dt.timedelta(days=1),
        dt.time(SCHEDULED_REFRESH_HOUR_UTC, SCHEDULED_REFRESH_MINUTE_UTC),
        tzinfo=dt.timezone.utc,
    ).isoformat().replace("+00:00", "Z")
    return result


def _audit_view(event, context, status):
    actor_type, auth_method = actor_context(event)
    emit_audit_event(
        event_name="provider.drive_usage",
        outcome="success",
        action="provider.drive_usage.view",
        resource_type="provider",
        reason_code=f"{status}_report",
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        severity="warning" if status == "stale" else "info",
    )


def _is_scheduled_refresh(event):
    return isinstance(event, dict) and event == SCHEDULED_REFRESH_EVENT


def _scheduled_refresh(context):
    today = _utc_today()
    cached, item = _cached_item()
    if cached is not None and item.get("cacheDate") == today.isoformat():
        return {"refreshed": False, "status": "fresh"}
    if not _claim_daily_refresh(today):
        return {"refreshed": False, "status": "already_claimed"}
    try:
        report = _build_report(today)
        _store_report(today, report)
        request_id = getattr(context, "aws_request_id", "unknown") if context else "unknown"
        logger.info("drive_usage_scheduled_refresh_succeeded request_id=%s", request_id)
        return {"refreshed": True, "status": "fresh"}
    except Exception as error:
        request_id = getattr(context, "aws_request_id", "unknown") if context else "unknown"
        logger.error(
            "drive_usage_scheduled_refresh_failed request_id=%s error_type=%s",
            request_id,
            type(error).__name__,
        )
        try:
            _release_daily_refresh(today)
        except Exception as release_error:
            logger.error(
                "drive_usage_refresh_claim_release_failed request_id=%s error_type=%s",
                request_id,
                type(release_error).__name__,
            )
        raise RuntimeError("Google Drive usage scheduled refresh failed") from None


def refresh_handler(event, context):
    if not _is_scheduled_refresh(event):
        raise ValueError("Google Drive usage refresh event is invalid")
    return _scheduled_refresh(context)


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied

    today = _utc_today()
    try:
        cached, item = _cached_item()
        if cached is not None and item.get("cacheDate") == today.isoformat():
            _audit_view(event, context, "fresh")
            return json_response(200, _with_cache_status(cached, "fresh", today))

        if cached is not None:
            _audit_view(event, context, "stale")
            return json_response(200, _with_cache_status(cached, "stale", today))
        return error_response(
            503,
            "The daily Google Drive usage report is being prepared. Please try again shortly.",
            code="drive_usage_preparing",
        )
    except Exception as error:
        request_id = getattr(context, "aws_request_id", "unknown") if context else "unknown"
        logger.error(
            "drive_usage_cache_failed request_id=%s error_type=%s",
            request_id,
            type(error).__name__,
        )
        return error_response(
            503,
            "The daily Google Drive usage report is temporarily unavailable.",
            code="drive_usage_unavailable",
        )
