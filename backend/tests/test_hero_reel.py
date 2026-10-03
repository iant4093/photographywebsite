import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

import test_support  # noqa: F401  (adds backend/functions to sys.path)

import hero_reel
import hero_reel_plan
from hero_reel_plan import PlaylistError


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ALBUM_ID = "22222222-2222-4222-8222-222222222222"


def client_error(code, operation="GetObject"):
    return ClientError({"Error": {"Code": code, "Message": code}}, operation)


def album(album_id=ALBUM_ID, **overrides):
    value = {
        "albumId": album_id,
        "visibility": "public",
        "status": "active",
        "type": "video",
        "createdAt": "2026-09-01T00:00:00Z",
        "images": [
            {"rawKey": f"albums/{album_id}/original/a.mp4", "hlsUrl": f"albums/{album_id}/original/a_hls/a.m3u8"},
        ],
    }
    value.update(overrides)
    return value


class FakeTable:
    def __init__(self, pages=None, item=None):
        self.pages = list(pages or [])
        self.item = item
        self.queries = []
        self.updates = []

    def query(self, **kwargs):
        self.queries.append(kwargs)
        return self.pages.pop(0)

    def get_item(self, **kwargs):
        return {"Item": self.item} if self.item is not None else {}

    def update_item(self, **kwargs):
        self.updates.append(kwargs)
        return {}


class Context:
    def __init__(self, remaining=900_000):
        self.remaining = remaining

    def get_remaining_time_in_millis(self):
        return self.remaining


class InventoryTests(unittest.TestCase):
    def test_only_committed_public_videos_with_safe_hls_keys_are_eligible(self):
        table = FakeTable(pages=[
            {
                "Items": [
                    album(),
                    album(OTHER_ALBUM_ID, mediaStoreVersion=1, images=None, uploadedAt="2026-09-03"),
                    album("33333333-3333-4333-8333-333333333333", visibility="private"),
                    "not-a-dict",
                ],
                "LastEvaluatedKey": {"albumId": "next"},
            },
            {"Items": [album("44444444-4444-4444-8444-444444444444", images=[
                "legacy-string",
                {"rawKey": "albums/44444444-4444-4444-8444-444444444444/x.mp4", "hlsUrl": "albums/elsewhere/x.m3u8"},
                {"rawKey": "albums/44444444-4444-4444-8444-444444444444/y.mp4", "hlsUrl": "albums/44444444-4444-4444-8444-444444444444/y.mp4"},
            ])]},
        ])
        normalized = [{"rawKey": f"albums/{OTHER_ALBUM_ID}/original/b.mp4", "hlsUrl": f"https://media.example.test/albums/{OTHER_ALBUM_ID}/original/b%20c_hls/b.m3u8"}]
        with patch.object(hero_reel, "_table", return_value=table), patch.object(
            hero_reel, "query_album_media", side_effect=[(normalized[:1], {"k": 1}), ([], None)]
        ):
            videos = hero_reel.eligible_videos()

        self.assertEqual([video["albumId"] for video in videos], [ALBUM_ID, OTHER_ALBUM_ID])
        self.assertEqual(videos[1]["hlsKey"], f"albums/{OTHER_ALBUM_ID}/original/b c_hls/b.m3u8")
        self.assertEqual(videos[1]["createdAt"], "2026-09-03")
        self.assertEqual(len(videos[0]["mediaId"]), 24)
        self.assertEqual(table.queries[1]["ExclusiveStartKey"], {"albumId": "next"})
        self.assertEqual(table.queries[0]["IndexName"], "VisibilityCreatedAtIndex")


