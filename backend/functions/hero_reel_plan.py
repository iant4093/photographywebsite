"""Pure planning helpers for the Videos-page hero reel.

Everything here is deterministic and free of AWS or subprocess calls so the
selection rules can be tested exactly: HLS playlist parsing, bounded analysis
windows, shot detection from ffmpeg frame metadata, calm-clip selection and
the ffmpeg filter graph that splices the clips into a seamless loop.
"""

from __future__ import annotations

import hashlib
import math
import posixpath
import random
import urllib.parse


BUILDER_VERSION = "hero-reel-v2"
TARGET_SECONDS = 60.0
MIN_CLIP_SECONDS = 3.0
MAX_CLIP_SECONDS = 5.0
FALLBACK_MIN_CLIP_SECONDS = 1.6
SHOT_MARGIN_SECONDS = 0.15
# Minimum spacing between two clips taken from the same long take.
SLOT_GAP_SECONDS = 3.0
# Openings and endings of a video usually hold fades and titles.
VIDEO_EDGE_SECONDS = 1.5
CUT_SCORE = 6.0
FLASH_LUMA_JUMP = 24.0
CALM_MOTION_LIMIT = 3.0
DARK_LUMA = 18.0
BRIGHT_LUMA = 235.0
ANALYSIS_BUDGET_SECONDS = 600.0
MAX_WINDOW_SECONDS = 30.0
MIN_WINDOW_SECONDS = 10.0
MAX_VIDEOS = 40
MAX_PLAYLIST_SEGMENTS = 2000
# Clips come from the original upload; when it cannot be read they fall back
# to the best HLS rendition, which needs at least this height.
FALLBACK_SOURCE_HEIGHT = 1080
STANDARD_RATES = (
    ("24000/1001", 24000 / 1001),
    ("24", 24.0),
    ("25", 25.0),
    ("30000/1001", 30000 / 1001),
    ("30", 30.0),
)
# Each orientation is its own adaptive (HLS) ladder cut from its own master
# frame, so the phone version is cropped from the 4K original rather than
# from a 1080p frame. Players start low and step up as bandwidth allows;
# BANDWIDTH in the master playlist is the encoder's peak (maxrate).
ORIENTATIONS = ("landscape", "portrait")
MASTERS = {"landscape": (2560, 1440), "portrait": (1080, 1920)}
LADDERS = {
    "landscape": (
        {"width": 2560, "height": 1440, "crf": 19, "maxrate": 12000, "level": "5.0"},
        {"width": 1920, "height": 1080, "crf": 20, "maxrate": 8000, "level": "4.1"},
        {"width": 1280, "height": 720, "crf": 21, "maxrate": 4000, "level": "4.1"},
        {"width": 960, "height": 540, "crf": 22, "maxrate": 1600, "level": "4.1"},
    ),
    "portrait": (
        {"width": 1080, "height": 1920, "crf": 20, "maxrate": 8000, "level": "4.1"},
        {"width": 720, "height": 1280, "crf": 21, "maxrate": 4000, "level": "4.1"},
        {"width": 540, "height": 960, "crf": 22, "maxrate": 1600, "level": "4.1"},
    ),
}
# The variant a player without a bandwidth estimate (Safari) starts on.
START_VARIANT = {"landscape": (1280, 720), "portrait": (720, 1280)}
SEGMENT_SECONDS = 4
CODEC_LEVELS = {"4.1": "640029", "5.0": "640032"}


class PlaylistError(ValueError):
    """The HLS playlist is missing, incomplete, or outside its directory."""


def input_digest(videos):
    """Fingerprint the eligible inputs so unchanged catalogs never rebuild."""
    lines = sorted(f"{video['albumId']}|{video['mediaId']}|{video['hlsKey']}" for video in videos)
    payload = "\n".join([BUILDER_VERSION, *lines]).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _attributes(text):
    attributes = {}
    for part in _split_attributes(text):
        name, separator, value = part.partition("=")
        if separator:
            attributes[name.strip().upper()] = value.strip().strip('"')
    return attributes


