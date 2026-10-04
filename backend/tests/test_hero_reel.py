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
    invoked_function_arn = "arn:aws:lambda:us-west-2:123456789012:function:ian-website-HeroReelFunction-abc"

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

    def test_ranged_reads_fetch_exactly_the_segment(self):
        s3 = self.s3(b"abcd")
        with patch.object(hero_reel, "_client", return_value=s3):
            self.assertEqual(hero_reel._read_bytes("k", 10, (100, 4)), b"abcd")
        self.assertEqual(s3.get_object.call_args.kwargs["Range"], "bytes=100-103")
        with patch.object(hero_reel, "_client", return_value=self.s3(b"ab")), self.assertRaises(PlaylistError) as raised:
            hero_reel._read_bytes("k", 10, (0, 4))
        self.assertEqual(str(raised.exception), "short_range")
        with self.assertRaises(PlaylistError):
            hero_reel._read_bytes("k", 10, (0, 11))
        s3 = Mock()
        s3.get_object.side_effect = client_error("InvalidRange")
        with patch.object(hero_reel, "_client", return_value=s3), self.assertRaises(PlaylistError):
            hero_reel._read_bytes("k", 10, (999, 4))

    def test_ranged_segments_of_one_file_download_separately_once_each(self):
        workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, workspace)
        cache = {}
        segments = [{"key": "v.ts", "range": [0, 3]}, {"key": "v.ts", "range": [3, 3]}]
        with patch.object(hero_reel, "_read_bytes", side_effect=[b"one", b"two"]) as read:
            joined = hero_reel.download_segments(segments, workspace, cache)
            again = hero_reel.download_segments(segments[1:], workspace, cache)
        self.assertEqual([call.args for call in read.call_args_list], [
            ("v.ts", hero_reel.MAX_SEGMENT_BYTES, (0, 3)), ("v.ts", hero_reel.MAX_SEGMENT_BYTES, (3, 3)),
        ])
        self.assertEqual(again, "concat:" + joined.removeprefix("concat:").split("|")[1])

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

    def fake_ladder_run(self, commands, playlist=None):
        def run(arguments, timeout, cwd=None):
            commands.append((arguments, cwd))
            for index, value in enumerate(arguments):
                if value == "-hls_segment_filename":
                    media = arguments[index + 1]
                    with open(os.path.join(cwd, media), "wb") as handle:
                        handle.write(b"12345")
                    with open(os.path.join(cwd, media.replace(".mp4", ".m3u8")), "w", encoding="utf-8") as handle:
                        handle.write(playlist or (
                            f'#EXTM3U\n#EXT-X-MAP:URI="{media}",BYTERANGE="9@0"\n#EXTINF:4,\n'
                            f"#EXT-X-BYTERANGE:5@9\n{media}\n#EXT-X-ENDLIST\n"
                        ))
                elif value == "-y" and not arguments[index + 1].endswith(".m3u8"):
                    with open(os.path.join(cwd or "", arguments[index + 1]), "wb") as handle:
                        handle.write(b"x")
        return run

    def test_ladder_encodes_every_rung_as_byte_range_hls_and_a_poster(self):
        workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, workspace)
        commands = []
        clips = [{"duration": 5.0, "rate": "24", "start": 1.0}, {"duration": 4.0, "rate": "24", "start": 0.0}]
        sources = [{"kind": "hls", "path": "concat:a.ts", "offset": 1.5}, {"kind": "hls", "path": "b.ts", "offset": -1}]
        with patch.object(hero_reel, "_run_ffmpeg", side_effect=self.fake_ladder_run(commands)):
            result = hero_reel.encode_ladder(clips, sources, "landscape", 2, workspace, hero_reel.time.monotonic() + 600)
        self.assertEqual(len(commands), 3)
        self.assertIn("trim=start=1.500:duration=5.000", " ".join(commands[0][0]))
        self.assertIn("trim=start=0.000:duration=4.000", " ".join(commands[1][0]))
        self.assertIn("crop=2560:1440", " ".join(commands[0][0]))
        final, cwd = commands[2]
        self.assertEqual(cwd, os.path.join(workspace, "out"))
        self.assertEqual(final.count("-filter_complex"), 1)
        self.assertEqual(final.count("hls"), 4)
        self.assertEqual(final.count("single_file+independent_segments"), 4)
        self.assertIn("expr:gte(t,n_forced*4)", final)
        self.assertEqual(
            sorted(result["files"]),
            ["reel-2-1280x720", "reel-2-1920x1080", "reel-2-2560x1440", "reel-2-960x540"],
        )
        self.assertEqual(result["files"]["reel-2-2560x1440"]["bytes"], 5)
        self.assertTrue(result["poster"].endswith("poster.jpg"))
        self.assertAlmostEqual(result["seconds"], 9.0)
        self.assertIn("reel-2-1280x720.m3u8", result["master"])
        self.assertIn('CODECS="avc1.640032"', result["master"])

        commands.clear()
        with patch.object(hero_reel, "_run_ffmpeg", side_effect=self.fake_ladder_run(commands)):
            portrait = hero_reel.encode_ladder(clips, sources, "portrait", 0, tempfile.mkdtemp(dir=workspace), hero_reel.time.monotonic() + 600)
        self.assertIsNone(portrait["poster"])
        self.assertEqual(sorted(portrait["files"]), ["reel-0-1080x1920", "reel-0-540x960", "reel-0-720x1280"])
        self.assertNotIn("[poster]", commands[-1][0])

    def test_ladder_failures_become_reason_codes(self):
        workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, workspace)
        clips = [{"duration": 5.0, "rate": "24", "start": 0.0}]
        sources = [{"kind": "hls", "path": "a.ts", "offset": 0}]

        def attempt(run, **patches):
            with patch.object(hero_reel, "_run_ffmpeg", side_effect=run), patch.multiple(hero_reel, **patches), \
                    self.assertRaises(hero_reel.ReelError) as raised:
                hero_reel.encode_ladder(clips, sources, "portrait", 0, tempfile.mkdtemp(dir=workspace), hero_reel.time.monotonic() + 60)
            return raised.exception.reason

        self.assertEqual(attempt(lambda arguments, timeout, cwd=None: None, logger=Mock()), "encode_missing_output")
        self.assertEqual(attempt(self.fake_ladder_run([]), MAX_RENDITION_BYTES=0), "encode_too_large")
        for playlist in (
            "#EXTM3U\n#EXTINF:4,\nhttps://elsewhere/x.mp4\n#EXT-X-ENDLIST\n",
            "#EXTM3U\n#EXTINF:4,\nreel-0-540x960.mp4\n",
            '#EXTM3U\n#EXT-X-MAP:URI="../other.mp4"\n#EXTINF:4,\nreel-0-540x960.mp4\n#EXT-X-ENDLIST\n',
        ):
            run = self.fake_ladder_run([], playlist=playlist)
            with patch.object(hero_reel, "_run_ffmpeg", side_effect=run), self.assertRaises(hero_reel.ReelError) as raised:
                hero_reel.encode_ladder(clips, sources, "portrait", 0, tempfile.mkdtemp(dir=workspace), hero_reel.time.monotonic() + 60)
            self.assertEqual(raised.exception.reason, "encode_bad_playlist")

        def no_poster(arguments, timeout, cwd=None):
            self.fake_ladder_run([])(arguments, timeout, cwd)
            if cwd:
                os.remove(os.path.join(cwd, "poster.jpg"))

        with patch.object(hero_reel, "_run_ffmpeg", side_effect=no_poster), self.assertRaises(hero_reel.ReelError) as raised:
            hero_reel.encode_ladder(clips, sources, "landscape", 0, tempfile.mkdtemp(dir=workspace), hero_reel.time.monotonic() + 60)
        self.assertEqual(raised.exception.reason, "encode_missing_output")
        with patch.object(hero_reel, "_run_ffmpeg"), self.assertRaises(hero_reel.ReelError):
            hero_reel.normalize_clip(clips[0], sources[0], "24", "portrait", os.path.join(workspace, "none.mp4"), 10)

    def test_originals_seek_accurately_over_loopback_and_hdr_is_tone_mapped(self):
        workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, workspace)
        commands = []

        def run(arguments, timeout, cwd=None):
            commands.append(arguments)
            with open(arguments[-1], "wb") as handle:
                handle.write(b"x")

        clip = {"start": 12.25, "duration": 4.0}
        source = {"kind": "original", "url": "http://127.0.0.1:9/source/t", "hdr": True}
        with patch.object(hero_reel, "_run_ffmpeg", side_effect=run):
            hero_reel.normalize_clip(clip, source, "24", "portrait", os.path.join(workspace, "n.mp4"), 30)
            hero_reel.normalize_clip(clip, {**source, "hdr": False}, "24", "landscape", os.path.join(workspace, "m.mp4"), 30)
        command = commands[0]
        self.assertLess(command.index("-ss"), command.index("-i"))
        self.assertEqual(command[command.index("-ss") + 1], "12.250")
        self.assertEqual(command[command.index("-t") + 1], "4.200")
        graph = command[command.index("-vf") + 1]
        self.assertIn("tonemap=hable", graph)
        self.assertIn("crop=1080:1920", graph)
        self.assertNotIn("trim=", graph)
        self.assertNotIn("tonemap", commands[1][commands[1].index("-vf") + 1])

    def test_probe_reads_the_original_stream_header(self):
        header = (
            "Input #0, mov,mp4, from 'http://127.0.0.1/source/t':\n"
            "  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), "
            "yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 3840x2160, 120000 kb/s, 23.98 fps\n"
            "At least one output file must be specified\n"
        )
        with patch.object(hero_reel.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr=header.encode())) as runner:
            self.assertEqual(hero_reel.probe_original("http://127.0.0.1/source/t", 30), {"hdr": True, "width": 3840, "height": 2160})
        self.assertNotIn("-tls_verify", runner.call_args.args[0])
        sdr = header.replace("arib-std-b67", "bt709").replace("3840x2160", "1920x1080")
        with patch.object(hero_reel.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr=sdr.encode())):
            self.assertEqual(hero_reel.probe_original("u", 30), {"hdr": False, "width": 1920, "height": 1080})
        with patch.object(hero_reel.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr=b"Server returned 404 Not Found")):
            self.assertIsNone(hero_reel.probe_original("u", 30))
        with patch.object(hero_reel.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffmpeg", 1)):
            self.assertIsNone(hero_reel.probe_original("u", 30))


class FakeS3Objects:
    def __init__(self, objects):
        self.objects = objects
        self.ranges = []

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise client_error("404", "HeadObject")
        return {"ContentLength": len(self.objects[Key])}

    def get_object(self, Bucket, Key, Range):
        self.ranges.append(Range)
        start, end = (int(value) for value in Range.removeprefix("bytes=").split("-"))
        return {"Body": io.BytesIO(self.objects[Key][start:end + 1])}


class SourceServerTests(unittest.TestCase):
    """The loopback endpoint ffmpeg reads originals through."""

    def setUp(self):
        self.s3 = FakeS3Objects({"albums/a/original/v.mov": bytes(range(256)) * 40})
        for item in (
            patch.object(hero_reel, "_client", return_value=self.s3),
            patch.dict(os.environ, {"IMAGES_BUCKET": "bucket"}),
            patch.object(hero_reel, "SOURCE_BLOCK_BYTES", 1000),
        ):
            item.start()
            self.addCleanup(item.stop)

    def fetch(self, url, method="GET", headers=None):
        import urllib.error
        import urllib.request

        request = urllib.request.Request(url, method=method, headers=headers or {})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=10) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), b""

    def test_only_registered_keys_are_served_with_byte_ranges(self):
        data = self.s3.objects["albums/a/original/v.mov"]
        with hero_reel.SourceServer() as server:
            url = server.register("albums/a/original/v.mov")
            self.assertTrue(url.startswith("http://127.0.0.1:"))
            status, headers, body = self.fetch(url, headers={"Range": "bytes=100-2599"})
            self.assertEqual((status, body), (206, data[100:2600]))
            self.assertEqual(headers["Content-Range"], f"bytes 100-2599/{len(data)}")
            # Large ranges are fetched from S3 in bounded blocks.
            self.assertEqual(self.s3.ranges, ["bytes=100-1099", "bytes=1100-2099", "bytes=2100-2599"])
            status, headers, body = self.fetch(url, headers={"Range": "bytes=10000-"})
            self.assertEqual((status, body), (206, data[10000:]))
            status, headers, body = self.fetch(url)
            self.assertEqual((status, len(body), headers["Accept-Ranges"]), (200, len(data), "bytes"))
            status, headers, body = self.fetch(url, method="HEAD")
            self.assertEqual((status, headers["Content-Length"], body), (200, str(len(data)), b""))
            self.assertEqual(self.fetch(url, headers={"Range": "bytes=999999-"})[0], 416)
            self.assertEqual(self.fetch(url.rsplit("/", 1)[0] + "/unknown")[0], 404)
            self.assertEqual(self.fetch(server.register("albums/a/original/missing.mov"))[0], 404)


