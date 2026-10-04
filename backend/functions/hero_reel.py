"""Build the silent, looping Videos-page hero reel from public videos.

The worker samples bounded windows of each public video's HLS rendition,
finds calm shots with ffmpeg's scene detector, cuts the chosen clips from the
original uploads (falling back to the HLS rendition), splices them with hard
cuts, and publishes adaptive HLS ladders (landscape and portrait) plus a
poster frame.

Actions:
  reconcile  scheduled; rebuilds and publishes only when the public video
             catalog changed since the last published reel.
  generate   admin request; builds a draft for preview without publishing.
  publish    admin request; publishes a reviewed draft.

Logs carry reason codes and counts only, never keys, titles or IDs.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import os
import http.server
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.parse
import uuid

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from album_media_store import MEDIA_STORE_VERSION, query_album_media
from hero_reel_plan import (
    BUILDER_VERSION,
    LADDERS,
    ORIENTATIONS,
    SEGMENT_SECONDS,
    PlaylistError,
    candidate_clips,
    choose_variant,
    clip_id,
    clip_filter,
    detect_shots,
    filter_graph,
    frame_rate,
    input_digest,
    master_playlist,
    output_rate,
    parse_frame_metadata,
    parse_master_playlist,
    parse_media_playlist,
    plan_analysis,
    reel_seconds,
    rung_name,
    seeded_random,
    select_clips,
)
from media_access import media_id_for_key, validate_album_media_key
from validation_helpers import ValidationError


logger = logging.getLogger("photography_api.hero_reel")

STATE_KEY = {"settingId": "hero-reel"}
REEL_PREFIX = "site/hero/versions/video/reel/v1/"
POINTER_KEY = "site/hero/video/reel.json"
POSTER_PENDING_KEY = "temp-zips/video-hero-pending"
MAX_PLAYLIST_BYTES = 512 * 1024
MAX_SEGMENT_BYTES = 96 * 1024 * 1024
MAX_WINDOW_BYTES = 320 * 1024 * 1024
MAX_RENDITION_BYTES = 160 * 1024 * 1024
MAX_POSTER_BYTES = 8 * 1024 * 1024
MIN_REEL_SECONDS = 12.0
ENCODE_RESERVE_MS = 240_000
ANALYSIS_RESERVE_MS = 420_000
PENDING_RETRY_SECONDS = 24 * 60 * 60
ACTIVE_JOB_STATUSES = frozenset({"queued", "running"})
CUT_COUNT = 5
SOURCE_CHUNK_BYTES = 1024 * 1024
SOURCE_BLOCK_BYTES = 8 * 1024 * 1024
HDR_TRANSFERS = ("smpte2084", "arib-std-b67")
# A batch whose chain stopped advancing stops blocking new batches after this.
BUILD_STALE_SECONDS = 20 * 60

_clients = {}


class ReelError(Exception):
    """A build or publish stopped for an allowlisted reason code."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _client(name):
    if name not in _clients:
        _clients[name] = boto3.client(
            name,
            config=Config(connect_timeout=3, read_timeout=30, retries={"mode": "standard", "max_attempts": 3}),
        )
    return _clients[name]


def _table(variable):
    return boto3.resource("dynamodb").Table(os.environ[variable])


def _bucket():
    return os.environ["IMAGES_BUCKET"]


def _now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ffmpeg_path():
    configured = os.environ.get("FFMPEG_PATH", "").strip()
    return configured or os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin", "ffmpeg")


# ---------------------------------------------------------------- inventory

def _public_video_albums():
    albums, cursor = [], None
    table = _table("ALBUMS_TABLE")
    while True:
        query = {
            "IndexName": os.environ.get("VISIBILITY_CREATED_AT_INDEX", "VisibilityCreatedAtIndex"),
            "KeyConditionExpression": Key("visibility").eq("public"),
            "FilterExpression": (Attr("status").not_exists() | Attr("status").eq("active")) & Attr("type").eq("video"),
            "ScanIndexForward": False,
        }
        if cursor:
            query["ExclusiveStartKey"] = cursor
        response = table.query(**query)
        albums.extend(item for item in response.get("Items", []) if isinstance(item, dict))
        cursor = response.get("LastEvaluatedKey")
        if not cursor:
            return albums


def _album_images(album):
    if album.get("mediaStoreVersion") == MEDIA_STORE_VERSION:
        items, cursor = [], None
        while True:
            page, cursor = query_album_media(album["albumId"], 100, cursor)
            items.extend(page)
            if not cursor:
                return items
    images = album.get("images")
    return images if isinstance(images, list) else []


def _object_key(value):
    if isinstance(value, str) and value.startswith("https://"):
        return urllib.parse.unquote(urllib.parse.urlsplit(value).path).lstrip("/")
    return value


def eligible_videos():
    """Every committed public video that has an HLS rendition."""
    videos = []
    for album in _public_video_albums():
        if album.get("visibility") != "public" or album.get("status", "active") != "active" or album.get("type") != "video":
            continue
        for image in _album_images(album):
            if not isinstance(image, dict):
                continue
            try:
                raw_key = validate_album_media_key(_object_key(image.get("rawKey") or image.get("key")), album=album)
                hls_key = validate_album_media_key(_object_key(image.get("hlsUrl")), album=album)
            except ValidationError:
                continue
            if not hls_key.endswith(".m3u8"):
                continue
            videos.append({
                "albumId": album["albumId"],
                "mediaId": media_id_for_key(raw_key),
                "rawKey": raw_key,
                "hlsKey": hls_key,
                "createdAt": str(album.get("uploadedAt") or album.get("createdAt") or ""),
            })
    return videos


