"""A GET-only Google Drive reader dedicated to the camera-original archive.

The existing service account may have broad Drive permissions; this client
deliberately mints only drive.readonly tokens. It has no upload, update, trash,
delete, permission, or shortcut-following operation. OAuth writer credentials
in the same SSM parameter are never used.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

import boto3
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account


READ_ONLY_SCOPES = ("https://www.googleapis.com/auth/drive.readonly",)
DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"
SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut"
MAX_JSON_BYTES = 3_000_000
MAX_FILES = 250_000
MAX_PAGES = 1000
MAX_ATTEMPTS = 3
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
_ID = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
_MD5 = re.compile(r"^[a-fA-F0-9]{32}$")
_FIELDS = "id,name,parents,mimeType,md5Checksum,size,modifiedTime,version,trashed,imageMediaMetadata(cameraModel,time),capabilities(canDownload)"


class OriginalDriveError(ValueError):
    """Sanitized provider/configuration failure safe for operational reporting."""


class DriveCursorExpired(OriginalDriveError):
    """The saved change cursor expired; rebuild the full inventory."""


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, _request, _file_pointer, _code, _message, _headers, _new_url):
        return None


def _id(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise OriginalDriveError("Drive file identifier is invalid")
    return value


def _token(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 4096 or any(ord(c) < 32 for c in value):
        raise OriginalDriveError("Drive page token is invalid")
    return value


def _string(value, maximum):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or "\x00" in value:
        raise OriginalDriveError("Drive metadata is invalid")
    return value


def _integer(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)) or not re.fullmatch(r"[0-9]{1,19}", str(value)):
        raise OriginalDriveError("Drive numeric metadata is invalid")
    parsed = int(value)
    if parsed > 9_223_372_036_854_775_807:
        raise OriginalDriveError("Drive numeric metadata is invalid")
    return str(parsed)


def _file_metadata(document):
    if not isinstance(document, dict):
        raise OriginalDriveError("Drive file metadata is invalid")
    result = {
        "id": _id(document.get("id")),
        "name": _string(document.get("name"), 4096),
        "mimeType": _string(document.get("mimeType"), 256),
    }
    parents = document.get("parents", [])
    if not isinstance(parents, list) or len(parents) > 1:
        raise OriginalDriveError("Drive parent metadata is invalid")
    result["parents"] = [_id(parent) for parent in parents]
    for field in ("size", "version"):
        if field in document:
            result[field] = _integer(document[field])
    if "md5Checksum" in document:
        checksum = document["md5Checksum"]
        if not isinstance(checksum, str) or not _MD5.fullmatch(checksum):
            raise OriginalDriveError("Drive checksum metadata is invalid")
        result["md5Checksum"] = checksum.lower()
    if "modifiedTime" in document:
        result["modifiedTime"] = _string(document["modifiedTime"], 64)
    if "trashed" in document:
        if not isinstance(document["trashed"], bool):
            raise OriginalDriveError("Drive trash metadata is invalid")
        result["trashed"] = document["trashed"]
    if "imageMediaMetadata" in document:
        metadata = document["imageMediaMetadata"]
        if not isinstance(metadata, dict):
            raise OriginalDriveError("Drive image metadata is invalid")
        result["imageMediaMetadata"] = {
            key: _string(metadata[key], 256 if key == "cameraModel" else 64)
            for key in ("cameraModel", "time") if key in metadata
        }
    if "capabilities" in document:
        capabilities = document["capabilities"]
        if not isinstance(capabilities, dict):
            raise OriginalDriveError("Drive capability metadata is invalid")
        if "canDownload" in capabilities:
            if not isinstance(capabilities["canDownload"], bool):
                raise OriginalDriveError("Drive capability metadata is invalid")
            result["capabilities"] = {"canDownload": capabilities["canDownload"]}
    return result


def project_archive(files, root_id):
    """Project a complete inventory onto JPGs under the exact configured root.

    Outside files and shortcuts never become candidates. A root record is
    mandatory, duplicate IDs/cycles are rejected, and every in-scope ancestor
    must be a real, untrashed folder. Unreachable shared items can legitimately
    have inaccessible parents and are excluded rather than guessed into scope.
    """
    root_id = _id(root_id)
    if not isinstance(files, list) or len(files) > MAX_FILES:
        raise OriginalDriveError("Drive inventory is invalid")
    by_id = {}
    for document in files:
        item = _file_metadata(document)
        if item["id"] in by_id:
            raise OriginalDriveError("Drive inventory contains duplicate identifiers")
        by_id[item["id"]] = item
    root = by_id.get(root_id)
    if not root or root["mimeType"] != FOLDER_MIME_TYPE or root.get("trashed"):
        raise OriginalDriveError("Drive archive root is unavailable")
    resolved = {root_id: True}
    for file_id in by_id:
        path = []
        visiting = set()
        current = file_id
        while current not in resolved:
            if current in visiting:
                raise OriginalDriveError("Drive inventory contains an ancestry cycle")
            visiting.add(current)
            path.append(current)
            item = by_id.get(current)
            if not item or item.get("trashed") or item["mimeType"] == SHORTCUT_MIME_TYPE:
                resolved[current] = False
                break
            parents = item["parents"]
            if not parents:
                resolved[current] = False
                break
            parent = by_id.get(parents[0])
            if parent and parent["mimeType"] != FOLDER_MIME_TYPE:
                raise OriginalDriveError("Drive inventory parent is not a folder")
            current = parents[0]
        inside = resolved[current]
        for ancestor in path:
            resolved[ancestor] = inside
    return [item for file_id, item in by_id.items() if file_id != root_id and resolved[file_id] and item["mimeType"] == "image/jpeg"]


class OriginalDrive:
    def __init__(self, credentials, root_id, *, opener=None):
        self.root_id = _id(root_id)
        self._credentials = credentials
        self._opener = opener if opener is not None else build_opener(_NoRedirectHandler)

    @classmethod
    def from_environment(cls):
        parameter = os.environ.get("GOOGLE_OAUTH_PARAMETER", "").strip()
        if not parameter:
            raise OriginalDriveError("Drive credential parameter is unavailable")
        try:
            raw = boto3.client("ssm").get_parameter(Name=parameter, WithDecryption=True)["Parameter"]["Value"]
            if not isinstance(raw, str) or not 2 <= len(raw) <= 64_000:
                raise ValueError
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError
            info = payload.get("service_account")
            if not isinstance(info, dict) or info.get("type") != "service_account":
                raise ValueError
            if info.get("token_uri") != "https://oauth2.googleapis.com/token":
                raise ValueError
            root_id = _id(payload.get("raw_photo_backup_folder_id"))
            credentials = service_account.Credentials.from_service_account_info(info, scopes=READ_ONLY_SCOPES)
        except Exception:
            raise OriginalDriveError("Drive read-only service account configuration is unavailable") from None
        return cls(credentials, root_id)

    def _get(self, resource, parameters, maximum_bytes=MAX_JSON_BYTES):
        if resource not in {"files", "changes", "changes/startPageToken"} and not re.fullmatch(r"files/[A-Za-z0-9_-]{1,256}", resource):
            raise OriginalDriveError("Drive read resource is invalid")
        try:
            if not self._credentials.valid:
                self._credentials.refresh(GoogleAuthRequest())
            token = self._credentials.token
            if not isinstance(token, str) or not token or any(c in token for c in "\r\n"):
                raise ValueError
        except Exception:
            raise OriginalDriveError("Drive read-only authorization failed") from None
        request = Request(
            f"{DRIVE_API_BASE}/{resource}?{urlencode(parameters)}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/octet-stream" if parameters.get("alt") == "media" else "application/json"},
            method="GET",
        )
        for attempt in range(MAX_ATTEMPTS):
            try:
                with self._opener.open(request, timeout=30) as response:
                    if response.status != 200:
                        raise OriginalDriveError("Drive read response status is invalid")
                    body = response.read(maximum_bytes + 1)
                if not isinstance(body, bytes) or not 1 <= len(body) <= maximum_bytes:
                    raise OriginalDriveError("Drive read response exceeds the permitted size")
                return body
            except HTTPError as error:
                code = error.code
                error.close()
                if code == 410 and resource == "changes":
                    raise DriveCursorExpired("Drive change cursor has expired") from None
                if code not in {429, 500, 502, 503, 504} or attempt + 1 == MAX_ATTEMPTS:
                    raise OriginalDriveError("Drive read request failed") from None
            except (TimeoutError, URLError, OSError):
                if attempt + 1 == MAX_ATTEMPTS:
                    raise OriginalDriveError("Drive read request failed") from None
            except OriginalDriveError:
                raise
            except Exception:
                raise OriginalDriveError("Drive read request failed") from None
            time.sleep(0.25 * 2 ** attempt)
        raise OriginalDriveError("Drive read request failed")

    def _json(self, resource, parameters):
        try:
            document = json.loads(self._get(resource, parameters))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise OriginalDriveError("Drive JSON response is invalid") from None
        if not isinstance(document, dict):
            raise OriginalDriveError("Drive JSON response is invalid")
        return document

    def file(self, file_id):
        file_id = _id(file_id)
        item = _file_metadata(self._json(f"files/{file_id}", {"supportsAllDrives": "true", "fields": _FIELDS}))
        if item["id"] != file_id:
            raise OriginalDriveError("Drive file response identifier does not match")
        return item

    def list_inventory(self):
        files = []
        seen_ids = set()
        seen_tokens = set()
        token = None
        for _ in range(MAX_PAGES):
            parameters = {
                "q": "trashed=false", "spaces": "drive", "pageSize": 1000,
                "supportsAllDrives": "true", "includeItemsFromAllDrives": "true",
                "fields": f"nextPageToken,incompleteSearch,files({_FIELDS})",
            }
            if token:
                parameters["pageToken"] = token
            document = self._json("files", parameters)
            if document.get("incompleteSearch", False) is not False:
                raise OriginalDriveError("Drive inventory search is incomplete")
            page = document.get("files")
            if not isinstance(page, list) or len(page) > 1000:
                raise OriginalDriveError("Drive inventory page is invalid")
            for value in page:
                item = _file_metadata(value)
                if item["id"] in seen_ids or item.get("trashed"):
                    raise OriginalDriveError("Drive inventory changed during scan")
                seen_ids.add(item["id"])
                files.append(item)
            if len(files) > MAX_FILES:
                raise OriginalDriveError("Drive inventory exceeds the permitted size")
            if "nextPageToken" not in document:
                if self.root_id not in seen_ids:
                    files.append(self.file(self.root_id))
                project_archive(files, self.root_id)
                return files
            token = _token(document["nextPageToken"])
            if token in seen_tokens:
                raise OriginalDriveError("Drive inventory pagination repeated")
            seen_tokens.add(token)
        raise OriginalDriveError("Drive inventory pagination exceeds the permitted size")

    def download(self, file_id, maximum_bytes, expected_md5=None):
        if isinstance(maximum_bytes, bool) or not isinstance(maximum_bytes, int) or not 1 <= maximum_bytes <= MAX_DOWNLOAD_BYTES:
            raise OriginalDriveError("Drive download limit is invalid")
        if expected_md5 is not None and (not isinstance(expected_md5, str) or not _MD5.fullmatch(expected_md5)):
            raise OriginalDriveError("Drive expected checksum is invalid")
        item = self.file(file_id)
        if item["mimeType"] != "image/jpeg" or item.get("trashed") or item.get("capabilities", {}).get("canDownload") is not True:
            raise OriginalDriveError("Drive original is not downloadable")
        if "size" not in item or not 1 <= int(item["size"]) <= maximum_bytes:
            raise OriginalDriveError("Drive original exceeds the permitted size")
        checksum = item.get("md5Checksum")
        if not checksum or (expected_md5 and expected_md5.lower() != checksum):
            raise OriginalDriveError("Drive original checksum changed")
        current = item
        visited = {file_id}
        for _ in range(128):
            parents = current["parents"]
            if len(parents) != 1 or parents[0] in visited:
                raise OriginalDriveError("Drive original is outside the configured archive")
            parent_id = parents[0]
            visited.add(parent_id)
            current = self.file(parent_id)
            if current["mimeType"] != FOLDER_MIME_TYPE or current.get("trashed"):
                raise OriginalDriveError("Drive original ancestry is invalid")
            if parent_id == self.root_id:
                break
        else:
            raise OriginalDriveError("Drive original ancestry exceeds the permitted depth")
        body = self._get(f"files/{_id(file_id)}", {"alt": "media", "supportsAllDrives": "true"}, maximum_bytes)
        if len(body) != int(item["size"]) or hashlib.md5(body, usedforsecurity=False).hexdigest() != checksum:
            raise OriginalDriveError("Drive downloaded original failed integrity verification")
        return body

    def start_page_token(self):
        return _token(self._json("changes/startPageToken", {"supportsAllDrives": "true", "fields": "startPageToken"}).get("startPageToken"))

    def changes(self, page_token):
        token = _token(page_token)
        seen_tokens = {token}
        changes = []
        for _ in range(MAX_PAGES):
            document = self._json("changes", {
                "pageToken": token, "pageSize": 1000, "spaces": "drive", "includeRemoved": "true",
                "supportsAllDrives": "true", "includeItemsFromAllDrives": "true",
                "fields": f"nextPageToken,newStartPageToken,changes(fileId,removed,file({_FIELDS}))",
            })
            page = document.get("changes")
            if not isinstance(page, list) or len(page) > 1000:
                raise OriginalDriveError("Drive changes page is invalid")
            for entry in page:
                if not isinstance(entry, dict):
                    raise OriginalDriveError("Drive change is invalid")
                file_id = _id(entry.get("fileId"))
                removed = entry.get("removed", False)
                if not isinstance(removed, bool):
                    raise OriginalDriveError("Drive removal metadata is invalid")
                change = {"fileId": file_id, "removed": removed}
                if not removed:
                    item = _file_metadata(entry.get("file"))
                    if item["id"] != file_id:
                        raise OriginalDriveError("Drive changed file identifier does not match")
                    change["file"] = item
                changes.append(change)
            if len(changes) > MAX_FILES:
                raise OriginalDriveError("Drive changes exceed the permitted size")
            if "nextPageToken" not in document:
                return changes, _token(document.get("newStartPageToken"))
            token = _token(document["nextPageToken"])
            if token in seen_tokens:
                raise OriginalDriveError("Drive changes pagination repeated")
            seen_tokens.add(token)
        raise OriginalDriveError("Drive changes pagination exceeds the permitted size")