class StorageTests(unittest.TestCase):
    def s3(self, body=b"data", length=None):
        s3 = Mock()
        s3.get_object.return_value = {"ContentLength": len(body) if length is None else length, "Body": io.BytesIO(body)}
        return s3

    def test_reads_are_bounded_and_missing_objects_become_pending(self):
        with patch.object(hero_reel, "_client", return_value=self.s3(b"abc")):
            self.assertEqual(hero_reel._read_bytes("k", 10), b"abc")
        with patch.object(hero_reel, "_client", return_value=self.s3(b"abc", length=99)), self.assertRaises(PlaylistError):
            hero_reel._read_bytes("k", 10)
        with patch.object(hero_reel, "_client", return_value=self.s3(b"x" * 20, length=0)), self.assertRaises(PlaylistError):
            hero_reel._read_bytes("k", 10)
        s3 = Mock()
        s3.get_object.side_effect = client_error("NoSuchKey")
        with patch.object(hero_reel, "_client", return_value=s3), self.assertRaises(PlaylistError):
            hero_reel._read_bytes("k", 10)
        s3.get_object.side_effect = client_error("SlowDown")
        with patch.object(hero_reel, "_client", return_value=s3), self.assertRaises(ClientError):
            hero_reel._read_bytes("k", 10)

    def test_object_exists_is_a_head_request(self):
        s3 = Mock()
        with patch.object(hero_reel, "_client", return_value=s3):
            self.assertTrue(hero_reel._object_exists("k"))
            s3.head_object.side_effect = client_error("404", "HeadObject")
            self.assertFalse(hero_reel._object_exists("k"))

    def test_renditions_use_cheap_analysis_and_full_resolution_output(self):
        master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5,RESOLUTION=1920x1080\nv_1080.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=960x540\nv_540.m3u8\n"
        media = "#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST\n"
        reads = {
            "albums/a/v_hls/v.m3u8": master.encode(),
            "albums/a/v_hls/v_540.m3u8": media.encode(),
            "albums/a/v_hls/v_1080.m3u8": media.replace("seg", "big").encode(),
        }
        with patch.object(hero_reel, "_read_bytes", side_effect=lambda key, limit: reads[key]):
            loaded = hero_reel.load_renditions({"hlsKey": "albums/a/v_hls/v.m3u8"})
            self.assertFalse(loaded["sameVariant"])
            self.assertEqual(loaded["segments"][0]["key"], "albums/a/v_hls/seg.ts")
            self.assertEqual(loaded["outputSegments"][0]["key"], "albums/a/v_hls/big.ts")
            reads["albums/a/v_hls/v.m3u8"] = media.encode()
            self.assertTrue(hero_reel.load_renditions({"hlsKey": "albums/a/v_hls/v.m3u8"})["sameVariant"])
            reads["albums/a/v_hls/v.m3u8"] = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5,RESOLUTION=3840x2160\nv_1080.m3u8\n".encode()
            single = hero_reel.load_renditions({"hlsKey": "albums/a/v_hls/v.m3u8"})
            self.assertTrue(single["sameVariant"])

    def test_segments_download_once_and_join_within_a_byte_budget(self):
        workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, workspace)
        cache = {}
        with patch.object(hero_reel, "_read_bytes", side_effect=[b"one", b"two"]) as read:
            first = hero_reel.download_segments([{"key": "a"}, {"key": "b"}], workspace, cache)
            again = hero_reel.download_segments([{"key": "b"}], workspace, cache)
        self.assertEqual(read.call_count, 2)
        paths = first.removeprefix("concat:").split("|")
        self.assertEqual(again, f"concat:{paths[1]}")
        with open(paths[0], "rb") as handle:
            self.assertEqual(handle.read(), b"one")
        with patch.object(hero_reel, "MAX_WINDOW_BYTES", 4), self.assertRaises(PlaylistError):
            hero_reel.download_segments([{"key": "a"}, {"key": "b"}], workspace, cache)


class FfmpegTests(unittest.TestCase):
    def test_failures_and_timeouts_become_reason_codes(self):
        with patch.object(hero_reel.subprocess, "run", return_value=SimpleNamespace(returncode=1)):
            with self.assertRaises(hero_reel.ReelError) as raised:
                hero_reel._run_ffmpeg(["-version"], 10)
        self.assertEqual(raised.exception.reason, "ffmpeg_failed")
        with patch.object(hero_reel.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffmpeg", 1)):
            with self.assertRaises(hero_reel.ReelError) as raised:
                hero_reel._run_ffmpeg(["-version"], 10)
        self.assertEqual(raised.exception.reason, "ffmpeg_timeout")

    def test_bundled_binary_path_and_override(self):
        with patch.dict(os.environ, {"FFMPEG_PATH": ""}):
            self.assertTrue(hero_reel.ffmpeg_path().endswith(os.path.join("bin", "ffmpeg")))
        with patch.dict(os.environ, {"FFMPEG_PATH": "/opt/ffmpeg"}):
            self.assertEqual(hero_reel.ffmpeg_path(), "/opt/ffmpeg")

    def test_analysis_reads_the_metadata_file(self):
        workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, workspace)
        metadata = os.path.join(workspace, "m.txt")

        def run(command, **kwargs):
            with open(metadata, "w", encoding="utf-8") as handle:
                handle.write("frame:0 pts:0 pts_time:1.0\nlavfi.scd.score=0\nlavfi.signalstats.YAVG=90\n")
            return SimpleNamespace(returncode=0)

        with patch.object(hero_reel.subprocess, "run", side_effect=run) as runner:
            frames = hero_reel.analyse_window("in.ts", metadata, 30)
        self.assertEqual(frames, [{"t": 1.0, "score": 0.0, "luma": 90.0}])
        self.assertIn("scdet=threshold=100", " ".join(runner.call_args.args[0]))

    def test_encode_normalizes_clips_then_writes_every_rendition_and_poster(self):
        workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, workspace)
        commands = []

        def run(arguments, timeout):
            commands.append(arguments)
            for index, value in enumerate(arguments):
                if value == "-y":
                    with open(arguments[index + 1], "wb") as handle:
                        handle.write(b"x")

        clips = [{"duration": 5.0, "rate": "24"}, {"duration": 4.0, "rate": "24"}]
        with patch.object(hero_reel, "_run_ffmpeg", side_effect=run):
            outputs, poster, seconds, rate = hero_reel.encode_reel(
                clips, [("a.ts", 1.5), ("b.ts", -1)], workspace, hero_reel.time.monotonic() + 600,
            )
        self.assertEqual(len(commands), 3)
        self.assertIn("trim=start=1.500:duration=5.000", " ".join(commands[0]))
        self.assertIn("trim=start=0.000:duration=4.000", " ".join(commands[1]))
        final = commands[2]
        self.assertIn("-filter_complex", final)
        self.assertEqual(final.count("-i"), 3)
        self.assertEqual(sorted(outputs), sorted(item["name"] for item in hero_reel_plan.RENDITIONS))
        self.assertTrue(poster.endswith("poster.jpg"))
        self.assertAlmostEqual(seconds, 9.0 - 2 * hero_reel_plan.CROSSFADE_SECONDS)
        self.assertEqual(rate, "24")
        self.assertIn("-an", final)

        with patch.object(hero_reel, "_run_ffmpeg"), self.assertRaises(hero_reel.ReelError):
            hero_reel.normalize_clip(clips[0], "a.ts", 0, "24", os.path.join(workspace, "none.mp4"), 10)
        with patch.object(hero_reel, "_run_ffmpeg", side_effect=lambda arguments, timeout: None), patch.object(
            hero_reel, "normalize_clip", return_value="n.mp4"
        ), self.assertRaises(hero_reel.ReelError) as raised:
            hero_reel.encode_reel(clips, [("a.ts", 0), ("b.ts", 0)], tempfile.mkdtemp(dir=workspace), hero_reel.time.monotonic() + 60)
        self.assertEqual(raised.exception.reason, "encode_missing_output")
        with patch.object(hero_reel, "_run_ffmpeg", side_effect=run), patch.object(
            hero_reel, "MAX_RENDITION_BYTES", 0
        ), self.assertRaises(hero_reel.ReelError) as raised:
            hero_reel.encode_reel(clips, [("a.ts", 0), ("b.ts", 0)], workspace, hero_reel.time.monotonic() + 60)
        self.assertEqual(raised.exception.reason, "encode_too_large")