def _split_attributes(text):
    parts, current, quoted = [], [], False
    for character in text:
        if character == '"':
            quoted = not quoted
        if character == "," and not quoted:
            parts.append("".join(current))
            current = []
        else:
            current.append(character)
    parts.append("".join(current))
    return parts


def resolve_playlist_uri(playlist_key, uri):
    """Resolve a relative playlist URI and keep it inside the playlist folder."""
    if not isinstance(uri, str) or not uri or "://" in uri or uri.startswith("/") or "?" in uri:
        raise PlaylistError("unsupported_uri")
    directory = posixpath.dirname(playlist_key)
    resolved = posixpath.normpath(posixpath.join(directory, urllib.parse.unquote(uri)))
    if posixpath.dirname(resolved) != directory or "\x00" in resolved:
        raise PlaylistError("uri_outside_rendition")
    return resolved


def parse_master_playlist(playlist_key, text):
    """Return the variants of a master playlist, or None for a media playlist."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines or lines[0] != "#EXTM3U":
        raise PlaylistError("not_a_playlist")
    if not any(line.startswith("#EXT-X-STREAM-INF") for line in lines):
        return None
    variants = []
    for index, line in enumerate(lines):
        if not line.startswith("#EXT-X-STREAM-INF:") or index + 1 >= len(lines):
            continue
        attributes = _attributes(line.split(":", 1)[1])
        width, _, height = attributes.get("RESOLUTION", "").partition("x")
        try:
            width, height = int(width), int(height)
            bandwidth = int(attributes.get("BANDWIDTH", "0"))
        except ValueError:
            continue
        if width <= 0 or height <= 0:
            continue
        variants.append({
            "key": resolve_playlist_uri(playlist_key, lines[index + 1]),
            "width": width,
            "height": height,
            "bandwidth": bandwidth,
        })
    if not variants:
        raise PlaylistError("no_variants")
    return variants


def parse_media_playlist(playlist_key, text):
    """Return timed segments for a complete VOD media playlist."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines or lines[0] != "#EXTM3U":
        raise PlaylistError("not_a_playlist")
    if "#EXT-X-ENDLIST" not in lines:
        raise PlaylistError("incomplete")
    segments = []
    start = 0.0
    duration = None
    for line in lines[1:]:
        if line.startswith("#EXTINF:"):
            try:
                duration = float(line.split(":", 1)[1].split(",", 1)[0])
            except ValueError as error:
                raise PlaylistError("bad_duration") from error
        elif line.startswith("#EXT-X-BYTERANGE") or line.startswith("#EXT-X-KEY") or line.startswith("#EXT-X-MAP"):
            raise PlaylistError("unsupported_feature")
        elif not line.startswith("#"):
            if duration is None or not math.isfinite(duration) or duration <= 0:
                raise PlaylistError("bad_duration")
            segments.append({
                "key": resolve_playlist_uri(playlist_key, line),
                "start": round(start, 3),
                "duration": duration,
            })
            start += duration
            duration = None
            if len(segments) > MAX_PLAYLIST_SEGMENTS:
                raise PlaylistError("too_many_segments")
    if not segments:
        raise PlaylistError("empty")
    return segments


def choose_variant(variants, purpose):
    """Pick the cheapest variant that still serves the purpose."""
    by_height = sorted(variants, key=lambda variant: (variant["height"], variant["bandwidth"]))
    if purpose == "analysis":
        usable = [variant for variant in by_height if variant["height"] >= 360]
        return (usable or by_height)[0]
    usable = [variant for variant in by_height if variant["height"] >= FALLBACK_SOURCE_HEIGHT]
    return (usable or by_height)[0] if usable else by_height[-1]


def seeded_random(*parts):
    seed = hashlib.sha256("|".join(str(part) for part in parts).encode("utf-8")).hexdigest()
    return random.Random(int(seed[:16], 16))