# ---------------------------------------------------------------- storage

def _read_bytes(key, limit, byte_range=None):
    request = {"Bucket": _bucket(), "Key": key}
    if byte_range is not None:
        offset, length = byte_range
        if length > limit:
            raise PlaylistError("too_large")
        request["Range"] = f"bytes={offset}-{offset + length - 1}"
    try:
        response = _client("s3").get_object(**request)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "AccessDenied", "InvalidRange"}:
            raise PlaylistError("missing") from error
        raise
    if int(response.get("ContentLength") or 0) > limit:
        raise PlaylistError("too_large")
    body = response["Body"].read(limit + 1)
    if len(body) > limit:
        raise PlaylistError("too_large")
    if byte_range is not None and len(body) != byte_range[1]:
        raise PlaylistError("short_range")
    return body


def _object_exists(key):
    try:
        _client("s3").head_object(Bucket=_bucket(), Key=key)
        return True
    except ClientError:
        return False


def load_renditions(video):
    """Attach analysis and output segment lists to a video, or raise."""
    master_key = video["hlsKey"]
    text = _read_bytes(master_key, MAX_PLAYLIST_BYTES).decode("utf-8", "replace")
    variants = parse_master_playlist(master_key, text)
    if variants is None:
        segments = parse_media_playlist(master_key, text)
        return {**video, "segments": segments, "outputSegments": segments, "sameVariant": True}
    analysis = choose_variant(variants, "analysis")
    output = choose_variant(variants, "output")
    segments = parse_media_playlist(
        analysis["key"], _read_bytes(analysis["key"], MAX_PLAYLIST_BYTES).decode("utf-8", "replace")
    )
    if output["key"] == analysis["key"]:
        return {**video, "segments": segments, "outputSegments": segments, "sameVariant": True}
    output_segments = parse_media_playlist(
        output["key"], _read_bytes(output["key"], MAX_PLAYLIST_BYTES).decode("utf-8", "replace")
    )
    return {**video, "segments": segments, "outputSegments": output_segments, "sameVariant": False}


def download_segments(segments, workspace, cache):
    """Fetch HLS segments once each and return an ffmpeg concat input.

    Segments stay separate files so a clip can later reuse exactly the
    segments that cover it; `cache` maps segment keys to local files.
    """
    paths, total = [], 0
    for segment in segments:
        byte_range = tuple(segment["range"]) if segment.get("range") else None
        identity = f"{segment['key']}#{byte_range[0]}" if byte_range else segment["key"]
        path = cache.get(identity)
        if path is None:
            data = _read_bytes(segment["key"], MAX_SEGMENT_BYTES, byte_range)
            path = os.path.join(workspace, f"segment-{len(cache)}.ts")
            with open(path, "wb") as handle:
                handle.write(data)
            cache[identity] = path
        total += os.path.getsize(path)
        if total > MAX_WINDOW_BYTES:
            raise PlaylistError("window_too_large")
        paths.append(path)
    return "concat:" + "|".join(paths)


# ---------------------------------------------------------------- ffmpeg

def _run_ffmpeg(arguments, timeout, cwd=None):
    command = [ffmpeg_path(), "-hide_banner", "-nostdin", "-loglevel", "error", *arguments]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=max(5, timeout), check=False, cwd=cwd)
    except subprocess.TimeoutExpired as error:
        raise ReelError("ffmpeg_timeout") from error
    if completed.returncode != 0:
        raise ReelError("ffmpeg_failed")
    return completed


def analyse_window(source, metadata_path, timeout):
    _run_ffmpeg([
        "-skip_loop_filter", "all",
        "-i", source,
        "-an", "-sn", "-dn",
        "-vf", f"scale=192:108:flags=fast_bilinear,scdet=threshold=100,signalstats,metadata=print:file={metadata_path}",
        "-f", "null", "-",
    ], timeout)
    with open(metadata_path, encoding="utf-8", errors="replace") as handle:
        return parse_frame_metadata(handle.read())