def ready_video(media_id, same=True):
    segments = [{"key": f"{media_id}-{i}", "start": i * 10.0, "duration": 10.0} for i in range(2)]
    return {
        "albumId": f"album-{media_id}",
        "mediaId": media_id,
        "hlsKey": f"albums/{media_id}.m3u8",
        "createdAt": "",
        "segments": segments,
        "outputSegments": segments,
        "sameVariant": same,
    }


def calm_frames(seconds=20, rate=24):
    return [{"t": 5 + index / rate, "score": 0.5, "luma": 100.0} for index in range(int(seconds * rate))]


def choppy_frames(seconds=20, rate=24):
    # A cut every two seconds: no shot is long enough for a strict clip.
    return [{"t": index / rate, "score": 20.0 if index % (2 * rate) == 0 else 0.5, "luma": 100.0} for index in range(int(seconds * rate))]


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.workspace)

    def build(self, videos, loaded, frames, context=None):
        downloads = []

        def download(segments, workspace, cache):
            downloads.append(segments)
            return "concat:" + "|".join(segment["key"] for segment in segments)

        def load(video):
            value = loaded.get(video["mediaId"])
            if value is None:
                raise PlaylistError("missing")
            return value

        encoded = {}

        def encode(clips, sources, workspace, deadline):
            encoded["clips"] = clips
            encoded["sources"] = sources
            return {"reel-1920x1080": "a"}, "poster", 55.5, "24"

        with patch.object(hero_reel, "load_renditions", side_effect=load), patch.object(
            hero_reel, "download_segments", side_effect=download
        ), patch.object(hero_reel, "analyse_window", side_effect=lambda source, metadata, timeout: frames(source)), patch.object(
            hero_reel, "encode_reel", side_effect=encode
        ):
            result = hero_reel.build_reel(videos, "seed", context or Context(), self.workspace)
        return result, encoded, downloads

    def test_calm_footage_is_cut_from_analysed_windows(self):
        videos = [{"mediaId": name, "hlsKey": f"{name}.m3u8"} for name in ("one", "two", "late")]
        loaded = {"one": ready_video("one"), "two": ready_video("two", same=False)}
        result, encoded, downloads = self.build(videos, loaded, lambda source: calm_frames())
        self.assertEqual(result["pending"], ["late"])
        self.assertEqual(result["pendingKeys"], ["late.m3u8"])
        self.assertEqual(result["seconds"], 55.5)
        media = {clip["mediaId"] for clip in encoded["clips"]}
        self.assertEqual(media, {"one", "two"})
        # Single-variant videos reuse the analysis file; others fetch output segments.
        self.assertTrue(all(source.startswith("concat:") for source, _ in encoded["sources"]))
        self.assertTrue(all(0 <= offset < 10 for _, offset in encoded["sources"]))
        self.assertGreater(len(downloads), 2)

    def test_fast_cut_edits_fall_back_to_the_steadiest_short_stretches(self):
        videos = [{"mediaId": "edit", "hlsKey": "edit.m3u8"}]
        loaded = {"edit": ready_video("edit")}
        with patch.object(hero_reel, "MIN_REEL_SECONDS", 1.0):
            result, encoded, _ = self.build(videos, loaded, lambda source: choppy_frames())
        self.assertTrue(encoded["clips"])
        self.assertTrue(all(clip["duration"] < hero_reel_plan.MIN_CLIP_SECONDS for clip in encoded["clips"]))
        self.assertEqual(result["pending"], [])

    def test_builds_stop_with_reason_codes(self):
        with self.assertRaises(hero_reel.ReelError) as raised:
            self.build([{"mediaId": "x", "hlsKey": "x"}], {}, lambda source: [])
        self.assertEqual(raised.exception.reason, "no_ready_videos")
        with self.assertRaises(hero_reel.ReelError) as raised:
            self.build([{"mediaId": "edit", "hlsKey": "e"}], {"edit": ready_video("edit")}, lambda source: choppy_frames(3))
        self.assertEqual(raised.exception.reason, "not_enough_footage")
        with self.assertRaises(hero_reel.ReelError) as raised:
            self.build([{"mediaId": "one", "hlsKey": "o"}], {"one": ready_video("one")}, lambda source: calm_frames(), context=Context(300_000))
        self.assertEqual(raised.exception.reason, "not_enough_footage")

    def test_analysis_failures_skip_that_video_and_time_is_reserved_for_encoding(self):
        videos = [{"mediaId": name, "hlsKey": name} for name in ("bad", "good")]
        loaded = {"bad": ready_video("bad"), "good": ready_video("good")}

        def frames(source):
            if "bad-" in source:
                raise hero_reel.ReelError("ffmpeg_failed")
            return calm_frames()

        with patch.object(hero_reel, "MIN_REEL_SECONDS", 1.0):
            result, encoded, _ = self.build(videos, loaded, frames)
        self.assertEqual(len({clip["mediaId"] for clip in encoded["clips"]}), 1)

        context = Context()
        with patch.object(hero_reel, "_remaining_ms", side_effect=[900_000, 100_000]), patch.object(
            hero_reel, "MIN_REEL_SECONDS", 1.0
        ), self.assertRaises(hero_reel.ReelError) as raised:
            self.build([{"mediaId": "one", "hlsKey": "o"}], {"one": ready_video("one")}, lambda source: calm_frames(), context)
        self.assertEqual(raised.exception.reason, "timeout")

    def test_clip_downloads_must_cover_the_clip(self):
        with self.assertRaises(hero_reel.ReelError):
            hero_reel._segments_covering([{"start": 0, "duration": 10}], 20, 25)
        self.assertEqual(hero_reel._remaining_ms(object()), 900_000)

    def test_failed_clip_downloads_stop_the_build(self):
        videos = [{"mediaId": "two", "hlsKey": "t"}]
        loaded = {"two": ready_video("two", same=False)}
        calls = {"count": 0}

        def download(segments, workspace, cache):
            calls["count"] += 1
            if calls["count"] > 1:
                raise PlaylistError("missing")
            return "concat:a"

        with patch.object(hero_reel, "load_renditions", side_effect=lambda video: loaded[video["mediaId"]]), patch.object(
            hero_reel, "download_segments", side_effect=download
        ), patch.object(hero_reel, "analyse_window", return_value=calm_frames()), patch.object(
            hero_reel, "MIN_REEL_SECONDS", 1.0
        ), self.assertRaises(hero_reel.ReelError) as raised:
            hero_reel.build_reel(videos, "seed", Context(), self.workspace)
        self.assertEqual(raised.exception.reason, "clip_download_failed")


