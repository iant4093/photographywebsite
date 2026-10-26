"""Admin-only, read-only browser for the camera raw photo backup in Google Drive.

Folder listings are read live from Drive with drive.readonly credentials. Album
folders (those holding a JPEG subfolder) show only their camera JPGs; the RAW
and video subfolders are hidden. Photos are returned with Google's short-lived
thumbnail base URL so the browser loads resized images directly from Google.
"""

from __future__ import annotations

import logging
import re
import time
from urllib.parse import urlsplit

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import require_admin
from front_door import verify_front_door_request
from original_drive import DriveItemNotFound, FOLDER_MIME_TYPE, OriginalDrive
from response_helpers import error_response, json_response


logger = logging.getLogger("photography_api.raw_photos")
logger.setLevel(logging.INFO)

FOLDER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
THUMBNAIL_HOST_RE = re.compile(r"^lh[3-6]\.googleusercontent\.com$")
THUMBNAIL_SIZE_SUFFIX_RE = re.compile(r"=[A-Za-z0-9-]{1,32}$")
JPEG_FOLDER_NAMES = frozenset({"jpeg", "jpg", "jpegs", "jpgs"})
HIDDEN_ALBUM_FOLDER_NAMES = JPEG_FOLDER_NAMES | frozenset({"raw", "raws", "vid", "vids", "video", "videos"})
RAW_EXTENSIONS = frozenset({"cr2", "cr3", "crw", "arw", "nef", "nrw", "raf", "rw2", "orf", "dng", "pef", "srw"})
JPEG_EXTENSIONS = frozenset({"jpg", "jpeg"})
PATH_CACHE_SECONDS = 600
PATH_CACHE_LIMIT = 2000

_drive = None
_path_cache = {}


def _client():
    global _drive
    if _drive is None:
        _drive = OriginalDrive.from_environment()
    return _drive


def _known_paths(now):
    expired = [folder_id for folder_id, (expires, _) in _path_cache.items() if expires <= now]
    for folder_id in expired:
        _path_cache.pop(folder_id, None)
    return {folder_id: path for folder_id, (_, path) in _path_cache.items()}


def _remember_path(folder_id, path, now):
    if len(_path_cache) >= PATH_CACHE_LIMIT:
        _path_cache.clear()
    _path_cache[folder_id] = (now + PATH_CACHE_SECONDS, path)


def _extension(name):
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _stem(name):
    return name.rsplit(".", 1)[0].lower() if "." in name else name.lower()


def _thumbnail_base(link):
    """Return a normalized lh3 thumbnail base without its size suffix, or None."""
    if not isinstance(link, str) or not 1 <= len(link) <= 2048 or re.search(r"[\s,\"'<>\\]", link):
        return None
    try:
        parts = urlsplit(link)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != "https" or not THUMBNAIL_HOST_RE.fullmatch(parts.hostname or "") or port or parts.query or parts.fragment:
        return None
    if parts.username or parts.password or not parts.path.startswith("/"):
        return None
    path = THUMBNAIL_SIZE_SUFFIX_RE.sub("", parts.path)
    if len(path) < 2:
        return None
    return f"https://lh3.googleusercontent.com{path}"


def _dimension(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100_000:
        return None
    return value


def _photo(item):
    thumbnail = _thumbnail_base(item.get("thumbnailLink"))
    if thumbnail is None:
        return None
    metadata = item.get("imageMediaMetadata") if isinstance(item.get("imageMediaMetadata"), dict) else {}
    photo = {"id": item["id"], "name": item["name"][:255], "thumbnail": thumbnail}
    width, height = _dimension(metadata.get("width")), _dimension(metadata.get("height"))
    if width and height:
        # Drive reports sensor dimensions; its thumbnails are already rotated.
        if metadata.get("rotation") in (1, 3):
            width, height = height, width
        photo["width"], photo["height"] = width, height
    captured = metadata.get("time")
    if isinstance(captured, str) and re.fullmatch(r"\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}", captured):
        photo["capturedAt"] = captured
    return photo


def _is_photo(item):
    if item["mimeType"] == FOLDER_MIME_TYPE or item["mimeType"].startswith("video/"):
        return False
    return item["mimeType"].startswith("image/") or _extension(item["name"]) in RAW_EXTENSIONS


def _photos(items):
    """Photos in Drive order; a RAW file is skipped when its JPG is present."""
    candidates = [item for item in items if _is_photo(item)]
    jpeg_stems = {_stem(item["name"]) for item in candidates if _extension(item["name"]) in JPEG_EXTENSIONS}
    photos = []
    for item in candidates:
        if _extension(item["name"]) in RAW_EXTENSIONS and _stem(item["name"]) in jpeg_stems:
            continue
        photo = _photo(item)
        if photo:
            photos.append(photo)
    return photos


def _folder_id(event):
    params = (event or {}).get("queryStringParameters") or {}
    value = params.get("folder")
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not FOLDER_ID_RE.fullmatch(value):
        raise ValueError("folder")
    return value


def browse(drive, folder_id, now):
    folder_id = folder_id or drive.root_id
    path = drive.folder_path(folder_id, _known_paths(now))
    _remember_path(folder_id, path, now)
    items, truncated = drive.list_folder(folder_id)
    subfolders = [item for item in items if item["mimeType"] == FOLDER_MIME_TYPE]
    jpeg_folder = next((item for item in subfolders if item["name"].strip().lower() in JPEG_FOLDER_NAMES), None)
    photos = _photos(items)
    album = False
    if jpeg_folder is not None:
        jpeg_items, jpeg_truncated = drive.list_folder(jpeg_folder["id"])
        jpeg_photos = _photos(jpeg_items)
        # An empty JPEG folder is not an album; keep every subfolder reachable.
        if jpeg_photos:
            album = True
            truncated = truncated or jpeg_truncated
            photos = [*jpeg_photos, *photos]
            subfolders = [item for item in subfolders if item["name"].strip().lower() not in HIDDEN_ALBUM_FOLDER_NAMES]
    for item in subfolders:
        _remember_path(item["id"], [*path, {"id": item["id"], "name": item["name"]}], now)
    return {
        "folder": path[-1],
        "path": path,
        "isRoot": folder_id == drive.root_id,
        "album": album,
        "folders": [{"id": item["id"], "name": item["name"]} for item in subfolders],
        "photos": photos,
        "truncated": truncated,
    }


def _audit_view(event, context, outcome, photo_count=0):
    actor_type, auth_method = actor_context(event)
    emit_audit_event(
        event_name="provider.raw_photos",
        outcome=outcome,
        action="provider.raw_photos.view",
        resource_type="provider",
        reason_code="folder_listed" if outcome == "success" else "provider_unavailable",
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        severity="info" if outcome == "success" else "warning",
        details={"media_count": photo_count},
    )


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied
    try:
        folder_id = _folder_id(event)
    except ValueError:
        return error_response(400, "The folder identifier is invalid.", code="invalid_folder")
    try:
        result = browse(_client(), folder_id, time.monotonic())
    except DriveItemNotFound:
        return error_response(404, "That folder is not in the raw photo backup.", code="folder_not_found")
    except Exception as error:  # Provider details stay out of responses and logs.
        request_id = getattr(context, "aws_request_id", "unknown") if context else "unknown"
        logger.error("raw_photos_provider_failed request_id=%s error_type=%s", request_id, type(error).__name__)
        _audit_view(event, context, "failure")
        return error_response(503, "The raw photo backup is temporarily unavailable.", code="raw_photos_unavailable")
    _audit_view(event, context, "success", len(result["photos"]))
    return json_response(200, result)