class _SourceHandler(http.server.BaseHTTPRequestHandler):
    """Serve registered S3 objects to ffmpeg with byte-range support."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_HEAD(self):
        self._serve(body=False)

    def do_GET(self):
        self._serve(body=True)

    def _serve(self, body):
        server = self.server
        key = server.sources.get(self.path.rsplit("/", 1)[-1])
        if not key:
            self.send_error(404)
            return
        try:
            size = server.size(key)
        except ClientError:
            self.send_error(404)
            return
        match = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", "").strip())
        start, end = 0, size - 1
        if match:
            start = int(match.group(1))
            end = min(size - 1, int(match.group(2))) if match.group(2) else size - 1
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        self.send_response(206 if match else 200)
        if match:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        if not body or end < start:
            return
        # ffmpeg asks for open-ended ranges and hangs up when it seeks, so
        # fetch bounded blocks lazily instead of one request to the end.
        position = start
        try:
            while position <= end:
                last = min(end, position + SOURCE_BLOCK_BYTES - 1)
                stream = _client("s3").get_object(Bucket=_bucket(), Key=key, Range=f"bytes={position}-{last}")["Body"]
                try:
                    for chunk in iter(lambda: stream.read(SOURCE_CHUNK_BYTES), b""):
                        self.wfile.write(chunk)
                finally:
                    stream.close()
                position = last + 1
        except (BrokenPipeError, ConnectionResetError):
            pass


class SourceServer(http.server.ThreadingHTTPServer):
    """A loopback HTTP endpoint for original uploads.

    The bundled ffmpeg is a static build whose own name resolution crashes,
    so it never talks to S3 directly: it reads 127.0.0.1 with plain HTTP and
    this server fetches the requested byte ranges from S3 with the worker's
    role. Only registered keys are served, under random tokens.
    """

    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), _SourceHandler)
        self.sources = {}
        self._sizes = {}
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self.serve_forever, daemon=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self.shutdown()
        self.server_close()

    def register(self, key):
        token = secrets.token_hex(12)
        self.sources[token] = key
        return f"http://127.0.0.1:{self.server_address[1]}/source/{token}"

    def size(self, key):
        with self._lock:
            if key not in self._sizes:
                head = _client("s3").head_object(Bucket=_bucket(), Key=key)
                self._sizes[key] = int(head["ContentLength"])
            return self._sizes[key]


def _network_input():
    return ["-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "4", "-rw_timeout", "30000000"]


def probe_original(url, timeout):
    """Read an original's stream header; None when it cannot be decoded here."""
    command = [ffmpeg_path(), "-hide_banner", "-nostdin", *_network_input(), "-i", url]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=max(5, timeout), check=False)
    except subprocess.TimeoutExpired:
        return None
    text = completed.stderr.decode("utf-8", "replace")
    video = next((line for line in text.splitlines() if re.search(r"Stream #\d+:\d+.*: Video: ", line)), None)
    if video is None:
        return None
    size = re.search(r", (\d{2,5})x(\d{2,5})[ ,]", video)
    return {
        "hdr": any(transfer in video for transfer in HDR_TRANSFERS),
        "width": int(size.group(1)) if size else 0,
        "height": int(size.group(2)) if size else 0,
    }


def normalize_clip(clip, source, rate, orientation, path, timeout):
    """Cut one clip to the orientation's master frame.

    `source` is either an original upload (a URL read with an accurate input
    seek) or concatenated HLS segments. Decoding every source at once inside
    the joining graph would hold a frame queue per input; normalizing first
    keeps memory flat.
    """
    if source["kind"] == "original":
        arguments = [
            *_network_input(),
            "-ss", f"{clip['start']:.3f}", "-t", f"{clip['duration'] + 0.2:.3f}", "-i", source["url"],
        ]
        trim = ""
    else:
        # Trim inside the graph rather than with -ss: demuxer seeks are
        # unreliable across the timestamp discontinuities of concatenated HLS.
        arguments = ["-i", source["path"]]
        trim = f"setpts=PTS-STARTPTS,trim=start={max(0.0, source['offset']):.3f}:duration={clip['duration']:.3f},"
    _run_ffmpeg([
        *arguments,
        "-an", "-sn", "-dn",
        "-vf", f"{trim}setpts=PTS-STARTPTS,{clip_filter(rate, orientation, source.get('hdr', False))}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p",
        "-map_metadata", "-1", "-y", path,
    ], timeout)
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        raise ReelError("encode_missing_output")
    return path


def _check_rung_playlist(path, media_name):
    """The rung playlist may only point at its own media file."""
    with open(path, encoding="utf-8", errors="replace") as handle:
        lines = [line.strip() for line in handle if line.strip()]
    uris = [line for line in lines if not line.startswith("#")]
    maps = re.findall(r'URI="([^"]*)"', "\n".join(lines))
    if not lines or lines[0] != "#EXTM3U" or "#EXT-X-ENDLIST" not in lines or not uris:
        raise ReelError("encode_bad_playlist")
    if any(uri != media_name for uri in [*uris, *maps]):
        raise ReelError("encode_bad_playlist")