RECORD = {
    "version": "a" * 24,
    "mediaIds": ["m1"],
    "duration": "58.2",
    "renditions": [{"key": f"{hero_reel.REEL_PREFIX}{'a' * 24}/reel-1920x1080.mp4", "width": 1920, "height": 1080, "bytes": 10}],
    "posterKey": f"{hero_reel.REEL_PREFIX}{'a' * 24}/poster.jpg",
    "clipCount": 14,
    "sourceCount": 9,
    "pending": [],
    "inputDigest": "digest",
}


class PublishTests(unittest.TestCase):
    def test_reel_files_are_public_immutable_and_described(self):
        workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, workspace)
        outputs = {}
        for rendition in hero_reel_plan.RENDITIONS:
            outputs[rendition["name"]] = os.path.join(workspace, rendition["name"])
            with open(outputs[rendition["name"]], "wb") as handle:
                handle.write(b"12345")
        poster = os.path.join(workspace, "poster.jpg")
        with open(poster, "wb") as handle:
            handle.write(b"jpg")
        s3 = Mock()
        with patch.object(hero_reel, "_client", return_value=s3):
            renditions, poster_key = hero_reel.upload_reel("b" * 24, {"outputs": outputs, "poster": poster})
        self.assertEqual(len(renditions), 3)
        self.assertEqual(renditions[0]["bytes"], 5)
        self.assertTrue(poster_key.endswith("/poster.jpg"))
        for call in s3.put_object.call_args_list:
            self.assertEqual(call.kwargs["Tagging"], "visibility=public")
            self.assertIn("immutable", call.kwargs["CacheControl"])
            self.assertTrue(call.kwargs["Key"].startswith(f"{hero_reel.REEL_PREFIX}{'b' * 24}/"))

    def test_records_describe_the_reel_without_titles(self):
        clips = [{"albumId": "a1", "mediaId": "m1"}, {"albumId": "a1", "mediaId": "m2"}, {"albumId": "a2", "mediaId": "m1"}]
        record = hero_reel._reel_record("v", "d", {"clips": clips, "seconds": 59.4, "rate": "24", "pending": ["p"], "pendingKeys": ["k"]}, [], "poster", "auto")
        self.assertEqual((record["clipCount"], record["sourceCount"]), (3, 2))
        self.assertEqual(record["duration"], "59.4")
        self.assertEqual(record["albumIds"], ["a1", "a2"])

    def test_make_reel_cleans_its_workspace(self):
        seen = {}

        def build(videos, seed, context, workspace):
            seen["workspace"] = workspace
            return {"clips": [{"albumId": "a", "mediaId": "m"}], "seconds": 50, "rate": "24", "pending": [], "pendingKeys": []}

        with patch.object(hero_reel, "build_reel", side_effect=build), patch.object(
            hero_reel, "upload_reel", return_value=([], "poster")
        ):
            record = hero_reel.make_reel([{"albumId": "a", "mediaId": "m", "hlsKey": "k"}], "seed", "auto", Context())
        self.assertEqual(len(record["version"]), 24)
        self.assertFalse(os.path.exists(seen["workspace"]))

    def test_pointer_lists_only_rendition_urls(self):
        document = hero_reel.pointer_document({**RECORD, "publishedAt": "2026-10-01T00:00:00Z"})
        self.assertEqual(document["version"], "a" * 24)
        self.assertEqual(document["duration"], 58.2)
        self.assertNotIn("mediaIds", document)
        self.assertEqual(hero_reel.pointer_document(None), {"schemaVersion": 1, "version": None, "renditions": []})

        s3 = Mock()
        cloudfront = Mock()
        with patch.object(hero_reel, "_client", side_effect=lambda name: {"s3": s3, "cloudfront": cloudfront}[name]), patch.dict(
            os.environ, {"IMAGES_DISTRIBUTION_ID": "EDIST"}
        ):
            hero_reel.write_pointer(RECORD)
        put = s3.put_object.call_args.kwargs
        self.assertEqual(put["Key"], hero_reel.POINTER_KEY)
        self.assertIn("max-age=0", put["CacheControl"])
        self.assertEqual(json.loads(put["Body"])["renditions"][0]["width"], 1920)
        paths = cloudfront.create_invalidation.call_args.kwargs["InvalidationBatch"]["Paths"]
        self.assertEqual(paths, {"Quantity": 1, "Items": [f"/{hero_reel.POINTER_KEY}"]})

    def test_invalidation_is_optional_and_failure_tolerant(self):
        with patch.dict(os.environ, {"IMAGES_DISTRIBUTION_ID": ""}):
            self.assertFalse(hero_reel._invalidate(["/x"], "ref"))
        cloudfront = Mock()
        cloudfront.create_invalidation.side_effect = client_error("Throttling", "CreateInvalidation")
        with patch.object(hero_reel, "_client", return_value=cloudfront), patch.dict(os.environ, {"IMAGES_DISTRIBUTION_ID": "E"}):
            self.assertFalse(hero_reel._invalidate(["/x"], "ref"))

    def test_poster_goes_through_the_still_hero_pipeline(self):
        s3 = Mock()
        s3.put_object.return_value = {"ETag": '"0123456789ABCDEF0123456789ABCDEF"'}
        sqs = Mock()
        with patch.object(hero_reel, "_client", side_effect=lambda name: {"s3": s3, "sqs": sqs}[name]), patch.object(
            hero_reel, "_read_bytes", return_value=b"jpeg"
        ), patch.dict(os.environ, {"HERO_DERIVATIVE_QUEUE_URL": "https://sqs/q"}):
            self.assertTrue(hero_reel.publish_poster(RECORD))
            self.assertEqual(s3.put_object.call_args.kwargs["Key"], "temp-zips/video-hero-pending")
            self.assertEqual(s3.put_object.call_args.kwargs["Tagging"], "visibility=pending")
            message = json.loads(sqs.send_message.call_args.kwargs["MessageBody"])
            self.assertEqual(message, {
                "kind": "hero", "heroType": "video", "sourceKey": "temp-zips/video-hero-pending",
                "version": "0123456789abcdef0123456789abcdef",
            })
            s3.put_object.return_value = {"ETag": '"abc-2"'}
            self.assertFalse(hero_reel.publish_poster(RECORD))
        with patch.dict(os.environ, {"HERO_DERIVATIVE_QUEUE_URL": ""}):
            self.assertFalse(hero_reel.publish_poster(RECORD))

    def test_cleanup_deletes_only_unreferenced_versions(self):
        s3 = Mock()
        prefix = hero_reel.REEL_PREFIX
        s3.list_objects_v2.side_effect = [
            {"CommonPrefixes": [{"Prefix": f"{prefix}keep/"}, {"Prefix": f"{prefix}old/"}, {"Prefix": f"{prefix}empty/"}, {"Prefix": prefix}]},
            {"Contents": [{"Key": f"{prefix}old/reel.mp4"}, {"Key": f"{prefix}old/poster.jpg"}]},
            {"Contents": []},
        ]
        with patch.object(hero_reel, "_client", return_value=s3):
            self.assertEqual(hero_reel.cleanup_versions({"keep", None}), 1)
        deleted = s3.delete_objects.call_args.kwargs["Delete"]["Objects"]
        self.assertEqual({item["Key"] for item in deleted}, {f"{prefix}old/reel.mp4", f"{prefix}old/poster.jpg"})

    def test_versions_with_removed_sources_are_not_kept(self):
        state = {
            "published": {"version": "p", "mediaIds": ["m1"]},
            "previous": {"version": "o", "mediaIds": ["gone"]},
            "draft": {"version": "d", "mediaIds": ["m1", "m2"]},
        }
        self.assertEqual(hero_reel._versions_to_keep(state, {"m1", "m2"}), {"p", "d"})
        self.assertFalse(hero_reel._still_eligible(None, {"m1"}))

    def test_publish_record_keeps_the_previous_reel_for_open_pages(self):
        state = {"published": {"version": "old", "mediaIds": ["m1"]}}
        with patch.object(hero_reel, "write_pointer") as pointer, patch.object(
            hero_reel, "publish_poster", return_value=True
        ), patch.object(hero_reel, "cleanup_versions") as cleanup:
            update, queued = hero_reel.publish_record(state, RECORD, {"m1"})
        self.assertTrue(queued)
        self.assertEqual(update["previous"], {"version": "old", "mediaIds": ["m1"]})
        self.assertIn("publishedAt", update["published"])
        self.assertEqual(cleanup.call_args.args[0], {"a" * 24, "old"})
        pointer.assert_called_once()

        with patch.object(hero_reel, "write_pointer"), patch.object(hero_reel, "publish_poster", return_value=False), patch.object(
            hero_reel, "cleanup_versions"
        ):
            update, _ = hero_reel.publish_record({"published": {"version": "old", "mediaIds": ["gone"]}}, RECORD, {"m1"})
        self.assertIsNone(update["previous"])

    def test_unpublish_writes_an_empty_pointer(self):
        with patch.object(hero_reel, "write_pointer") as pointer, patch.object(hero_reel, "cleanup_versions") as cleanup:
            self.assertEqual(hero_reel.unpublish({"draft": {"version": "d", "mediaIds": []}}, set()), {"published": None, "previous": None})
        pointer.assert_called_once_with(None)
        self.assertEqual(cleanup.call_args.args[0], {"d"})