def ready_video(media_id, same=True, segments=2):
    segments = [{"key": f"{media_id}-{i}", "start": i * 10.0, "duration": 10.0} for i in range(segments)]
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


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.workspace)

    def plan(self, videos, loaded, frames, context=None):
        downloads = []

        def download(segments, workspace, cache):
            downloads.append(segments)
            return "concat:" + "|".join(segment["key"] for segment in segments)

        def load(video):
            value = loaded.get(video["mediaId"])
            if value is None:
                raise PlaylistError("missing")
            return value

        with patch.object(hero_reel, "load_renditions", side_effect=load), patch.object(
            hero_reel, "download_segments", side_effect=download
        ), patch.object(hero_reel, "analyse_window", side_effect=lambda source, metadata, timeout: frames(source)):
            planned = hero_reel.plan_cuts(videos, "seed", context or Context(), self.workspace)
        return planned, downloads

    def test_one_analysis_plans_several_distinct_cuts(self):
        names = [f"v{index}" for index in range(8)]
        videos = [{"mediaId": name, "hlsKey": f"{name}.m3u8"} for name in names + ["late"]]
        loaded = {name: ready_video(name, segments=6) for name in names}
        # A single-file (byte-range) rendition.
        for index, segment in enumerate(loaded["v0"]["segments"]):
            segment["range"] = [index * 100, 100]
        with patch.object(hero_reel_plan, "TARGET_SECONDS", 20.0):
            planned, downloads = self.plan(videos, loaded, lambda source: calm_frames(60))
        ranged = [clip for cut in planned["cuts"] for clip in cut if clip["mediaId"] == "v0"]
        self.assertTrue(ranged and all("range" in segment for clip in ranged for segment in clip["segments"]))
        others = [clip for cut in planned["cuts"] for clip in cut if clip["mediaId"] != "v0"]
        self.assertTrue(all("range" not in segment for clip in others for segment in clip["segments"]))
        cuts = planned["cuts"]
        self.assertEqual(len(cuts), hero_reel.CUT_COUNT)
        self.assertEqual(planned["pending"], ["late"])
        self.assertEqual(planned["pendingKeys"], ["late.m3u8"])
        signatures = [tuple(sorted(hero_reel_plan.clip_id(clip) for clip in cut)) for cut in cuts]
        self.assertEqual(len(set(signatures)), hero_reel.CUT_COUNT)
        first, second = set(signatures[0]), set(signatures[1])
        self.assertFalse(first & second, "later cuts prefer clips earlier cuts did not use")
        for clip in cuts[0]:
            self.assertTrue(clip["segments"])
            self.assertLessEqual(clip["segments"][0]["start"], clip["start"])
        # Analysis ran once per video, not once per cut.
        self.assertEqual(len(downloads), len(names))

    def test_fast_cut_edits_fall_back_to_the_steadiest_short_stretches(self):
        videos = [{"mediaId": "edit", "hlsKey": "edit.m3u8"}]
        with patch.object(hero_reel, "MIN_REEL_SECONDS", 1.0):
            planned, _ = self.plan(videos, {"edit": ready_video("edit")}, lambda source: choppy_frames())
        clips = planned["cuts"][0]
        self.assertTrue(clips)
        self.assertTrue(all(clip["duration"] < hero_reel_plan.MIN_CLIP_SECONDS for clip in clips))

    def test_fewer_cuts_when_footage_runs_out(self):
        videos = [{"mediaId": "one", "hlsKey": "o"}]
        with patch.object(hero_reel, "MIN_REEL_SECONDS", 4.0), patch.object(hero_reel_plan, "TARGET_SECONDS", 4.0):
            planned, _ = self.plan(videos, {"one": ready_video("one")}, lambda source: calm_frames(12))
        self.assertGreaterEqual(len(planned["cuts"]), 1)
        self.assertLessEqual(len(planned["cuts"]), hero_reel.CUT_COUNT)

    def test_planning_stops_with_reason_codes(self):
        with self.assertRaises(hero_reel.ReelError) as raised:
            self.plan([{"mediaId": "x", "hlsKey": "x"}], {}, lambda source: [])
        self.assertEqual(raised.exception.reason, "no_ready_videos")
        with self.assertRaises(hero_reel.ReelError) as raised:
            self.plan([{"mediaId": "edit", "hlsKey": "e"}], {"edit": ready_video("edit")}, lambda source: choppy_frames(3))
        self.assertEqual(raised.exception.reason, "not_enough_footage")
        with self.assertRaises(hero_reel.ReelError) as raised:
            self.plan([{"mediaId": "one", "hlsKey": "o"}], {"one": ready_video("one")}, lambda source: calm_frames(), context=Context(300_000))
        self.assertEqual(raised.exception.reason, "not_enough_footage")

    def test_analysis_failures_skip_that_video(self):
        videos = [{"mediaId": name, "hlsKey": name} for name in ("bad", "good")]
        loaded = {"bad": ready_video("bad"), "good": ready_video("good")}

        def frames(source):
            if "bad-" in source:
                raise hero_reel.ReelError("ffmpeg_failed")
            return calm_frames()

        with patch.object(hero_reel, "MIN_REEL_SECONDS", 1.0):
            planned, _ = self.plan(videos, loaded, frames)
        self.assertEqual({clip["mediaId"] for cut in planned["cuts"] for clip in cut}, {"good"})

    def test_clip_downloads_must_cover_the_clip(self):
        with self.assertRaises(hero_reel.ReelError):
            hero_reel._segments_covering([{"start": 0, "duration": 10}], 20, 25)
        self.assertEqual(hero_reel._remaining_ms(object()), 900_000)