def encode_ladder(clips, sources, orientation, cut, workspace, deadline):
    """Normalize each clip, then encode the orientation's HLS ladder.

    Every rung is a single fragmented MP4 addressed by byte ranges, with
    keyframes on a fixed grid so players can switch rungs at any segment.
    The landscape pass also writes the poster frame.
    """
    rate = output_rate(clips)
    normalized = []
    for index, (clip, source) in enumerate(zip(clips, sources)):
        normalized.append(normalize_clip(
            clip, source, rate, orientation, os.path.join(workspace, f"normalized-{index}.mp4"),
            max(5, deadline - time.monotonic()),
        ))
    graph, seconds = filter_graph(clips, rate, orientation)
    output = os.path.join(workspace, "out")
    os.makedirs(output, exist_ok=True)
    arguments = []
    for path in normalized:
        arguments += ["-i", path]
    arguments += ["-filter_complex", graph]
    rungs = {}
    for index, rung in enumerate(LADDERS[orientation]):
        name = rung_name(cut, rung)
        rungs[name] = rung
        arguments += [
            "-map", f"[out{index}]", "-an",
            "-c:v", "libx264", "-preset", "medium", "-crf", str(rung["crf"]),
            "-maxrate", f"{rung['maxrate']}k", "-bufsize", f"{rung['maxrate'] * 2}k",
            "-profile:v", "high", "-level:v", rung["level"], "-pix_fmt", "yuv420p",
            "-force_key_frames", f"expr:gte(t,n_forced*{SEGMENT_SECONDS})", "-sc_threshold", "0",
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
            "-map_metadata", "-1",
            "-f", "hls", "-hls_time", str(SEGMENT_SECONDS), "-hls_playlist_type", "vod",
            "-hls_segment_type", "fmp4", "-hls_flags", "single_file+independent_segments",
            "-hls_segment_filename", f"{name}.mp4", "-y", f"{name}.m3u8",
        ]
    poster = None
    if orientation == "landscape":
        poster = os.path.join(output, "poster.jpg")
        arguments += ["-map", "[poster]", "-frames:v", "1", "-q:v", "2", "-map_metadata", "-1", "-y", "poster.jpg"]
    _run_ffmpeg(arguments, max(5, deadline - time.monotonic()), cwd=output)
    files = {}
    for name, rung in rungs.items():
        media, playlist = os.path.join(output, f"{name}.mp4"), os.path.join(output, f"{name}.m3u8")
        for path in (media, playlist):
            if not os.path.isfile(path) or os.path.getsize(path) == 0:
                raise ReelError("encode_missing_output")
        if os.path.getsize(media) > MAX_RENDITION_BYTES:
            raise ReelError("encode_too_large")
        _check_rung_playlist(playlist, f"{name}.mp4")
        files[name] = {"media": media, "playlist": playlist, "width": rung["width"], "height": rung["height"],
                       "bytes": os.path.getsize(media)}
    if poster is not None and (not os.path.isfile(poster) or os.path.getsize(poster) == 0):
        raise ReelError("encode_missing_output")
    master = master_playlist(cut, orientation, rate, {name: item["bytes"] for name, item in files.items()}, seconds)
    return {"files": files, "master": master, "poster": poster, "seconds": seconds, "rate": rate}


def _remaining_ms(context):
    try:
        return int(context.get_remaining_time_in_millis())
    except (AttributeError, TypeError, ValueError):
        return 900_000


def _segments_covering(segments, start, end):
    covering = [segment for segment in segments if segment["start"] < end and segment["start"] + segment["duration"] > start]
    if not covering:
        raise ReelError("clip_outside_video")
    return covering


def plan_cuts(videos, seed, context, workspace):
    """Analyse once and plan CUT_COUNT distinct cuts.

    Each planned clip carries the exact HLS segments that cover it, so every
    cut can later be encoded in its own invocation without re-analysis.
    """
    rng = seeded_random(BUILDER_VERSION, seed)
    ready, pending = [], []
    for video in videos:
        try:
            ready.append(load_renditions(video))
        except PlaylistError:
            pending.append(video)
    plans = plan_analysis(ready, rng)
    if not plans:
        raise ReelError("no_ready_videos")

    analysed = {}
    cache = {}
    for index, plan in enumerate(plans):
        if _remaining_ms(context) < ANALYSIS_RESERVE_MS:
            break
        window = plan["window"]
        start = window[0]["start"]
        end = window[-1]["start"] + window[-1]["duration"]
        try:
            source = download_segments(window, workspace, cache)
            frames = analyse_window(source, os.path.join(workspace, f"analysis-{index}.txt"), 120)
        except (PlaylistError, ReelError):
            continue
        plan = {**plan, "rate": frame_rate(frames)}
        analysed[plan["mediaId"]] = {"plan": plan, "shots": detect_shots(frames, start, end)}

    strict = {
        media_id: candidate_clips(entry["plan"], entry["shots"], rng)
        for media_id, entry in analysed.items()
    }
    relaxed = None
    cuts, used = [], set()
    for cut in range(CUT_COUNT):
        cut_rng = seeded_random(BUILDER_VERSION, seed, "cut", cut)
        clips = select_clips(strict, cut_rng, used=frozenset(used))
        if reel_seconds(clips) < MIN_REEL_SECONDS:
            # Mostly fast-cut edits: fall back to the steadiest short stretches.
            if relaxed is None:
                relaxed = {
                    media_id: candidate_clips(entry["plan"], entry["shots"], rng, relaxed=True)
                    for media_id, entry in analysed.items()
                }
            clips = select_clips(relaxed, cut_rng, used=frozenset(used))
        if reel_seconds(clips) < MIN_REEL_SECONDS:
            if not cuts:
                raise ReelError("not_enough_footage")
            break
        used.update(clip_id(clip) for clip in clips)
        planned = []
        for clip in clips:
            video = analysed[clip["mediaId"]]["plan"]
            covering = _segments_covering(video["outputSegments"], clip["start"], clip["start"] + clip["duration"])
            planned.append({
                **clip,
                "rawKey": video.get("rawKey"),
                # The HLS fallback for an original that cannot be read.
                "segments": [
                    {"key": item["key"], "start": item["start"], **({"range": item["range"]} if item.get("range") else {})}
                    for item in covering
                ],
            })
        cuts.append(planned)
    return {
        "cuts": cuts,
        "pending": sorted({video["mediaId"] for video in pending}),
        "pendingKeys": sorted({video["hlsKey"] for video in pending}),
    }


