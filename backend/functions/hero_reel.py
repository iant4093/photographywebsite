"""Build the silent, looping Videos-page hero reel from public videos.

The worker samples bounded windows of each public video's HLS rendition,
finds calm shots with ffmpeg's scene detector, splices short clips together
with hard cuts, and publishes three MP4 renditions plus a poster frame.

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
import shutil
import subprocess
import tempfile
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
    RENDITIONS,
    PlaylistError,
    candidate_clips,
    choose_variant,
    clip_id,
    clip_filter,
    detect_shots,
    filter_graph,
    frame_rate,
    input_digest,
    output_rate,
    parse_frame_metadata,
    parse_master_playlist,
    parse_media_playlist,
    plan_analysis,
    reel_seconds,
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
MAX_RENDITION_BYTES = 80 * 1024 * 1024
MAX_POSTER_BYTES = 8 * 1024 * 1024
MIN_REEL_SECONDS = 12.0
ENCODE_RESERVE_MS = 240_000
ANALYSIS_RESERVE_MS = 420_000
PENDING_RETRY_SECONDS = 24 * 60 * 60
ACTIVE_JOB_STATUSES = frozenset({"queued", "running"})
CUT_COUNT = 5
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
                "hlsKey": hls_key,
                "createdAt": str(album.get("uploadedAt") or album.get("createdAt") or ""),
            })
    return videos


# ---------------------------------------------------------------- storage

def _read_bytes(key, limit):
    try:
        response = _client("s3").get_object(Bucket=_bucket(), Key=key)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "AccessDenied"}:
            raise PlaylistError("missing") from error
        raise
    if int(response.get("ContentLength") or 0) > limit:
        raise PlaylistError("too_large")
    body = response["Body"].read(limit + 1)
    if len(body) > limit:
        raise PlaylistError("too_large")
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
        path = cache.get(segment["key"])
        if path is None:
            data = _read_bytes(segment["key"], MAX_SEGMENT_BYTES)
            path = os.path.join(workspace, f"segment-{len(cache)}.ts")
            with open(path, "wb") as handle:
                handle.write(data)
            cache[segment["key"]] = path
        total += os.path.getsize(path)
        if total > MAX_WINDOW_BYTES:
            raise PlaylistError("window_too_large")
        paths.append(path)
    return "concat:" + "|".join(paths)


# ---------------------------------------------------------------- ffmpeg

def _run_ffmpeg(arguments, timeout):
    command = [ffmpeg_path(), "-hide_banner", "-nostdin", "-loglevel", "error", *arguments]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=max(5, timeout), check=False)
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


def normalize_clip(clip, source, offset, rate, path, timeout):
    """Cut one clip to the 1080p working format.

    Decoding every 4K source at once inside the joining graph would hold a
    frame queue per input; normalizing first keeps memory flat.
    """
    # Trim inside the graph rather than with -ss: demuxer seeks are unreliable
    # across the timestamp discontinuities of concatenated HLS segments.
    _run_ffmpeg([
        "-i", source,
        "-an", "-sn", "-dn",
        "-vf", (
            f"setpts=PTS-STARTPTS,trim=start={max(0.0, offset):.3f}:duration={clip['duration']:.3f},"
            f"setpts=PTS-STARTPTS,{clip_filter(rate)}"
        ),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p",
        "-map_metadata", "-1", "-y", path,
    ], timeout)
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        raise ReelError("encode_missing_output")
    return path


def encode_reel(clips, sources, workspace, deadline):
    """Normalize each clip, then encode every rendition and the poster frame."""
    rate = output_rate(clips)
    normalized = []
    for index, (clip, (source, offset)) in enumerate(zip(clips, sources)):
        normalized.append(normalize_clip(
            clip, source, offset, rate, os.path.join(workspace, f"normalized-{index}.mp4"),
            max(5, deadline - time.monotonic()),
        ))
    graph, seconds = filter_graph(clips, rate)
    arguments = []
    for path in normalized:
        arguments += ["-i", path]
    arguments += ["-filter_complex", graph]
    gop = "48" if rate in {"24", "24000/1001", "25"} else "60"
    outputs = {}
    for index, rendition in enumerate(RENDITIONS):
        path = os.path.join(workspace, f"{rendition['name']}.mp4")
        outputs[rendition["name"]] = path
        arguments += [
            "-map", f"[out{index}]", "-an",
            "-c:v", "libx264", "-preset", "medium", "-crf", str(rendition["crf"]),
            "-maxrate", rendition["maxrate"], "-bufsize", rendition["bufsize"],
            "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p",
            "-g", gop, "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
            "-movflags", "+faststart", "-tag:v", "avc1", "-map_metadata", "-1", "-y", path,
        ]
    poster = os.path.join(workspace, "poster.jpg")
    arguments += ["-map", "[poster]", "-frames:v", "1", "-q:v", "2", "-map_metadata", "-1", "-y", poster]
    _run_ffmpeg(arguments, max(5, deadline - time.monotonic()))
    for path in [*outputs.values(), poster]:
        if not os.path.isfile(path) or os.path.getsize(path) == 0:
            raise ReelError("encode_missing_output")
        if os.path.getsize(path) > MAX_RENDITION_BYTES:
            raise ReelError("encode_too_large")
    return outputs, poster, seconds, rate


# ---------------------------------------------------------------- build

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
            segments = analysed[clip["mediaId"]]["plan"]["outputSegments"]
            covering = _segments_covering(segments, clip["start"], clip["start"] + clip["duration"])
            planned.append({
                **clip,
                "segments": [{"key": item["key"], "start": item["start"]} for item in covering],
            })
        cuts.append(planned)
    return {
        "cuts": cuts,
        "pending": sorted({video["mediaId"] for video in pending}),
        "pendingKeys": sorted({video["hlsKey"] for video in pending}),
    }


def encode_cut(clips, context, workspace):
    """Fetch the planned segments for one cut and encode it."""
    cache = {}
    sources = []
    for clip in clips:
        try:
            source = download_segments(clip["segments"], workspace, cache)
        except PlaylistError as error:
            raise ReelError("clip_download_failed") from error
        sources.append((source, clip["start"] - clip["segments"][0]["start"]))
    remaining = _remaining_ms(context)
    if remaining < ENCODE_RESERVE_MS:
        raise ReelError("timeout")
    deadline = time.monotonic() + (remaining - 60_000) / 1000
    outputs, poster, seconds, rate = encode_reel(clips, sources, workspace, deadline)
    return {"outputs": outputs, "poster": poster, "seconds": round(seconds, 2), "rate": rate}


def upload_cut(version, cut, result):
    s3 = _client("s3")
    renditions = []
    for rendition in RENDITIONS:
        width, height = rendition["width"], rendition["height"]
        key = f"{REEL_PREFIX}{version}/reel-{cut}-{width}x{height}.mp4"
        path = result["outputs"][rendition["name"]]
        with open(path, "rb") as body:
            s3.put_object(
                Bucket=_bucket(), Key=key, Body=body, ContentType="video/mp4",
                CacheControl="public, max-age=31536000, immutable",
                ServerSideEncryption="AES256", Tagging="visibility=public",
                Metadata={"generator": BUILDER_VERSION},
            )
        renditions.append({"key": key, "width": width, "height": height, "bytes": os.path.getsize(path)})
    poster_key = f"{REEL_PREFIX}{version}/poster-{cut}.jpg"
    with open(result["poster"], "rb") as body:
        s3.put_object(
            Bucket=_bucket(), Key=poster_key, Body=body, ContentType="image/jpeg",
            CacheControl="public, max-age=31536000, immutable",
            ServerSideEncryption="AES256", Tagging="visibility=public",
        )
    return renditions, poster_key


def record_cuts(record):
    """Every cut of a record; single-cut records from before are one cut."""
    if record and record.get("cuts"):
        return record["cuts"]
    if record and record.get("renditions"):
        return [{"renditions": record["renditions"], "posterKey": record.get("posterKey"), "duration": record.get("duration")}]
    return []


def _reel_record(build, mode):
    plans = json.loads(build["plan"])
    cuts = [dict(item) for item in build["results"]]
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

def pointer_document(record):
    if not record:
        return {"schemaVersion": 2, "version": None, "cuts": []}
    return {
        "schemaVersion": 2,
        "version": record["version"],
        "publishedAt": record.get("publishedAt") or _now(),
        "cuts": [
            {
                "duration": float(cut["duration"]),
                "renditions": [
                    {"key": item["key"], "width": int(item["width"]), "height": int(item["height"]), "bytes": int(item["bytes"])}
                    for item in cut["renditions"]
                ],
            }
            for cut in record_cuts(record)
        ],
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


def _invoke_next(context, batch_id, cut):
    _client("lambda").invoke(
        FunctionName=context.invoked_function_arn,
        InvocationType="Event",
        Payload=json.dumps({"action": "build-cut", "batchId": batch_id, "cut": cut}, separators=(",", ":")).encode("utf-8"),
    )


def start_batch(videos, seed, mode, context, request_id=None):
    """Plan every cut, record the batch, and hand cut 0 to the next invocation.

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
        "mode": mode,
        "requestId": request_id,
        "version": version,
        "digest": digest,
        "plan": json.dumps(planned["cuts"], separators=(",", ":")),
        "cutCount": len(planned["cuts"]),
        "results": [],
        "pending": planned["pending"],
        "pendingKeys": planned["pendingKeys"],
        "updatedAt": _now(),
    }})
    _invoke_next(context, batch_id, 0)
    return {"status": "building", "version": version, "cuts": len(planned["cuts"])}