class StateTests(unittest.TestCase):
    def test_state_updates_set_and_remove_fields(self):
        table = FakeTable()
        with patch.object(hero_reel, "_table", return_value=table):
            hero_reel.save_state({"draft": None, "job": {"status": "ready"}})
            hero_reel.save_state({"job": {}}, condition="#job.#requestId = :rid", condition_values={":rid": "r"})
            hero_reel.save_state({"draft": None})
        first, second, third = table.updates
        self.assertEqual(first["UpdateExpression"], "SET #f1 = :v1 REMOVE #f0")
        self.assertEqual(first["ExpressionAttributeNames"], {"#f0": "draft", "#f1": "job"})
        self.assertEqual(second["ConditionExpression"], "#job.#requestId = :rid")
        self.assertEqual(second["ExpressionAttributeValues"][":rid"], "r")
        self.assertNotIn("ExpressionAttributeValues", third)
        self.assertEqual(FakeTable(item={"a": 1}).get_item()["Item"], {"a": 1})
        with patch.object(hero_reel, "_table", return_value=FakeTable()):
            self.assertEqual(hero_reel.load_state(), {})

    def test_jobs_are_claimed_only_for_the_current_request(self):
        with self.assertRaises(hero_reel.ReelError):
            hero_reel._claim_job({}, "draft", "running")
        with patch.object(hero_reel, "save_state", side_effect=client_error("ConditionalCheckFailedException", "UpdateItem")):
            with self.assertRaises(hero_reel.ReelError) as raised:
                hero_reel._claim_job({"requestId": "r"}, "draft", "running")
        self.assertEqual(raised.exception.reason, "superseded")
        with patch.object(hero_reel, "save_state", side_effect=client_error("Throttling", "UpdateItem")), self.assertRaises(ClientError):
            hero_reel._claim_job({"requestId": "r"}, "draft", "running")
        with patch.object(hero_reel, "save_state") as save:
            self.assertEqual(hero_reel._claim_job({"requestId": "r"}, "draft", "running"), "r")
        self.assertEqual(save.call_args.args[0]["job"]["status"], "running")

    def test_pending_videos_trigger_a_rebuild_once_their_playlist_exists(self):
        self.assertFalse(hero_reel._pending_became_ready(None))
        with patch.object(hero_reel, "_object_exists", side_effect=[False, True]):
            self.assertTrue(hero_reel._pending_became_ready({"pendingKeys": ["a", "b"]}))