def clip_sources(clips, server, workspace, deadline):
    """Where each clip is cut from: its original upload, else HLS segments.

    Originals are probed once each; anything that cannot be read or decoded
    here falls back to the 1080p HLS rendition.
    """
    probes, cache, sources = {}, {}, []
    for clip in clips:
        raw_key = clip.get("rawKey")
        if raw_key:
            if raw_key not in probes:
                url = server.register(raw_key)
                probe = probe_original(url, min(60, max(5, deadline - time.monotonic())))
                probes[raw_key] = {**probe, "url": url} if probe else None
            probe = probes[raw_key]
            if probe:
                sources.append({"kind": "original", "url": probe["url"], "hdr": probe["hdr"]})
                continue
        try:
            path = download_segments(clip["segments"], workspace, cache)
        except PlaylistError as error:
            raise ReelError("clip_download_failed") from error
        sources.append({"kind": "hls", "path": path, "offset": clip["start"] - clip["segments"][0]["start"]})
    fallbacks = sum(1 for source in sources if source["kind"] == "hls")
    if fallbacks:
        logger.info("hero_reel_source_fallback clips=%d of=%d", fallbacks, len(sources))
    return sources


def encode_step(clips, orientation, cut, context, workspace):
    """Encode one orientation of one cut."""
    remaining = _remaining_ms(context)
    if remaining < ENCODE_RESERVE_MS:
        raise ReelError("timeout")
    deadline = time.monotonic() + (remaining - 60_000) / 1000
    with SourceServer() as server:
        sources = clip_sources(clips, server, workspace, deadline)
        return encode_ladder(clips, sources, orientation, cut, workspace, deadline)


def _put(key, body, content_type):
    _client("s3").put_object(
        Bucket=_bucket(), Key=key, Body=body, ContentType=content_type,
        CacheControl="public, max-age=31536000, immutable",
        ServerSideEncryption="AES256", Tagging="visibility=public",
        Metadata={"generator": BUILDER_VERSION},
    )


def upload_step(version, cut, orientation, result):
    """Upload one ladder; the master playlist goes last, once its rungs exist."""
    folder = f"{REEL_PREFIX}{version}/"
    rungs = []
    for name, item in result["files"].items():
        with open(item["media"], "rb") as body:
            _put(f"{folder}{name}.mp4", body, "video/mp4")
        with open(item["playlist"], "rb") as body:
            _put(f"{folder}{name}.m3u8", body, "application/vnd.apple.mpegurl")
        rungs.append({"width": item["width"], "height": item["height"], "bytes": item["bytes"]})
    master_key = f"{folder}reel-{cut}-{orientation}.m3u8"
    _put(master_key, result["master"].encode("utf-8"), "application/vnd.apple.mpegurl")
    entry = {"cut": cut, "orientation": orientation, "master": master_key, "rungs": rungs,
             "duration": str(round(result["seconds"], 2)), "fps": result["rate"]}
    if result["poster"]:
        poster_key = f"{folder}poster-{cut}.jpg"
        with open(result["poster"], "rb") as body:
            _put(poster_key, body, "image/jpeg")
        entry["posterKey"] = poster_key
    return entry


def record_cuts(record):
    """Every cut of a record; single-cut records from before are one cut."""
    if record and record.get("cuts"):
        return record["cuts"]
    if record and record.get("renditions"):
        return [{"renditions": record["renditions"], "posterKey": record.get("posterKey"), "duration": record.get("duration")}]
    return []


def _cuts_from_steps(results):
    """Pair each cut's landscape and portrait step results."""
    cuts = {}
    for entry in results:
        cut = cuts.setdefault(int(entry["cut"]), {"duration": entry["duration"], "fps": entry["fps"]})
        cut[entry["orientation"]] = {"master": entry["master"], "rungs": entry["rungs"]}
        if entry.get("posterKey"):
            cut["posterKey"] = entry["posterKey"]
    return [cuts[index] for index in sorted(cuts) if all(orientation in cuts[index] for orientation in ORIENTATIONS)]


def _reel_record(build, mode):
    plans = json.loads(build["plan"])
    cuts = _cuts_from_steps(build["results"])
    clips = [clip for cut in plans[: len(cuts)] for clip in cut]
    return {
        "version": build["version"],
        "mode": mode,
        "inputDigest": build["digest"],
        "createdAt": _now(),
        "cuts": cuts,
        "duration": cuts[0]["duration"],
        "clipCount": round(len(clips) / len(cuts)),
        "sourceCount": len({clip["mediaId"] for clip in clips}),
        "mediaIds": sorted({clip["mediaId"] for clip in clips}),
        "albumIds": sorted({clip["albumId"] for clip in clips}),
        "pending": list(build.get("pending") or []),
        "pendingKeys": list(build.get("pendingKeys") or []),
        "posterKey": cuts[0]["posterKey"],
    }


# ---------------------------------------------------------------- publish

def _pointer_cut(cut):
    if cut.get("landscape"):
        return {
            "duration": float(cut["duration"]),
            "streams": {
                orientation: {
                    "key": cut[orientation]["master"],
                    "maxWidth": max(int(rung["width"]) for rung in cut[orientation]["rungs"]),
                    "maxHeight": max(int(rung["height"]) for rung in cut[orientation]["rungs"]),
                }
                for orientation in ORIENTATIONS
            },
        }
    # A reel published before adaptive streams: progressive MP4 renditions.
    return {
        "duration": float(cut["duration"]),
        "renditions": [
            {"key": item["key"], "width": int(item["width"]), "height": int(item["height"]), "bytes": int(item["bytes"])}
            for item in cut["renditions"]
        ],
    }