PLANNED = [
    {"albumId": "a", "mediaId": "m1", "shot": "0.0", "start": 12.5, "duration": 4.0, "rate": "24",
     "rawKey": "albums/a/original/m1.mov", "segments": [{"key": "s1", "start": 10.0}]},
    {"albumId": "a", "mediaId": "m2", "shot": "1.0", "start": 3.0, "duration": 4.0, "rate": "24",
     "rawKey": "albums/a/original/m2.mov", "segments": [{"key": "s2", "start": 0.0}, {"key": "s3", "start": 10.0}]},
    {"albumId": "a", "mediaId": "m1", "shot": "0.1", "start": 30.0, "duration": 4.0, "rate": "24",
     "rawKey": "albums/a/original/m1.mov", "segments": [{"key": "s4", "start": 30.0}]},
]


class EncodeStepTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.workspace)

    def server(self):
        server = Mock()
        server.register.side_effect = lambda key: f"http://127.0.0.1:1/source/{key.rsplit('/', 1)[-1]}"
        return server

    def test_clips_come_from_originals_probed_once_each(self):
        server = self.server()
        with patch.object(hero_reel, "probe_original", return_value={"hdr": True, "width": 3840, "height": 2160}) as probe, patch.object(
            hero_reel, "download_segments"
        ) as download:
            sources = hero_reel.clip_sources(PLANNED, server, self.workspace, hero_reel.time.monotonic() + 600)
        self.assertEqual([source["kind"] for source in sources], ["original"] * 3)
        self.assertEqual(sources[0]["url"], sources[2]["url"])
        self.assertTrue(sources[1]["hdr"])
        self.assertEqual(probe.call_count, 2)
        download.assert_not_called()

    def test_unreadable_originals_fall_back_to_hls_segments(self):
        server = self.server()
        legacy = [{key: value for key, value in clip.items() if key != "rawKey"} for clip in PLANNED[:1]]
        with patch.object(hero_reel, "probe_original", side_effect=lambda url, timeout: None if "m2" in url else {"hdr": False}), patch.object(
            hero_reel, "download_segments", side_effect=lambda segments, workspace, cache: "concat:" + segments[0]["key"]
        ):
            sources = hero_reel.clip_sources([*PLANNED, *legacy], server, self.workspace, hero_reel.time.monotonic() + 600)
        self.assertEqual([source["kind"] for source in sources], ["original", "hls", "original", "hls"])
        self.assertEqual((sources[1]["path"], sources[1]["offset"]), ("concat:s2", 3.0))
        self.assertEqual((sources[3]["path"], sources[3]["offset"]), ("concat:s1", 2.5))
        with patch.object(hero_reel, "probe_original", return_value=None), patch.object(
            hero_reel, "download_segments", side_effect=PlaylistError("missing")
        ), self.assertRaises(hero_reel.ReelError) as raised:
            hero_reel.clip_sources(PLANNED, server, self.workspace, hero_reel.time.monotonic() + 600)
        self.assertEqual(raised.exception.reason, "clip_download_failed")

    def test_a_step_serves_originals_only_while_it_encodes(self):
        entered = []

        class Server:
            def __enter__(self):
                entered.append("in")
                return self

            def __exit__(self, *exc):
                entered.append("out")

        with patch.object(hero_reel, "SourceServer", Server), patch.object(
            hero_reel, "clip_sources", return_value=["s"]
        ) as sources, patch.object(hero_reel, "encode_ladder", return_value={"files": {}}) as ladder:
            self.assertEqual(hero_reel.encode_step(PLANNED, "portrait", 1, Context(), self.workspace), {"files": {}})
        self.assertEqual(entered, ["in", "out"])
        self.assertIsInstance(sources.call_args.args[1], Server)
        self.assertEqual(ladder.call_args.args[1:5], (["s"], "portrait", 1, self.workspace))
        with self.assertRaises(hero_reel.ReelError) as raised:
            hero_reel.encode_step(PLANNED, "portrait", 1, Context(100_000), self.workspace)
        self.assertEqual(raised.exception.reason, "timeout")


