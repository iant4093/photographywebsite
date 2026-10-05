"""Where a video's adaptive stream lives, and which videos need re-converting.

Dependency-free so the scheduled upgrade scanner stays small.
"""

import hashlib
import uuid

# Version 2 streams live in their own folder so a re-conversion never
# overwrites a master playlist that browsers and the CDN may still cache.
HLS_LADDER_VERSION = 2


def hls_destination_prefix(raw_key):
    return f"{raw_key.rsplit('.', 1)[0]}_hls/v{HLS_LADDER_VERSION}/"


def hls_master_playlist_key(raw_key):
    """Match MediaConvert's input-based name for the HLS multivariant playlist."""
    filename = raw_key.rsplit(".", 1)[0].rsplit("/", 1)[-1]
    return f"{hls_destination_prefix(raw_key)}{filename}.m3u8"


def hls_is_current(raw_key, hls_url):
    """Whether a video's stream is already the current ladder."""
    return isinstance(hls_url, str) and hls_url == hls_master_playlist_key(raw_key)


def receipt_identity(key):
    return hashlib.sha256(key.encode()).hexdigest()[:24]


# Timeline preview frames: one small JPEG every few seconds, in the stream's
# folder tree so they share its visibility tags and lifecycle.
SCRUB_FRAMES_VERSION = 1
SCRUB_FRAME_INTERVAL = 2
SCRUB_FRAME_EDGE = 320
SCRUB_FRAMES = {"v": SCRUB_FRAMES_VERSION, "interval": SCRUB_FRAME_INTERVAL}


def scrub_frames_prefix(raw_key):
    return f"{raw_key.rsplit('.', 1)[0]}_hls/frames/v{SCRUB_FRAMES_VERSION}/"


def scrub_frame_base_key(raw_key):
    """Frame N is this plus a 7-digit index and ".jpg" (MediaConvert's naming)."""
    filename = raw_key.rsplit(".", 1)[0].rsplit("/", 1)[-1]
    return f"{scrub_frames_prefix(raw_key)}{filename}."


def scrub_frames_current(frames):
    return isinstance(frames, dict) and frames.get("v") == SCRUB_FRAMES_VERSION


def frames_receipt_identity(key):
    return receipt_identity(f"{key}#frames")


def frames_candidates(album):
    """Videos on the current ladder that have no timeline frames yet."""
    jobs = album.get("videoJobs") or {}
    return [
        image["rawKey"] for image in album.get("images", [])
        if isinstance(image, dict) and isinstance(image.get("rawKey"), str) and image.get("mediaConvertJobId")
        and hls_is_current(image["rawKey"], image.get("hlsUrl")) and not scrub_frames_current(image.get("scrubFrames"))
        and frames_receipt_identity(image["rawKey"]) not in jobs and receipt_identity(image["rawKey"]) not in jobs
    ]


def frames_receipt(key):
    return frames_receipt_identity(key), {"key": key, "token": uuid.uuid4().hex, "phase": "prepared", "frames": True}


def upgrade_candidates(album):
    """Converted videos whose stream predates the current ladder."""
    jobs = album.get("videoJobs") or {}
    return [
        image["rawKey"] for image in album.get("images", [])
        if isinstance(image, dict) and isinstance(image.get("rawKey"), str) and image.get("mediaConvertJobId")
        and not hls_is_current(image["rawKey"], image.get("hlsUrl")) and receipt_identity(image["rawKey"]) not in jobs
    ]


def upgrade_receipt(key):
    return receipt_identity(key), {"key": key, "token": uuid.uuid4().hex, "phase": "prepared", "upgrade": True}