def pointer_document(record):
    if not record:
        return {"schemaVersion": 3, "version": None, "cuts": []}
    return {
        "schemaVersion": 3,
        "version": record["version"],
        "publishedAt": record.get("publishedAt") or _now(),
        "cuts": [_pointer_cut(cut) for cut in record_cuts(record)],
    }


def _invalidate(paths, reference):
    distribution = os.environ.get("IMAGES_DISTRIBUTION_ID", "").strip()
    if not distribution:
        return False
    try:
        _client("cloudfront").create_invalidation(
            DistributionId=distribution,
            InvalidationBatch={
                "CallerReference": f"{reference}-{uuid.uuid4().hex[:12]}",
                "Paths": {"Quantity": len(paths), "Items": paths},
            },
        )
        return True
    except (BotoCoreError, ClientError) as error:
        logger.error("hero_reel_invalidation_failed error_type=%s", type(error).__name__)
        return False


def write_pointer(record):
    body = json.dumps(pointer_document(record), separators=(",", ":"), sort_keys=True).encode("utf-8")
    _client("s3").put_object(
        Bucket=_bucket(), Key=POINTER_KEY, Body=body, ContentType="application/json",
        CacheControl="public, max-age=0, must-revalidate",
        ServerSideEncryption="AES256", Tagging="visibility=public",
    )
    _invalidate([f"/{POINTER_KEY}"], f"hero-reel-{(record or {}).get('version') or 'none'}")


def publish_poster(record):
    """Hand the reel's first frame to the existing still-hero pipeline."""
    queue = os.environ.get("HERO_DERIVATIVE_QUEUE_URL", "").strip()
    if not queue:
        return False
    poster = _read_bytes(record["posterKey"], MAX_POSTER_BYTES)
    response = _client("s3").put_object(
        Bucket=_bucket(), Key=POSTER_PENDING_KEY, Body=poster, ContentType="image/jpeg",
        ServerSideEncryption="AES256", Tagging="visibility=pending",
    )
    etag = str(response.get("ETag") or "").replace('"', "").lower()
    if len(etag) != 32:
        return False
    _client("sqs").send_message(
        QueueUrl=queue,
        MessageBody=json.dumps(
            {"kind": "hero", "heroType": "video", "sourceKey": POSTER_PENDING_KEY, "version": etag},
            separators=(",", ":"),
        ),
    )
    return True


def cleanup_versions(keep):
    """Delete reel versions other than the ones still referenced."""
    s3 = _client("s3")
    keep = {version for version in keep if version}
    removed = 0
    response = s3.list_objects_v2(Bucket=_bucket(), Prefix=REEL_PREFIX, Delimiter="/", MaxKeys=200)
    for prefix in response.get("CommonPrefixes", []):
        version = prefix.get("Prefix", "")[len(REEL_PREFIX):].rstrip("/")
        if not version or version in keep:
            continue
        listing = s3.list_objects_v2(Bucket=_bucket(), Prefix=f"{REEL_PREFIX}{version}/", MaxKeys=50)
        objects = [{"Key": item["Key"]} for item in listing.get("Contents", [])]
        if objects:
            s3.delete_objects(Bucket=_bucket(), Delete={"Objects": objects, "Quiet": True})
            removed += 1
    return removed


def _still_eligible(record, eligible_ids):
    return bool(record) and set(record.get("mediaIds") or []) <= eligible_ids


def _versions_to_keep(state, eligible_ids):
    keep = set()
    for name in ("published", "previous", "draft"):
        record = state.get(name)
        if _still_eligible(record, eligible_ids):
            keep.add(record["version"])
    return keep


def publish_record(state, record, eligible_ids):
    """Make a built reel live and retire unreferenced versions."""
    record = {**record, "publishedAt": _now()}
    write_pointer(record)
    poster_queued = publish_poster(record)
    previous = state.get("published")
    state_update = {"published": record}
    state_update["previous"] = {"version": previous["version"], "mediaIds": previous.get("mediaIds", [])} if (
        previous and previous.get("version") != record["version"] and _still_eligible(previous, eligible_ids)
    ) else None
    merged = {**state, **state_update}
    cleanup_versions(_versions_to_keep(merged, eligible_ids))
    return state_update, poster_queued


def unpublish(state, eligible_ids):
    write_pointer(None)
    merged = {**state, "published": None, "previous": None}
    cleanup_versions(_versions_to_keep(merged, eligible_ids))
    return {"published": None, "previous": None}


# ---------------------------------------------------------------- state

def load_state():
    item = _table("GALLERY_SETTINGS_TABLE").get_item(Key=STATE_KEY, ConsistentRead=True).get("Item")
    return item or {}


def save_state(values, condition=None, condition_values=None):
    names, assignments, removals, expression_values = {}, [], [], dict(condition_values or {})
    for index, (name, value) in enumerate(sorted(values.items())):
        names[f"#f{index}"] = name
        if value is None:
            removals.append(f"#f{index}")
        else:
            assignments.append(f"#f{index} = :v{index}")
            expression_values[f":v{index}"] = value
    expression = []
    if assignments:
        expression.append("SET " + ", ".join(assignments))
    if removals:
        expression.append("REMOVE " + ", ".join(removals))
    request = {"Key": STATE_KEY, "UpdateExpression": " ".join(expression), "ExpressionAttributeNames": names}
    if expression_values:
        request["ExpressionAttributeValues"] = expression_values
    if condition:
        request["ConditionExpression"] = condition
        request["ExpressionAttributeNames"].update({"#job": "job", "#requestId": "requestId"})
    _table("GALLERY_SETTINGS_TABLE").update_item(**request)