VERSION_A = "a" * 24
FOLDER = f"{hero_reel.REEL_PREFIX}{VERSION_A}/"


def step_entry(cut, orientation, **extra):
    rungs = [{"width": rung["width"], "height": rung["height"], "bytes": 10} for rung in hero_reel_plan.LADDERS[orientation]]
    entry = {"cut": cut, "orientation": orientation, "master": f"{FOLDER}reel-{cut}-{orientation}.m3u8",
             "rungs": rungs, "duration": "58.2", "fps": "24"}
    if orientation == "landscape":
        entry["posterKey"] = f"{FOLDER}poster-{cut}.jpg"
    return {**entry, **extra}


def steps(cuts):
    return [step_entry(cut, orientation) for cut in range(cuts) for orientation in hero_reel_plan.ORIENTATIONS]


CUT = hero_reel._cuts_from_steps(steps(1))[0]
LEGACY_CUT = {
    "renditions": [{"key": f"{FOLDER}reel-0-1920x1080.mp4", "width": 1920, "height": 1080, "bytes": 10}],
    "posterKey": f"{FOLDER}poster-0.jpg",
    "duration": "58.2",
    "fps": "24",
}
RECORD = {
    "version": VERSION_A,
    "mediaIds": ["m1"],
    "duration": "58.2",
    "cuts": [CUT, {**CUT, "duration": "59.0"}],
    "posterKey": CUT["posterKey"],
    "clipCount": 14,
    "sourceCount": 9,
    "pending": [],
    "inputDigest": "digest",
}