def _append_result(batch_id, cut, result):
    try:
        _table("GALLERY_SETTINGS_TABLE").update_item(
            Key=STATE_KEY,
            UpdateExpression="SET #build.#results = list_append(#build.#results, :result), #build.#updatedAt = :now",
            ConditionExpression="#build.#batchId = :batch AND size(#build.#results) = :cut",
            ExpressionAttributeNames={"#build": "build", "#results": "results", "#updatedAt": "updatedAt", "#batchId": "batchId"},
            ExpressionAttributeValues={":result": [result], ":now": _now(), ":batch": batch_id, ":cut": cut},
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
    """Encode one planned cut, then chain to the next or finish the batch."""
    state = load_state()
    build = state.get("build")
    batch_id = str(event.get("batchId") or "")
    try:
        cut = int(event.get("cut"))
    except (TypeError, ValueError):
        return {"status": "rejected"}
    if not isinstance(build, dict) or build.get("batchId") != batch_id:
        return {"status": "superseded"}
    plans = json.loads(build["plan"])
    done = len(build.get("results") or [])
    if cut < done:
        # A retried invocation: the cut is already encoded.
        return _advance(state, build, context, done)
    if cut != done or cut >= len(plans):
        return {"status": "rejected"}
    workspace = tempfile.mkdtemp(prefix="hero-reel-", dir="/tmp")
    try:
        result = encode_cut(plans[cut], context, workspace)
        renditions, poster_key = upload_cut(build["version"], cut, result)
    except ReelError as error:
        return _fail_batch(build, error.reason)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
    entry = {"renditions": renditions, "posterKey": poster_key, "duration": str(result["seconds"]), "fps": result["rate"]}
    if not _append_result(batch_id, cut, entry):
        return {"status": "superseded"}
    build = {**build, "results": [*(build.get("results") or []), entry]}
    if build.get("mode") == "draft" and build.get("requestId"):
        save_state({"job": _job(build["requestId"], "draft", "running", progress=cut + 1, total=len(plans))})
    return _advance(state, build, context, cut + 1)


def _advance(state, build, context, done):
    plans_total = int(build.get("cutCount") or len(json.loads(build["plan"])))
    if done < plans_total:
        _invoke_next(context, build["batchId"], done)
        return {"status": "building", "cut": done}
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