def _job(request_id, mode, status, **extra):
    return {"requestId": request_id, "mode": mode, "status": status, "updatedAt": _now(), **extra}


def _claim_job(event, mode, status, **extra):
    request_id = str(event.get("requestId") or "")
    if not request_id:
        raise ReelError("missing_request")
    try:
        save_state(
            {"job": _job(request_id, mode, status, **extra)},
            condition="#job.#requestId = :rid",
            condition_values={":rid": request_id},
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise ReelError("superseded") from error
        raise
    return request_id


def _pending_became_ready(record):
    keys = (record or {}).get("pendingKeys") or []
    return any(_object_exists(key) for key in keys[:10])


def _build_active(state):
    build = state.get("build")
    if not isinstance(build, dict):
        return False
    stale = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=BUILD_STALE_SECONDS)
    return str(build.get("updatedAt") or "") > stale.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _invoke_next(context, batch_id, step):
    _client("lambda").invoke(
        FunctionName=context.invoked_function_arn,
        InvocationType="Event",
        Payload=json.dumps({"action": "build-cut", "batchId": batch_id, "step": step}, separators=(",", ":")).encode("utf-8"),
    )


def _step(step):
    """Each cut is two steps: its landscape ladder, then its portrait one."""
    return step // len(ORIENTATIONS), ORIENTATIONS[step % len(ORIENTATIONS)]


def start_batch(videos, seed, mode, context, request_id=None):
    """Plan every cut, record the batch, and hand step 0 to the next invocation.

    Starting a batch supersedes any batch already in flight.
    """
    digest = input_digest(videos)
    workspace = tempfile.mkdtemp(prefix="hero-reel-", dir="/tmp")
    try:
        planned = plan_cuts(videos, seed, context, workspace)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
    batch_id = uuid.uuid4().hex
    version = hashlib.sha256(f"{digest}|{seed}|{batch_id}".encode("utf-8")).hexdigest()[:24]
    save_state({"build": {
        "batchId": batch_id,
        "builder": BUILDER_VERSION,
        "mode": mode,
        "requestId": request_id,
        "version": version,
        "digest": digest,
        "plan": json.dumps(planned["cuts"], separators=(",", ":")),
        "cutCount": len(planned["cuts"]),
        "stepCount": len(planned["cuts"]) * len(ORIENTATIONS),
        "results": [],
        "pending": planned["pending"],
        "pendingKeys": planned["pendingKeys"],
        "updatedAt": _now(),
    }})
    _invoke_next(context, batch_id, 0)
    return {"status": "building", "version": version, "cuts": len(planned["cuts"])}


def _append_result(batch_id, step, result):
    try:
        _table("GALLERY_SETTINGS_TABLE").update_item(
            Key=STATE_KEY,
            UpdateExpression="SET #build.#results = list_append(#build.#results, :result), #build.#updatedAt = :now",
            ConditionExpression="#build.#batchId = :batch AND size(#build.#results) = :step",
            ExpressionAttributeNames={"#build": "build", "#results": "results", "#updatedAt": "updatedAt", "#batchId": "batchId"},
            ExpressionAttributeValues={":result": [result], ":now": _now(), ":batch": batch_id, ":step": step},
        )
        return True
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise


def _fail_batch(build, reason):
    update = {"build": None}
    if build.get("mode") == "draft" and build.get("requestId"):
        update["job"] = _job(build["requestId"], "draft", "failed", reason=reason)
    else:
        update["auto"] = {"status": "failed", "reason": reason, "at": _now(), "inputDigest": build.get("digest")}
    save_state(update)
    logger.warning("hero_reel_batch_failed mode=%s reason=%s", build.get("mode"), reason)
    return {"status": "failed", "reason": reason}


