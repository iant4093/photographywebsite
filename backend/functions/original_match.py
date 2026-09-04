"""Conservative, offline matching of edited photos to camera-original JPGs.

Camera numbers roll over. A filename is only a candidate lookup: an original
must also have the same capture second and camera model. These helpers never
access Drive or infer a match from a similar name, date, or image appearance.
"""

from __future__ import annotations

import datetime as dt
import html
import io
import re
from collections import defaultdict

import exifread

from original_drive import project_archive  # Shared pure ancestry contract for the coordinator.


MAX_HEADER_BYTES = 1_048_576
MAX_FILENAMES = 16
_DATE_PREFIX = re.compile(r"^\d{8}[-_]")
_CAPTURE_TIME = re.compile(r"^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})?$")
_XMP_FIELDS = ((b"crs", b"RawFileName"), (b"xmpMM", b"PreservedFileName"))
_SOURCE_FIELDS = (
    "id", "name", "parents", "mimeType", "md5Checksum", "size", "modifiedTime", "version",
    "imageMediaMetadata",
)


def _text(value, limit=256):
    if not isinstance(value, str):
        return ""
    value = value.strip().strip("\x00")
    return value if 0 < len(value) <= limit and not any(ord(c) < 32 for c in value) else ""


def filename_stems(name):
    """Return the exact filename stem plus the known dated-export variant."""
    name = _text(name, 1024).replace("\\", "/").rsplit("/", 1)[-1]
    if not name or name in {".", ".."}:
        return []
    stem = name.rsplit(".", 1)[0] if "." in name else name
    stem = _text(stem).casefold()
    if not stem:
        return []
    stems = [stem]
    if _DATE_PREFIX.match(stem):
        try:
            dt.datetime.strptime(stem[:8], "%Y%m%d")
        except ValueError:
            pass
        else:
            if stem[9:]:
                stems.append(stem[9:])
    return stems


def _capture(value):
    """Normalize camera wall time; do not convert it to an assumed timezone."""
    match = _CAPTURE_TIME.fullmatch(_text(value, 64))
    if not match:
        return "", ""
    try:
        timestamp = dt.datetime(*[int(part) for part in match.groups()[:6]])
    except ValueError:
        return "", ""
    return timestamp.strftime("%Y:%m:%d %H:%M:%S"), _subsecond(match.group(7))


def _subsecond(value):
    value = _text(value, 9)
    return (value.rstrip("0") or "0") if value and value.isascii() and value.isdigit() else ""


def extract_evidence(image_header: bytes, original_filename=""):
    """Extract only matching evidence from a bounded JPEG header.

    A truncated or malformed EXIF block is treated as missing evidence, never
    as permission to fall back to filename-only matching. XMP supports both
    attribute and element representations used by Lightroom exports.
    """
    header = image_header[:MAX_HEADER_BYTES] if isinstance(image_header, bytes) else b""
    filenames = []
    for prefix, field in _XMP_FIELDS:
        qualified = prefix + b":" + field
        patterns = (
            rb"(?<![\w:])" + qualified + rb"\s*=\s*[\"']([^\"'<>]{1,1024})[\"']",
            rb"<" + qualified + rb"(?:\s[^<>]{0,256})?>\s*([^<>]{1,1024})\s*</" + qualified + rb"\s*>",
        )
        for pattern in patterns:
            for raw in re.findall(pattern, header):
                try:
                    name = html.unescape(raw.decode("utf-8"))
                except UnicodeDecodeError:
                    continue
                filenames.extend(filename_stems(name))
    filenames.extend(filename_stems(original_filename))
    result = {"filenames": list(dict.fromkeys(filenames))[:MAX_FILENAMES], "captureTime": "", "cameraModel": ""}
    try:
        tags = exifread.process_file(io.BytesIO(header), details=False, strict=False)
        result["captureTime"], fraction = _capture(str(tags.get("EXIF DateTimeOriginal", "")))
        result["cameraModel"] = _text(str(tags.get("Image Model", "")))
        subsecond = _subsecond(str(tags.get("EXIF SubSecTimeOriginal", ""))) or fraction
        if subsecond:
            result["subsecond"] = subsecond
    except Exception:
        # EXIF is untrusted input. No filenames, metadata, or library error text
        # are logged; the worker can safely retry or mark this photo unavailable.
        result["captureTime"] = ""
        result["cameraModel"] = ""
    return result


def build_match_index(candidates):
    """Index only JPGs with complete matching evidence; preserve conflicts."""
    index = defaultdict(list)
    for source in candidates:
        if not isinstance(source, dict) or source.get("mimeType") != "image/jpeg":
            continue
        if not _text(source.get("id")) or source.get("trashed"):
            continue
        metadata = source.get("imageMediaMetadata", {})
        if not isinstance(metadata, dict):
            continue
        capture, _ = _capture(metadata.get("time"))
        model = _text(metadata.get("cameraModel"))
        if not capture or not model:
            continue
        for stem in filename_stems(source.get("name")):
            index[(stem, capture, model)].append({key: source[key] for key in _SOURCE_FIELDS if key in source})
    return dict(index)


def match_original(evidence, index):
    """Choose a fully verified original, or explicitly preserve uncertainty."""
    unavailable = {"status": "unavailable"}
    if not isinstance(evidence, dict) or not isinstance(index, dict):
        return unavailable
    capture, fraction = _capture(evidence.get("captureTime"))
    model = _text(evidence.get("cameraModel"))
    names = evidence.get("filenames")
    if not capture or not model or not isinstance(names, list) or len(names) > MAX_FILENAMES:
        return unavailable
    subsecond = _subsecond(evidence.get("subsecond")) or fraction
    found = {}
    for name in names:
        for stem in filename_stems(name):
            for source in index.get((stem, capture, model), []):
                metadata = source.get("imageMediaMetadata", {})
                _, candidate_fraction = _capture(metadata.get("time"))
                candidate_subsecond = _subsecond(metadata.get("subsecond")) or candidate_fraction
                if subsecond and candidate_subsecond and subsecond != candidate_subsecond:
                    continue
                source_id = source["id"]
                if source_id in found and source != found[source_id]:
                    return {"status": "ambiguous"}
                found[source_id] = source
    if not found:
        return unavailable
    if len(found) > 1:
        hashes = {source.get("md5Checksum") for source in found.values()}
        if len(hashes) != 1 or not re.fullmatch(r"[0-9a-fA-F]{32}", str(next(iter(hashes)))):
            return {"status": "ambiguous"}
        method = "filename_capture_time_camera_identical_duplicates"
    else:
        method = "filename_capture_time_camera"
    return {"status": "matched", "source": found[min(found)], "method": method}
