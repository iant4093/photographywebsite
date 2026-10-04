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