def build_cut(event, context):
    """Encode one planned step, then chain to the next or finish the batch."""
    state = load_state()
    build = state.get("build")
    batch_id = str(event.get("batchId") or "")
    try:
        step = int(event.get("step"))
    except (TypeError, ValueError):
        return {"status": "rejected"}
    if not isinstance(build, dict) or build.get("batchId") != batch_id:
        return {"status": "superseded"}
    if build.get("builder") != BUILDER_VERSION:
        # Planned by an older worker whose results this one cannot read.
        return _fail_batch(build, "builder_changed")
    plans = json.loads(build["plan"])
    total = int(build["stepCount"])
    done = len(build.get("results") or [])
    if step < done:
        # A retried invocation: the step is already encoded.
        return _advance(state, build, context, done)
    if step != done or step >= total:
        return {"status": "rejected"}
    cut, orientation = _step(step)
    workspace = tempfile.mkdtemp(prefix="hero-reel-", dir="/tmp")
    try:
        result = encode_step(plans[cut], orientation, cut, context, workspace)
        entry = upload_step(build["version"], cut, orientation, result)
    except ReelError as error:
        return _fail_batch(build, error.reason)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
    if not _append_result(batch_id, step, entry):
        return {"status": "superseded"}
    build = {**build, "results": [*(build.get("results") or []), entry]}
    if build.get("mode") == "draft" and build.get("requestId"):
        save_state({"job": _job(build["requestId"], "draft", "running",
                                progress=(step + 1) // len(ORIENTATIONS), total=len(plans))})
    return _advance(state, build, context, step + 1)


def _advance(state, build, context, done):
    if done < int(build["stepCount"]):
        _invoke_next(context, build["batchId"], done)
        return {"status": "building", "step": done}
    return finish_batch(state, build)


def finish_batch(state, build):
    videos = eligible_videos()
    eligible_ids = {video["mediaId"] for video in videos}
    record = _reel_record(build, build["mode"])
    if not _still_eligible(record, eligible_ids):
        return _fail_batch(build, "sources_changed")
    if build["mode"] == "auto":
        update, poster_queued = publish_record(state, record, eligible_ids)
        save_state(update | {"build": None, "auto": {"status": "published", "at": _now(), "version": record["version"]}})
        logger.info(
            "hero_reel_published mode=auto cuts=%d sources=%d pending=%d poster=%s",
            len(record["cuts"]), record["sourceCount"], len(record["pending"]), poster_queued,
        )
        return {"status": "published", "version": record["version"]}
    old_draft = state.get("draft")
    update = {"draft": record, "build": None}
    if build.get("requestId"):
        update["job"] = _job(build["requestId"], "draft", "ready", version=record["version"])
    save_state(update)
    if old_draft and old_draft.get("version") != record["version"]:
        cleanup_versions(_versions_to_keep({**state, "draft": record}, eligible_ids))
    logger.info("hero_reel_draft_ready cuts=%d sources=%d", len(record["cuts"]), record["sourceCount"])
    return {"status": "ready", "version": record["version"]}


# ---------------------------------------------------------------- actions

def reconcile(context):
    state = load_state()
    if _build_active(state):
        return {"status": "busy"}
    videos = eligible_videos()
    eligible_ids = {video["mediaId"] for video in videos}
    published = state.get("published")
    digest = input_digest(videos)
    if not videos:
        if published:
            save_state(unpublish(state, eligible_ids) | {"auto": {"status": "unpublished", "at": _now()}})
            return {"status": "unpublished"}
        return {"status": "unchanged"}
    if published and published.get("inputDigest") == digest and not _pending_became_ready(published):
        return {"status": "unchanged"}
    if published and not _still_eligible(published, eligible_ids):
        # A clip's source left the public catalog: take the reel down now
        # rather than waiting for the rebuild below to finish.
        save_state(unpublish(state, eligible_ids))
    try:
        return start_batch(videos, digest, "auto", context)
    except ReelError as error:
        # Recorded, not raised: an async retry would only repeat the same
        # expensive build. The next scheduled run tries again.
        save_state({"auto": {"status": "failed", "reason": error.reason, "at": _now(), "inputDigest": digest}})
        logger.warning("hero_reel_auto_failed reason=%s", error.reason)
        return {"status": "skipped", "reason": error.reason}


def generate(event, context):
    request_id = _claim_job(event, "draft", "running", startedAt=_now(), progress=0, total=CUT_COUNT)
    videos = eligible_videos()
    try:
        return start_batch(videos, f"draft|{request_id}", "draft", context, request_id=request_id)
    except ReelError as error:
        save_state({"job": _job(request_id, "draft", "failed", reason=error.reason)})
        logger.warning("hero_reel_draft_failed reason=%s", error.reason)
        return {"status": "failed", "reason": error.reason}


def publish(event, context):
    version = str(event.get("version") or "")
    request_id = _claim_job(event, "publish", "running", version=version)
    state = load_state()
    draft = state.get("draft")
    videos = eligible_videos()
    eligible_ids = {video["mediaId"] for video in videos}
    if not draft or draft.get("version") != version:
        reason = "draft_missing"
    elif not _still_eligible(draft, eligible_ids):
        reason = "sources_changed"
    else:
        reason = None
    if reason:
        save_state({"job": _job(request_id, "publish", "failed", reason=reason, version=version)})
        return {"status": "failed", "reason": reason}
    record = {**draft, "mode": "manual", "inputDigest": input_digest(videos)}
    update, poster_queued = publish_record(state, record, eligible_ids)
    save_state(update | {"draft": None, "job": _job(request_id, "publish", "published", version=version)})
    logger.info("hero_reel_published mode=manual cuts=%d poster=%s", len(record_cuts(record)), poster_queued)
    return {"status": "published", "version": version}


def handler(event, context):
    event = event if isinstance(event, dict) else {}
    action = event.get("action") or "reconcile"
    try:
        if action == "build-cut":
            return build_cut(event, context)
        if action == "generate":
            return generate(event, context)
        if action == "publish":
            return publish(event, context)
        if action == "reconcile":
            return reconcile(context)
        logger.warning("hero_reel_rejected reason=unknown_action")
        return {"status": "rejected"}
    except ReelError as error:
        logger.warning("hero_reel_stopped action=%s reason=%s", action, error.reason)
        return {"status": "failed", "reason": error.reason}
    except (BotoCoreError, ClientError) as error:
        logger.error("hero_reel_failed action=%s error_type=%s", action, type(error).__name__)
        if action in {"generate", "publish"} and event.get("requestId"):
            try:
                save_state({"job": _job(str(event["requestId"]), action, "failed", reason="service_error")})
            except (BotoCoreError, ClientError):
                pass
        raise