def plan_analysis(videos, rng, budget=ANALYSIS_BUDGET_SECONDS):
    """Choose bounded, segment-aligned analysis windows across the catalog.

    Recent uploads are always considered; older ones are sampled so the work
    stays bounded no matter how large the catalog grows.
    """
    ordered = sorted(videos, key=lambda video: video.get("createdAt") or "", reverse=True)
    if len(ordered) > MAX_VIDEOS:
        recent = ordered[: MAX_VIDEOS // 2]
        rest = ordered[MAX_VIDEOS // 2:]
        ordered = recent + rng.sample(rest, MAX_VIDEOS - len(recent))
    if not ordered:
        return []
    window = max(MIN_WINDOW_SECONDS, min(MAX_WINDOW_SECONDS, budget / len(ordered)))
    plans = []
    for video in ordered:
        segments = video["segments"]
        total = segments[-1]["start"] + segments[-1]["duration"]
        count = len(segments)
        if total <= window + 5:
            first, last = 0, count
        else:
            span = 1
            while span < count and sum(item["duration"] for item in segments[:span]) < window:
                span += 1
            # Skip the opening segment of longer videos: titles and fades live there.
            lower = 1 if count - span > 1 else 0
            first = rng.randint(lower, count - span)
            last = first + span
        plans.append({**video, "window": segments[first:last], "duration": total})
    return plans


def parse_frame_metadata(text):
    """Parse ffmpeg `metadata=print` output into per-frame measurements."""
    frames = []
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("frame:"):
            _, _, value = line.partition("pts_time:")
            try:
                current = {"t": float(value.split()[0]), "score": 0.0, "luma": None}
            except (ValueError, IndexError):
                current = None
                continue
            frames.append(current)
        elif current is not None and "=" in line:
            name, _, value = line.partition("=")
            try:
                number = float(value)
            except ValueError:
                continue
            if name == "lavfi.scd.score":
                current["score"] = number
            elif name == "lavfi.signalstats.YAVG":
                current["luma"] = number
    return [frame for frame in frames if frame["luma"] is not None and math.isfinite(frame["t"])]


def detect_shots(frames, window_start, window_end):
    """Split analysed frames into shots at cuts and flashes.

    Times are returned on the source video's own timeline.
    """
    if len(frames) < 2:
        return []
    origin = frames[0]["t"]
    boundaries = [0]
    for index in range(1, len(frames)):
        jump = abs(frames[index]["luma"] - frames[index - 1]["luma"])
        if frames[index]["score"] >= CUT_SCORE or jump >= FLASH_LUMA_JUMP:
            boundaries.append(index)
    boundaries.append(len(frames))
    step = (frames[-1]["t"] - origin) / max(1, len(frames) - 1)
    shots = []
    for begin, end in zip(boundaries, boundaries[1:]):
        if end - begin < 2:
            continue
        inner = frames[begin + 1:end]
        start = window_start + frames[begin]["t"] - origin
        stop = min(window_end, window_start + frames[end - 1]["t"] - origin + step)
        shots.append({
            "start": round(start, 3),
            "end": round(stop, 3),
            "motion": sum(frame["score"] for frame in inner) / len(inner),
            "luma": sum(frame["luma"] for frame in frames[begin:end]) / (end - begin),
        })
    return shots


def frame_rate(frames):
    """Snap the measured frame interval to a standard output rate."""
    if len(frames) < 3:
        return "24"
    deltas = sorted(b["t"] - a["t"] for a, b in zip(frames, frames[1:]) if b["t"] > a["t"])
    if not deltas:
        return "24"
    measured = 1.0 / deltas[len(deltas) // 2]
    while measured > 31:
        measured /= 2
    return min(STANDARD_RATES, key=lambda rate: abs(rate[1] - measured))[0]


def candidate_clips(video, shots, rng, *, relaxed=False):
    """Turn the calm stretches of each shot into clip candidates.

    Long single takes are split into several evenly spaced slots so they can
    contribute more than one moment; each slot is its own candidate.
    """
    minimum = FALLBACK_MIN_CLIP_SECONDS if relaxed else MIN_CLIP_SECONDS
    ending = video.get("duration", math.inf) - VIDEO_EDGE_SECONDS
    candidates = []
    for index, shot in enumerate(shots):
        usable_start = max(shot["start"] + SHOT_MARGIN_SECONDS, VIDEO_EDGE_SECONDS)
        usable = min(shot["end"] - SHOT_MARGIN_SECONDS, ending) - usable_start
        if usable < minimum:
            continue
        if not relaxed and (
            shot["motion"] > CALM_MOTION_LIMIT
            or not DARK_LUMA <= shot["luma"] <= BRIGHT_LUMA
        ):
            continue
        # Longer, steadier shots read as calmer footage; very dark or very
        # static shots are still allowed but rank lower.
        quality = min(usable, 8.0) - 0.8 * shot["motion"]
        if shot["motion"] < 0.05:
            quality -= 1.0
        if not DARK_LUMA <= shot["luma"] <= BRIGHT_LUMA:
            quality -= 3.0
        slots = max(1, int((usable + SLOT_GAP_SECONDS) // (MAX_CLIP_SECONDS + SLOT_GAP_SECONDS)))
        span = usable / slots
        for slot in range(slots):
            length = min(MAX_CLIP_SECONDS, span)
            start = usable_start + slot * span + rng.uniform(0, span - length)
            candidates.append({
                "albumId": video["albumId"],
                "mediaId": video["mediaId"],
                "shot": f"{index}.{slot}",
                "start": round(start, 3),
                "duration": round(length, 3),
                "quality": round(quality - 0.5 * slot, 3),
                "rate": video.get("rate", "24"),
            })
    return sorted(candidates, key=lambda clip: -clip["quality"])


def reel_seconds(clips):
    """Length of the looped reel; clips are joined with hard cuts."""
    return sum(clip["duration"] for clip in clips)


def clip_id(clip):
    return f"{clip['mediaId']}|{clip['shot']}"


def select_clips(candidates_by_video, rng, target=TARGET_SECONDS, used=frozenset()):
    """Pick clips round-robin across videos until the reel is long enough.

    Clips another cut already used go last, and a little per-cut noise in the
    ranking keeps several cuts built from one analysis distinct.
    """
    pools = {
        media_id: sorted(
            (dict(item) for item in items),
            key=lambda item: (clip_id(item) in used, -(item["quality"] + rng.uniform(0, 2.5))),
        )
        for media_id, items in candidates_by_video.items() if items
    }
    order = list(pools)
    rng.shuffle(order)
    chosen = []
    # Unused clips from every video come before any reuse.
    reuse = not any(clip_id(pool[0]) not in used for pool in pools.values())
    while pools and reel_seconds(chosen) < target:
        progressed = False
        for media_id in list(order):
            pool = pools.get(media_id)
            if not pool or (not reuse and clip_id(pool[0]) in used):
                continue
            clip = pool.pop(0)
            # Never reuse the same shot twice.
            pools[media_id] = [item for item in pool if item["shot"] != clip["shot"]]
            chosen.append(clip)
            progressed = True
            if reel_seconds(chosen) >= target:
                break
        pools = {media_id: pool for media_id, pool in pools.items() if pool}
        if not progressed:
            if reuse or not pools:
                break
            reuse = True
        order = [media_id for media_id in order if media_id in pools]
    excess = reel_seconds(chosen) - target
    if chosen and excess > 0:
        # Land on the target length by shortening the clip that overshot it.
        last = chosen[-1]
        last["duration"] = round(max(FALLBACK_MIN_CLIP_SECONDS, last["duration"] - excess), 3)
    return _interleave(chosen, rng)


def _interleave(clips, rng):
    """Order clips so neighbours come from different videos where possible."""
    remaining = list(clips)
    rng.shuffle(remaining)
    ordered = []
    while remaining:
        previous = ordered[-1]["mediaId"] if ordered else None
        index = next((i for i, clip in enumerate(remaining) if clip["mediaId"] != previous), 0)
        ordered.append(remaining.pop(index))
    if len(ordered) > 2 and ordered[0]["mediaId"] == ordered[-1]["mediaId"]:
        for index in range(1, len(ordered) - 1):
            if ordered[index]["mediaId"] != ordered[0]["mediaId"] and ordered[index - 1]["mediaId"] != ordered[-1]["mediaId"]:
                ordered[-1], ordered[index] = ordered[index], ordered[-1]
                break
    return ordered


def output_rate(clips):
    counts = {}
    for clip in clips:
        counts[clip["rate"]] = counts.get(clip["rate"], 0) + 1
    return max(sorted(counts), key=lambda rate: counts[rate]) if counts else "24"


def clip_filter(rate, orientation, hdr=False):
    """Scale and crop any source to the orientation's master frame.

    HDR (PQ or HLG) originals are tone-mapped to SDR BT.709 first.
    """
    width, height = MASTERS[orientation]
    tonemap = (
        "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
        "tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,"
    ) if hdr else ""
    return (
        f"{tonemap}fps={rate},scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={width}:{height},setsar=1,format=yuv420p"
    )


def filter_graph(clips, rate, orientation):
    """Build a filter graph that hard-cuts from each clip to the next.

    Inputs 0..n-1 are the normalized clips. The reel loops by cutting from
    the last clip straight back to the first, like every other transition.
    The landscape graph also yields the poster frame.
    """
    ladder = LADDERS[orientation]
    width, height = MASTERS[orientation]
    parts = []
    for index, clip in enumerate(clips):
        parts.append(f"[{index}:v]trim=duration={clip['duration']:.3f},setpts=PTS-STARTPTS,settb=AVTB,fps={rate}[c{index}]")
    labels = "".join(f"[c{index}]" for index in range(len(clips)))
    parts.append(f"{labels}concat=n={len(clips)}:v=1:a=0[joined]")
    total = reel_seconds(clips)
    poster = orientation == "landscape"
    outputs = len(ladder) + int(poster)
    split_labels = "".join(f"[s{index}]" for index in range(outputs))
    parts.append(
        # setpts drops the frame-rate tag; restate it or the encoder assumes
        # 25 fps and duplicates frames to fill the gap.
        f"[joined]trim=duration={total:.3f},setpts=PTS-STARTPTS,fps={rate},split={outputs}{split_labels}"
    )
    for index, rung in enumerate(ladder):
        step = "null" if (rung["width"], rung["height"]) == (width, height) else (
            f"scale={rung['width']}:{rung['height']}:flags=lanczos"
        )
        parts.append(f"[s{index}]{step}[out{index}]")
    if poster:
        parts.append(f"[s{len(ladder)}]trim=end_frame=1[poster]")
    return ";".join(parts), total


def rung_name(cut, rung):
    return f"reel-{cut}-{rung['width']}x{rung['height']}"


def master_playlist(cut, orientation, rate, sizes, seconds):
    """The adaptive master playlist for one cut and orientation.

    `sizes` maps each rung name to its encoded bytes, for AVERAGE-BANDWIDTH.
    The start variant is listed first because Safari begins with it.
    """
    ladder = sorted(
        LADDERS[orientation],
        key=lambda rung: ((rung["width"], rung["height"]) != START_VARIANT[orientation], -rung["width"]),
    )
    fps = dict(STANDARD_RATES).get(rate, 24.0)
    lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for rung in ladder:
        name = rung_name(cut, rung)
        average = max(1, round(sizes[name] * 8 / max(seconds, 0.1)))
        lines.append(
            f"#EXT-X-STREAM-INF:BANDWIDTH={rung['maxrate'] * 1000},AVERAGE-BANDWIDTH={average},"
            f"RESOLUTION={rung['width']}x{rung['height']},FRAME-RATE={fps:.3f},"
            f'CODECS="avc1.{CODEC_LEVELS[rung["level"]]}"'
        )
        lines.append(f"{name}.m3u8")
    return "\n".join(lines) + "\n"