VIDEOS = [{"albumId": "a", "mediaId": "m1", "hlsKey": "k1", "createdAt": ""}]


class ActionTests(unittest.TestCase):
    def patches(self, state, videos=VIDEOS):
        saved = []
        stack = [
            patch.object(hero_reel, "load_state", return_value=state),
            patch.object(hero_reel, "eligible_videos", return_value=videos),
            patch.object(hero_reel, "save_state", side_effect=lambda values, **kwargs: saved.append(values)),
        ]
        for item in stack:
            item.start()
            self.addCleanup(item.stop)
        return saved

    def test_unchanged_catalog_is_a_no_op(self):
        digest = hero_reel.input_digest(VIDEOS)
        self.patches({"published": {**RECORD, "mediaIds": ["m1"], "inputDigest": digest}})
        with patch.object(hero_reel, "make_reel") as make:
            self.assertEqual(hero_reel.reconcile(Context()), {"status": "unchanged"})
        make.assert_not_called()

    def test_empty_catalog_unpublishes_once(self):
        saved = self.patches({"published": RECORD}, videos=[])
        with patch.object(hero_reel, "unpublish", return_value={"published": None, "previous": None}):
            self.assertEqual(hero_reel.reconcile(Context())["status"], "unpublished")
        self.assertEqual(saved[0]["auto"]["status"], "unpublished")
        self.patches({}, videos=[])
        self.assertEqual(hero_reel.reconcile(Context()), {"status": "unchanged"})

    def test_new_uploads_rebuild_and_publish(self):
        saved = self.patches({"published": {**RECORD, "inputDigest": "old"}})
        with patch.object(hero_reel, "make_reel", return_value={**RECORD, "version": "b" * 24}) as make, patch.object(
            hero_reel, "publish_record", return_value=({"published": {"version": "b" * 24}}, True)
        ):
            self.assertEqual(hero_reel.reconcile(Context())["status"], "published")
        self.assertEqual(make.call_args.args[2], "auto")
        self.assertEqual(saved[-1]["auto"]["status"], "published")

    def test_removed_sources_take_the_reel_down_before_rebuilding(self):
        saved = self.patches({"published": {**RECORD, "mediaIds": ["gone"]}})
        with patch.object(hero_reel, "unpublish", return_value={"published": None, "previous": None}) as unpublish, patch.object(
            hero_reel, "make_reel", side_effect=hero_reel.ReelError("not_enough_footage")
        ):
            self.assertEqual(hero_reel.reconcile(Context()), {"status": "skipped", "reason": "not_enough_footage"})
        unpublish.assert_called_once()
        self.assertEqual(saved[-1]["auto"]["reason"], "not_enough_footage")

    def test_build_failures_are_recorded_without_triggering_async_retries(self):
        saved = self.patches({})
        with patch.object(hero_reel, "make_reel", side_effect=hero_reel.ReelError("ffmpeg_failed")):
            self.assertEqual(hero_reel.reconcile(Context()), {"status": "skipped", "reason": "ffmpeg_failed"})
        self.assertEqual(saved[-1]["auto"]["reason"], "ffmpeg_failed")

    def test_generate_saves_a_draft_without_publishing(self):
        saved = self.patches({"draft": {"version": "old", "mediaIds": []}})
        with patch.object(hero_reel, "_claim_job", return_value="req"), patch.object(
            hero_reel, "make_reel", return_value=RECORD
        ) as make, patch.object(hero_reel, "cleanup_versions") as cleanup, patch.object(hero_reel, "write_pointer") as pointer:
            self.assertEqual(hero_reel.generate({"requestId": "req"}, Context()), {"status": "ready", "version": RECORD["version"]})
        self.assertEqual(make.call_args.args[1], "draft|req")
        self.assertEqual(saved[-1]["job"]["status"], "ready")
        self.assertEqual(saved[-1]["draft"], RECORD)
        cleanup.assert_called_once()
        pointer.assert_not_called()

    def test_generate_failures_are_reported_on_the_job(self):
        saved = self.patches({})
        with patch.object(hero_reel, "_claim_job", return_value="req"), patch.object(
            hero_reel, "make_reel", side_effect=hero_reel.ReelError("not_enough_footage")
        ):
            self.assertEqual(hero_reel.generate({"requestId": "req"}, Context())["reason"], "not_enough_footage")
        self.assertEqual(saved[-1]["job"]["status"], "failed")

    def test_publish_requires_the_reviewed_draft_and_public_sources(self):
        cases = [
            ({}, "draft_missing"),
            ({"draft": {**RECORD, "version": "c" * 24}}, "draft_missing"),
            ({"draft": {**RECORD, "mediaIds": ["gone"]}}, "sources_changed"),
        ]
        for state, reason in cases:
            with self.subTest(reason=reason):
                saved = self.patches(state)
                with patch.object(hero_reel, "_claim_job", return_value="req"):
                    result = hero_reel.publish({"requestId": "req", "version": RECORD["version"]}, Context())
                self.assertEqual(result, {"status": "failed", "reason": reason})
                self.assertEqual(saved[-1]["job"]["status"], "failed")

    def test_publish_makes_the_draft_live(self):
        saved = self.patches({"draft": RECORD})
        with patch.object(hero_reel, "_claim_job", return_value="req"), patch.object(
            hero_reel, "publish_record", return_value=({"published": RECORD}, True)
        ) as publish:
            result = hero_reel.publish({"requestId": "req", "version": RECORD["version"]}, Context())
        self.assertEqual(result["status"], "published")
        self.assertEqual(publish.call_args.args[1]["mode"], "manual")
        self.assertIsNone(saved[-1]["draft"])
        self.assertEqual(saved[-1]["job"]["status"], "published")

    def test_handler_dispatches_and_contains_failures(self):
        with patch.object(hero_reel, "reconcile", return_value={"status": "unchanged"}) as reconcile:
            self.assertEqual(hero_reel.handler(None, Context()), {"status": "unchanged"})
            reconcile.assert_called_once()
        with patch.object(hero_reel, "generate", return_value={"status": "ready"}):
            self.assertEqual(hero_reel.handler({"action": "generate"}, Context()), {"status": "ready"})
        with patch.object(hero_reel, "publish", return_value={"status": "published"}):
            self.assertEqual(hero_reel.handler({"action": "publish"}, Context()), {"status": "published"})
        self.assertEqual(hero_reel.handler({"action": "explode"}, Context()), {"status": "rejected"})
        with patch.object(hero_reel, "generate", side_effect=hero_reel.ReelError("superseded")):
            self.assertEqual(hero_reel.handler({"action": "generate"}, Context()), {"status": "failed", "reason": "superseded"})
        with patch.object(hero_reel, "generate", side_effect=client_error("Throttling")), patch.object(
            hero_reel, "save_state"
        ) as save, self.assertRaises(ClientError):
            hero_reel.handler({"action": "generate", "requestId": "r"}, Context())
        self.assertEqual(save.call_args.args[0]["job"]["reason"], "service_error")
        with patch.object(hero_reel, "publish", side_effect=client_error("Throttling")), patch.object(
            hero_reel, "save_state", side_effect=client_error("Throttling")
        ), self.assertRaises(ClientError):
            hero_reel.handler({"action": "publish", "requestId": "r"}, Context())


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is not installed")
class RealFfmpegTests(unittest.TestCase):
    """Run the real analysis and encode on tiny synthetic footage."""

    def setUp(self):
        self.workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.workspace)
        patcher = patch.dict(os.environ, {"FFMPEG_PATH": shutil.which("ffmpeg")})
        patcher.start()
        self.addCleanup(patcher.stop)

    def synthetic(self, name, source):
        path = os.path.join(self.workspace, name)
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", source, "-t", "4",
             "-c:v", "libx264", "-preset", "ultrafast", "-f", "mpegts", "-y", path],
            check=True,
        )
        return path

    def test_cut_detection_and_looping_encode(self):
        steady = self.synthetic("steady.ts", "testsrc2=size=640x360:rate=24")
        # Two different colours back to back make one hard cut at two seconds.
        cut = os.path.join(self.workspace, "cut.ts")
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             "-f", "lavfi", "-i", "color=c=navy:size=640x360:rate=24:d=2",
             "-f", "lavfi", "-i", "color=c=orange:size=640x360:rate=24:d=2",
             "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
             "-c:v", "libx264", "-preset", "ultrafast", "-f", "mpegts", "-y", cut],
            check=True,
        )
        frames = hero_reel.analyse_window(cut, os.path.join(self.workspace, "cut.txt"), 60)
        shots = hero_reel_plan.detect_shots(frames, 0.0, 4.0)
        self.assertEqual(len(shots), 2)
        self.assertAlmostEqual(shots[1]["start"], 2.0, delta=0.1)
        self.assertEqual(hero_reel_plan.frame_rate(frames), "24")

        clips = [
            {"duration": 2.0, "rate": "24"},
            {"duration": 1.8, "rate": "24"},
        ]
        portrait = ({**hero_reel_plan.RENDITIONS[2]},)
        with patch.object(hero_reel_plan, "RENDITIONS", portrait), patch.object(hero_reel, "RENDITIONS", portrait):
            outputs, poster, seconds, rate = hero_reel.encode_reel(
                clips, [(f"concat:{steady}", 0.5), (cut, 0.1)], self.workspace, hero_reel.time.monotonic() + 300,
            )
        self.assertTrue(os.path.getsize(poster) > 0)
        output = outputs["reel-608x1080"]
        probe = subprocess.run(["ffmpeg", "-hide_banner", "-i", output], capture_output=True, text=True)
        self.assertIn("608x1080", probe.stderr)
        self.assertNotIn("Audio:", probe.stderr)
        self.assertAlmostEqual(seconds, 3.8 - 2 * hero_reel_plan.CROSSFADE_SECONDS)


if __name__ == "__main__":
    unittest.main()