class PublishTests(unittest.TestCase):
    def test_step_files_are_public_immutable_and_the_master_goes_last(self):
        workspace = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, workspace)
        files = {}
        for rung in hero_reel_plan.LADDERS["landscape"]:
            name = hero_reel_plan.rung_name(3, rung)
            files[name] = {"media": os.path.join(workspace, f"{name}.mp4"), "playlist": os.path.join(workspace, f"{name}.m3u8"),
                           "width": rung["width"], "height": rung["height"], "bytes": 5}
            for path in (files[name]["media"], files[name]["playlist"]):
                with open(path, "wb") as handle:
                    handle.write(b"12345")
        poster = os.path.join(workspace, "poster.jpg")
        with open(poster, "wb") as handle:
            handle.write(b"jpg")
        s3 = Mock()
        result = {"files": files, "master": "#EXTM3U\n", "poster": poster, "seconds": 59.456, "rate": "24"}
        with patch.object(hero_reel, "_client", return_value=s3):
            entry = hero_reel.upload_step("b" * 24, 3, "landscape", result)
            portrait = hero_reel.upload_step("b" * 24, 3, "portrait", {**result, "files": {}, "poster": None})
        keys = [call.kwargs["Key"].rsplit("/", 1)[1] for call in s3.put_object.call_args_list]
        self.assertEqual(keys[:2], ["reel-3-2560x1440.mp4", "reel-3-2560x1440.m3u8"])
        self.assertEqual(keys[8:10], ["reel-3-landscape.m3u8", "poster-3.jpg"])
        self.assertEqual(entry["master"], f"{hero_reel.REEL_PREFIX}{'b' * 24}/reel-3-landscape.m3u8")
        self.assertEqual((entry["cut"], entry["orientation"], entry["duration"]), (3, "landscape", "59.46"))
        self.assertTrue(entry["posterKey"].endswith("/poster-3.jpg"))
        self.assertEqual(entry["rungs"][0], {"width": 2560, "height": 1440, "bytes": 5})
        self.assertNotIn("posterKey", portrait)
        types = {call.kwargs["Key"].rsplit(".", 1)[1]: call.kwargs["ContentType"] for call in s3.put_object.call_args_list}
        self.assertEqual(types, {"mp4": "video/mp4", "m3u8": "application/vnd.apple.mpegurl", "jpg": "image/jpeg"})
        for call in s3.put_object.call_args_list:
            self.assertEqual(call.kwargs["Tagging"], "visibility=public")
            self.assertIn("immutable", call.kwargs["CacheControl"])

    def test_records_pair_each_cuts_steps_without_titles(self):
        build = {
            "version": VERSION_A,
            "digest": "d",
            "plan": json.dumps([
                [{"albumId": "a1", "mediaId": "m1"}, {"albumId": "a1", "mediaId": "m2"}],
                [{"albumId": "a2", "mediaId": "m3"}, {"albumId": "a2", "mediaId": "m3"}],
                [{"albumId": "a9", "mediaId": "never-encoded"}],
            ]),
            # Cut 2 only has its landscape half: it is not part of the record.
            "results": [*steps(2), step_entry(2, "landscape")],
            "pending": ["p"],
            "pendingKeys": ["k"],
        }
        record = hero_reel._reel_record(build, "auto")
        self.assertEqual(len(record["cuts"]), 2)
        self.assertEqual(record["cuts"][1]["portrait"]["master"], f"{FOLDER}reel-1-portrait.m3u8")
        self.assertEqual(record["mediaIds"], ["m1", "m2", "m3"])
        self.assertEqual(record["albumIds"], ["a1", "a2"])
        self.assertEqual((record["clipCount"], record["sourceCount"]), (2, 3))
        self.assertEqual(record["posterKey"], f"{FOLDER}poster-0.jpg")
        self.assertEqual(record["duration"], "58.2")

    def test_older_single_reel_records_read_as_one_cut(self):
        legacy = {"renditions": LEGACY_CUT["renditions"], "posterKey": "p", "duration": "40"}
        self.assertEqual(hero_reel.record_cuts(legacy), [{"renditions": LEGACY_CUT["renditions"], "posterKey": "p", "duration": "40"}])
        self.assertEqual(hero_reel.record_cuts(None), [])
        self.assertEqual(hero_reel.record_cuts(RECORD), RECORD["cuts"])

    def test_pointer_lists_each_cuts_streams_or_older_renditions(self):
        document = hero_reel.pointer_document({**RECORD, "publishedAt": "2026-10-01T00:00:00Z"})
        self.assertEqual(document["schemaVersion"], 3)
        self.assertEqual(document["version"], VERSION_A)
        self.assertEqual([cut["duration"] for cut in document["cuts"]], [58.2, 59.0])
        self.assertEqual(document["cuts"][0]["streams"], {
            "landscape": {"key": f"{FOLDER}reel-0-landscape.m3u8", "maxWidth": 2560, "maxHeight": 1440},
            "portrait": {"key": f"{FOLDER}reel-0-portrait.m3u8", "maxWidth": 1080, "maxHeight": 1920},
        })
        self.assertNotIn("mediaIds", document)
        older = hero_reel.pointer_document({**RECORD, "cuts": [LEGACY_CUT]})
        self.assertEqual(older["cuts"][0], {"duration": 58.2, "renditions": LEGACY_CUT["renditions"]})
        self.assertEqual(hero_reel.pointer_document(None), {"schemaVersion": 3, "version": None, "cuts": []})

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
        with patch.object(hero_reel, "start_batch") as start:
            self.assertEqual(hero_reel.reconcile(Context()), {"status": "unchanged"})
        start.assert_not_called()

    def test_a_running_batch_is_never_interrupted_by_the_schedule(self):
        self.patches({"build": {"batchId": "b", "updatedAt": hero_reel._now()}})
        with patch.object(hero_reel, "start_batch") as start:
            self.assertEqual(hero_reel.reconcile(Context()), {"status": "busy"})
        start.assert_not_called()
        self.assertFalse(hero_reel._build_active({"build": {"updatedAt": "2000-01-01T00:00:00Z"}}))
        self.assertFalse(hero_reel._build_active({}))

    def test_empty_catalog_unpublishes_once(self):
        saved = self.patches({"published": RECORD}, videos=[])
        with patch.object(hero_reel, "unpublish", return_value={"published": None, "previous": None}):
            self.assertEqual(hero_reel.reconcile(Context())["status"], "unpublished")
        self.assertEqual(saved[0]["auto"]["status"], "unpublished")
        self.patches({}, videos=[])
        self.assertEqual(hero_reel.reconcile(Context()), {"status": "unchanged"})

    def test_new_uploads_start_an_automatic_batch(self):
        self.patches({"published": {**RECORD, "inputDigest": "old"}})
        with patch.object(hero_reel, "start_batch", return_value={"status": "building"}) as start:
            self.assertEqual(hero_reel.reconcile(Context())["status"], "building")
        self.assertEqual(start.call_args.args[2], "auto")
        self.assertEqual(start.call_args.args[1], hero_reel.input_digest(VIDEOS))

    def test_removed_sources_take_the_reel_down_before_rebuilding(self):
        saved = self.patches({"published": {**RECORD, "mediaIds": ["gone"]}})
        with patch.object(hero_reel, "unpublish", return_value={"published": None, "previous": None}) as unpublish, patch.object(
            hero_reel, "start_batch", side_effect=hero_reel.ReelError("not_enough_footage")
        ):
            self.assertEqual(hero_reel.reconcile(Context()), {"status": "skipped", "reason": "not_enough_footage"})
        unpublish.assert_called_once()
        self.assertEqual(saved[-1]["auto"]["reason"], "not_enough_footage")

    def test_generate_starts_a_draft_batch(self):
        self.patches({})
        with patch.object(hero_reel, "_claim_job", return_value="req") as claim, patch.object(
            hero_reel, "start_batch", return_value={"status": "building"}
        ) as start:
            self.assertEqual(hero_reel.generate({"requestId": "req"}, Context()), {"status": "building"})
        self.assertEqual(start.call_args.args[1:3], ("draft|req", "draft"))
        self.assertEqual(start.call_args.kwargs["request_id"], "req")
        self.assertEqual(claim.call_args.kwargs["total"], hero_reel.CUT_COUNT)

    def test_generate_failures_are_reported_on_the_job(self):
        saved = self.patches({})
        with patch.object(hero_reel, "_claim_job", return_value="req"), patch.object(
            hero_reel, "start_batch", side_effect=hero_reel.ReelError("not_enough_footage")
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
        with patch.object(hero_reel, "build_cut", return_value={"status": "building"}):
            self.assertEqual(hero_reel.handler({"action": "build-cut"}, Context()), {"status": "building"})
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


def batch(mode="draft", results=(), cuts=3):
    return {
        "batchId": "batch",
        "builder": hero_reel_plan.BUILDER_VERSION,
        "mode": mode,
        "requestId": "req" if mode == "draft" else None,
        "version": VERSION_A,
        "digest": "digest",
        "plan": json.dumps([[{"albumId": "a", "mediaId": "m1", "start": 1.0, "duration": 4.0, "segments": [{"key": "s", "start": 0.0}]}]] * cuts),
        "cutCount": cuts,
        "stepCount": cuts * 2,
        "results": list(results),
        "pending": [],
        "pendingKeys": [],
        "updatedAt": "2026-10-03T00:00:00Z",
    }


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.saved = []
        self.lambda_client = Mock()
        for item in (
            patch.object(hero_reel, "save_state", side_effect=lambda values, **kwargs: self.saved.append(values)),
            patch.object(hero_reel, "_client", side_effect=lambda name: self.lambda_client),
            patch.object(hero_reel, "eligible_videos", return_value=VIDEOS),
        ):
            item.start()
            self.addCleanup(item.stop)

    def invoked(self):
        return [json.loads(call.kwargs["Payload"]) for call in self.lambda_client.invoke.call_args_list]

    def test_starting_a_batch_plans_every_cut_and_chains_to_the_first_step(self):
        planned = {"cuts": [[{"mediaId": "m1", "start": 1.5}]] * 4, "pending": ["p"], "pendingKeys": ["k"]}
        with patch.object(hero_reel, "plan_cuts", return_value=planned):
            result = hero_reel.start_batch(VIDEOS, "seed", "auto", Context())
        self.assertEqual(result["cuts"], 4)
        build = self.saved[-1]["build"]
        self.assertEqual(build["mode"], "auto")
        self.assertEqual((build["cutCount"], build["stepCount"]), (4, 8))
        self.assertEqual(build["builder"], hero_reel_plan.BUILDER_VERSION)
        self.assertEqual(json.loads(build["plan"])[0][0]["start"], 1.5)
        self.assertEqual(build["results"], [])
        self.assertEqual(self.invoked(), [{"action": "build-cut", "batchId": build["batchId"], "step": 0}])
        call = self.lambda_client.invoke.call_args.kwargs
        self.assertEqual(call["InvocationType"], "Event")
        self.assertEqual(call["FunctionName"], Context.invoked_function_arn)

    def run_step(self, state, event, appended=True):
        def upload(version, cut, orientation, result):
            return step_entry(cut, orientation, duration="59.5")

        with patch.object(hero_reel, "load_state", return_value=state), patch.object(
            hero_reel, "encode_step", return_value={"files": {}, "poster": None, "seconds": 59.5, "rate": "24"}
        ) as encode, patch.object(hero_reel, "upload_step", side_effect=upload), patch.object(
            hero_reel, "_append_result", return_value=appended
        ) as append:
            result = hero_reel.build_cut(event, Context())
        return result, encode, append

    def test_each_step_encodes_one_orientation_once_then_chains_to_the_next(self):
        result, encode, append = self.run_step({"build": batch()}, {"batchId": "batch", "step": 0})
        self.assertEqual(result, {"status": "building", "step": 1})
        encode.assert_called_once()
        self.assertEqual(encode.call_args.args[1:3], ("landscape", 0))
        self.assertEqual(append.call_args.args[1], 0)
        self.assertEqual(append.call_args.args[2]["duration"], "59.5")
        self.assertEqual(self.invoked(), [{"action": "build-cut", "batchId": "batch", "step": 1}])
        # Progress counts whole cuts.
        self.assertEqual(self.saved[-1]["job"]["progress"], 0)
        self.assertEqual(self.saved[-1]["job"]["total"], 3)
        result, encode, _ = self.run_step({"build": batch(results=steps(1)[:1])}, {"batchId": "batch", "step": 1})
        self.assertEqual(encode.call_args.args[1:3], ("portrait", 0))
        self.assertEqual(self.saved[-1]["job"]["progress"], 1)

    def test_retried_or_stale_invocations_do_not_re_encode(self):
        result, encode, _ = self.run_step({"build": batch(results=steps(1)[:1])}, {"batchId": "batch", "step": 0})
        self.assertEqual(result, {"status": "building", "step": 1})
        encode.assert_not_called()
        for state, event in (
            ({"build": batch()}, {"batchId": "other", "step": 0}),
            ({}, {"batchId": "batch", "step": 0}),
        ):
            self.assertEqual(self.run_step(state, event)[0], {"status": "superseded"})
        self.assertEqual(self.run_step({"build": batch()}, {"batchId": "batch", "step": 2})[0], {"status": "rejected"})
        self.assertEqual(self.run_step({"build": batch(cuts=1, results=steps(1))}, {"batchId": "batch", "step": 1})[0]["status"], "ready")
        self.assertEqual(self.run_step({"build": batch()}, {"batchId": "batch", "step": "x"})[0], {"status": "rejected"})
        self.assertEqual(self.run_step({"build": batch()}, {"batchId": "batch", "step": 0}, appended=False)[0], {"status": "superseded"})

    def test_batches_from_an_older_worker_are_abandoned(self):
        older = {key: value for key, value in batch().items() if key != "builder"}
        result, encode, _ = self.run_step({"build": older}, {"batchId": "batch", "step": 0})
        self.assertEqual(result, {"status": "failed", "reason": "builder_changed"})
        encode.assert_not_called()

    def test_a_failed_step_stops_the_batch_and_reports_the_reason(self):
        with patch.object(hero_reel, "load_state", return_value={"build": batch()}), patch.object(
            hero_reel, "encode_step", side_effect=hero_reel.ReelError("timeout")
        ):
            self.assertEqual(hero_reel.build_cut({"batchId": "batch", "step": 0}, Context()), {"status": "failed", "reason": "timeout"})
        self.assertIsNone(self.saved[-1]["build"])
        self.assertEqual(self.saved[-1]["job"]["reason"], "timeout")
        hero_reel._fail_batch(batch(mode="auto"), "ffmpeg_failed")
        self.assertEqual(self.saved[-1]["auto"]["reason"], "ffmpeg_failed")

    def test_the_last_step_publishes_automatic_batches(self):
        state = {"build": batch(mode="auto", results=steps(3)[:-1], cuts=3)}
        with patch.object(hero_reel, "publish_record", return_value=({"published": {"version": VERSION_A}}, True)) as publish:
            result, _, _ = self.run_step(state, {"batchId": "batch", "step": 5})
        self.assertEqual(result, {"status": "published", "version": VERSION_A})
        self.assertEqual(len(publish.call_args.args[1]["cuts"]), 3)
        self.assertIsNone(self.saved[-1]["build"])
        self.assertEqual(self.saved[-1]["auto"]["status"], "published")
        self.assertEqual(self.invoked(), [])

    def test_the_last_step_turns_a_draft_batch_into_a_reviewable_draft(self):
        state = {"build": batch(results=steps(3)[:-1], cuts=3), "draft": {"version": "old", "mediaIds": []}}
        with patch.object(hero_reel, "cleanup_versions") as cleanup, patch.object(hero_reel, "write_pointer") as pointer:
            result, _, _ = self.run_step(state, {"batchId": "batch", "step": 5})
        self.assertEqual(result, {"status": "ready", "version": VERSION_A})
        final = self.saved[-1]
        self.assertEqual(len(final["draft"]["cuts"]), 3)
        self.assertEqual(final["job"]["status"], "ready")
        self.assertIsNone(final["build"])
        cleanup.assert_called_once()
        pointer.assert_not_called()

    def test_finishing_refuses_sources_that_left_the_public_catalog(self):
        with patch.object(hero_reel, "eligible_videos", return_value=[]):
            self.assertEqual(hero_reel.finish_batch({}, batch(results=steps(1))), {"status": "failed", "reason": "sources_changed"})

    def test_results_append_only_for_the_expected_step(self):
        table = Mock()
        entry = step_entry(0, "portrait")
        with patch.object(hero_reel, "_table", return_value=table):
            self.assertTrue(hero_reel._append_result("batch", 1, entry))
            update = table.update_item.call_args.kwargs
            self.assertIn("size(#build.#results) = :step", update["ConditionExpression"])
            self.assertEqual(update["ExpressionAttributeValues"][":step"], 1)
            table.update_item.side_effect = client_error("ConditionalCheckFailedException", "UpdateItem")
            self.assertFalse(hero_reel._append_result("batch", 1, entry))
            table.update_item.side_effect = client_error("Throttling", "UpdateItem")
            with self.assertRaises(ClientError):
                hero_reel._append_result("batch", 1, entry)


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
            {"duration": 2.0, "rate": "24", "start": 0.5},
            {"duration": 1.8, "rate": "24", "start": 0.1},
        ]
        small = {"portrait": ({"width": 270, "height": 480, "crf": 30, "maxrate": 800, "level": "4.1"},
                              {"width": 180, "height": 320, "crf": 30, "maxrate": 400, "level": "4.1"})}
        with patch.dict(hero_reel_plan.LADDERS, small), patch.dict(hero_reel_plan.MASTERS, {"portrait": (270, 480)}):
            result = hero_reel.encode_ladder(
                clips,
                [{"kind": "hls", "path": f"concat:{steady}", "offset": 0.5}, {"kind": "hls", "path": cut, "offset": 0.1}],
                "portrait", 0, self.workspace, hero_reel.time.monotonic() + 300,
            )
        self.assertAlmostEqual(result["seconds"], 3.8)
        top = result["files"]["reel-0-270x480"]
        probe = subprocess.run(["ffmpeg", "-hide_banner", "-i", top["playlist"]], capture_output=True, text=True)
        self.assertIn("270x480", probe.stderr)
        self.assertIn(" 24 fps", probe.stderr)
        self.assertNotIn("Audio:", probe.stderr)
        with open(top["playlist"], encoding="utf-8") as handle:
            playlist = handle.read()
        self.assertIn("#EXT-X-BYTERANGE:", playlist)
        self.assertIn('#EXT-X-MAP:URI="reel-0-270x480.mp4"', playlist)
        self.assertIn("RESOLUTION=180x320", result["master"])


if __name__ == "__main__":
    unittest.main()
