import random
import unittest

import test_support  # noqa: F401  (adds backend/functions to sys.path)

import hero_reel_plan as plan


MASTER = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=24.000
clip%20one_1080p5m.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=960x540
clip%20one_540p1m2.m3u8
"""
MEDIA = """#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10,
clip%20one_540p1m2_00001.ts
#EXTINF:10.0,
clip%20one_540p1m2_00002.ts
#EXTINF:4,
clip%20one_540p1m2_00003.ts
#EXT-X-ENDLIST
"""
KEY = "albums/a/original/clip one_hls/clip one.m3u8"


def frames(spec, rate=24.0, start=12.0):
    """spec: list of (score, luma) pairs, one per frame."""
    lines = []
    for index, (score, luma) in enumerate(spec):
        lines += [
            f"frame:{index}    pts:{index}  pts_time:{start + index / rate:.6f}",
            "lavfi.scd.mafd=0.1",
            f"lavfi.scd.score={score}",
            f"lavfi.signalstats.YAVG={luma}",
        ]
    return "\n".join(lines)


def video(media_id, segments=3, created="2026-01-01"):
    return {
        "albumId": f"album-{media_id}",
        "mediaId": media_id,
        "hlsKey": f"albums/{media_id}/v_hls/v.m3u8",
        "createdAt": created,
        "segments": [{"key": f"s{i}", "start": i * 10.0, "duration": 10.0} for i in range(segments)],
    }


class PlaylistTests(unittest.TestCase):
    def test_master_playlist_variants_resolve_inside_the_rendition_folder(self):
        variants = plan.parse_master_playlist(KEY, MASTER)
        self.assertEqual([variant["key"] for variant in variants], [
            "albums/a/original/clip one_hls/clip one_1080p5m.m3u8",
            "albums/a/original/clip one_hls/clip one_540p1m2.m3u8",
        ])
        self.assertEqual(plan.choose_variant(variants, "analysis")["height"], 540)
        self.assertEqual(plan.choose_variant(variants, "output")["height"], 1080)

    def test_media_playlists_are_detected_and_timed(self):
        self.assertIsNone(plan.parse_master_playlist(KEY, MEDIA))
        segments = plan.parse_media_playlist(KEY, MEDIA)
        self.assertEqual([segment["start"] for segment in segments], [0.0, 10.0, 20.0])
        self.assertEqual(segments[2]["duration"], 4.0)
        self.assertEqual(segments[0]["key"], "albums/a/original/clip one_hls/clip one_540p1m2_00001.ts")

    def test_variant_choice_falls_back_when_no_rendition_meets_the_target(self):
        only_4k = [{"key": "k", "width": 3840, "height": 2160, "bandwidth": 5}]
        self.assertEqual(plan.choose_variant(only_4k, "analysis")["height"], 2160)
        self.assertEqual(plan.choose_variant(only_4k, "output")["height"], 2160)
        small = [{"key": "a", "width": 640, "height": 360, "bandwidth": 1}, {"key": "b", "width": 1280, "height": 720, "bandwidth": 2}]
        self.assertEqual(plan.choose_variant(small, "output")["key"], "b")
        tiny = [{"key": "t", "width": 320, "height": 180, "bandwidth": 1}]
        self.assertEqual(plan.choose_variant(tiny, "analysis")["key"], "t")

    def test_single_file_renditions_are_read_as_byte_ranges(self):
        # MediaConvert SINGLE_FILE output: one .ts per rendition.
        text = (
            "#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:6\n"
            "#EXTINF:6.006,\n#EXT-X-BYTERANGE:1000@0\nclip_360p.ts\n"
            "#EXTINF:6.006,\n#EXT-X-BYTERANGE:800\nclip_360p.ts\n"
            "#EXTINF:2.0,\n#EXT-X-BYTERANGE:50@5000\nclip_360p.ts\n#EXT-X-ENDLIST\n"
        )
        segments = plan.parse_media_playlist(KEY, text)
        self.assertEqual([segment["range"] for segment in segments], [[0, 1000], [1000, 800], [5000, 50]])
        self.assertEqual([segment["start"] for segment in segments], [0.0, 6.006, 12.012])
        self.assertTrue(all(segment["key"].endswith("/clip_360p.ts") for segment in segments))
        for text in (
            "#EXTM3U\n#EXTINF:6,\n#EXT-X-BYTERANGE:800\na.ts\n#EXT-X-ENDLIST\n",
            "#EXTM3U\n#EXTINF:6,\n#EXT-X-BYTERANGE:x@0\na.ts\n#EXT-X-ENDLIST\n",
            "#EXTM3U\n#EXTINF:6,\n#EXT-X-BYTERANGE:0@0\na.ts\n#EXT-X-ENDLIST\n",
            "#EXTM3U\n#EXTINF:6,\n#EXT-X-BYTERANGE:5@-1\na.ts\n#EXT-X-ENDLIST\n",
        ):
            with self.subTest(text=text), self.assertRaises(plan.PlaylistError) as raised:
                plan.parse_media_playlist(KEY, text)
            self.assertEqual(str(raised.exception), "bad_byterange")
        with self.assertRaises(plan.PlaylistError) as raised:
            plan.parse_media_playlist(KEY, '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\na.m4s\n#EXT-X-ENDLIST\n')
        self.assertEqual(str(raised.exception), "unsupported_feature")

    def test_unsafe_or_incomplete_playlists_are_rejected(self):
        cases = {
            "not_a_playlist": "hello",
            "incomplete": "#EXTM3U\n#EXTINF:10,\na.ts\n",
            "uri_outside_rendition": "#EXTM3U\n#EXTINF:10,\n../other/a.ts\n#EXT-X-ENDLIST\n",
            "unsupported_uri": "#EXTM3U\n#EXTINF:10,\nhttps://evil.example/a.ts\n#EXT-X-ENDLIST\n",
            "unsupported_feature": "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:10,\na.ts\n#EXT-X-ENDLIST\n",
            "bad_duration": "#EXTM3U\n#EXTINF:abc,\na.ts\n#EXT-X-ENDLIST\n",
            "empty": "#EXTM3U\n#EXT-X-ENDLIST\n",
        }
        for reason, text in cases.items():
            with self.subTest(reason=reason), self.assertRaises(plan.PlaylistError) as raised:
                plan.parse_media_playlist(KEY, text)
            self.assertEqual(str(raised.exception), reason)
        with self.assertRaises(plan.PlaylistError):
            plan.parse_media_playlist(KEY, "#EXTM3U\na.ts\n#EXT-X-ENDLIST\n")
        with self.assertRaises(plan.PlaylistError):
            plan.parse_master_playlist(KEY, "nope")
        with self.assertRaises(plan.PlaylistError):
            plan.parse_master_playlist(KEY, "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=axb\nv.m3u8\n")
        with self.assertRaises(plan.PlaylistError):
            plan.parse_master_playlist(KEY, "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=0x0\nv.m3u8\n")

    def test_segment_count_is_bounded(self):
        text = "#EXTM3U\n" + "#EXTINF:1,\na.ts\n" * (plan.MAX_PLAYLIST_SEGMENTS + 1) + "#EXT-X-ENDLIST\n"
        with self.assertRaises(plan.PlaylistError):
            plan.parse_media_playlist(KEY, text)


class AnalysisPlanTests(unittest.TestCase):
    def test_digest_ignores_order_and_changes_with_inputs(self):
        a = {"albumId": "a", "mediaId": "1", "hlsKey": "k1"}
        b = {"albumId": "b", "mediaId": "2", "hlsKey": "k2"}
        self.assertEqual(plan.input_digest([a, b]), plan.input_digest([b, a]))
        self.assertNotEqual(plan.input_digest([a]), plan.input_digest([a, b]))

    def test_windows_are_bounded_and_skip_openings_of_long_videos(self):
        rng = random.Random(1)
        plans = plan.plan_analysis([video("short", 2), video("long", 12)], rng, budget=40)
        windows = {item["mediaId"]: item["window"] for item in plans}
        self.assertEqual(len(windows["short"]), 2)
        self.assertEqual(len(windows["long"]), 2)
        self.assertNotEqual(windows["long"][0]["key"], "s0")
        self.assertEqual(plan.plan_analysis([], rng), [])

    def test_large_catalogs_keep_recent_uploads_and_sample_the_rest(self):
        videos = [video(f"v{i:02d}", 2, created=f"2026-01-{i + 1:02d}") for i in range(plan.MAX_VIDEOS + 10)]
        plans = plan.plan_analysis(videos, random.Random(2))
        chosen = {item["mediaId"] for item in plans}
        self.assertEqual(len(plans), plan.MAX_VIDEOS)
        newest = {f"v{i:02d}" for i in range(len(videos) - plan.MAX_VIDEOS // 2, len(videos))}
        self.assertLessEqual(newest, chosen)


class ShotDetectionTests(unittest.TestCase):
    def test_metadata_parsing_keeps_complete_frames(self):
        parsed = plan.parse_frame_metadata(frames([(0, 100), (1.5, 101)]) + "\nframe:9 pts:9 pts_time:x\nlavfi.scd.score=nan-ish")
        self.assertEqual(len(parsed), 2)
        self.assertAlmostEqual(parsed[1]["score"], 1.5)
        self.assertEqual(plan.parse_frame_metadata("lavfi.scd.score=3"), [])

    def test_cuts_and_flashes_split_shots_on_the_source_timeline(self):
        spec = [(0.5, 100)] * 72 + [(20, 100)] + [(0.5, 100)] * 47 + [(0.5, 160)] + [(0.5, 160)] * 24
        shots = plan.detect_shots(plan.parse_frame_metadata(frames(spec)), 30.0, 40.0)
        self.assertEqual(len(shots), 3)
        self.assertAlmostEqual(shots[0]["start"], 30.0)
        self.assertAlmostEqual(shots[1]["start"], 33.0, places=2)
        self.assertAlmostEqual(shots[2]["start"], 35.0, places=2)
        self.assertLessEqual(shots[-1]["end"], 40.0)
        self.assertEqual(plan.detect_shots([], 0, 1), [])

    def test_frame_rate_snaps_to_standard_rates(self):
        self.assertEqual(plan.frame_rate(plan.parse_frame_metadata(frames([(0, 1)] * 10, rate=23.976))), "24000/1001")
        self.assertEqual(plan.frame_rate(plan.parse_frame_metadata(frames([(0, 1)] * 10, rate=60))), "30")
        self.assertEqual(plan.frame_rate(plan.parse_frame_metadata(frames([(0, 1)] * 10, rate=25))), "25")
        self.assertEqual(plan.frame_rate([]), "24")
        self.assertEqual(plan.frame_rate([{"t": 1}, {"t": 1}, {"t": 1}]), "24")


class SelectionTests(unittest.TestCase):
    def shots(self):
        return [
            {"start": 0.0, "end": 0.8, "motion": 0.5, "luma": 100},  # too short
            {"start": 0.8, "end": 6.0, "motion": 0.8, "luma": 100},  # calm
            {"start": 6.0, "end": 12.0, "motion": 9.0, "luma": 100},  # shaky
            {"start": 12.0, "end": 20.0, "motion": 0.01, "luma": 8},  # dark and static
            {"start": 20.0, "end": 22.2, "motion": 0.4, "luma": 100},  # only long enough when relaxed
        ]

    def test_only_calm_well_lit_shots_become_strict_candidates(self):
        source = {"albumId": "a", "mediaId": "m", "rate": "24"}
        clips = plan.candidate_clips(source, self.shots(), random.Random(3))
        self.assertEqual([clip["shot"] for clip in clips], ["1.0"])
        clip = clips[0]
        self.assertGreaterEqual(clip["start"], 0.8 + plan.SHOT_MARGIN_SECONDS - 1e-6)
        self.assertLessEqual(clip["start"] + clip["duration"], 6.0 - plan.SHOT_MARGIN_SECONDS + 1e-6)

    def test_relaxed_candidates_accept_short_shaky_or_dark_footage(self):
        source = {"albumId": "a", "mediaId": "m"}
        clips = plan.candidate_clips(source, self.shots(), random.Random(3), relaxed=True)
        self.assertEqual(sorted(clip["shot"] for clip in clips), ["1.0", "2.0", "3.0", "4.0"])
        dark = next(clip for clip in clips if clip["shot"] == "3.0")
        self.assertLess(dark["quality"], next(clip for clip in clips if clip["shot"] == "1.0")["quality"])

    def test_long_takes_offer_several_spaced_clips_away_from_the_edges(self):
        source = {"albumId": "a", "mediaId": "m", "duration": 40.0}
        take = [{"start": 0.0, "end": 40.0, "motion": 0.6, "luma": 120}]
        clips = sorted(plan.candidate_clips(source, take, random.Random(8)), key=lambda clip: clip["start"])
        self.assertEqual([clip["shot"] for clip in clips], ["0.0", "0.1", "0.2", "0.3", "0.4"])
        for first, second in zip(clips, clips[1:]):
            self.assertGreaterEqual(second["start"], first["start"] + first["duration"])
        self.assertTrue(all(clip["duration"] == plan.MAX_CLIP_SECONDS for clip in clips))
        self.assertGreaterEqual(clips[0]["start"], plan.VIDEO_EDGE_SECONDS)
        self.assertLessEqual(clips[-1]["start"] + clips[-1]["duration"], 40.0 - plan.VIDEO_EDGE_SECONDS + 1e-6)

    def test_selection_round_robins_videos_until_the_target_and_never_repeats_a_shot(self):
        def candidates(media_id, count):
            return [
                {"albumId": "a", "mediaId": media_id, "shot": index % 3, "start": index * 6.0, "duration": 5.0, "quality": 5 - index, "rate": "24"}
                for index in range(count)
            ]
        pools = {"one": candidates("one", 9), "two": candidates("two", 2), "three": []}
        chosen = plan.select_clips(pools, random.Random(4), target=20)
        self.assertGreaterEqual(plan.reel_seconds(chosen), 20 - 1e-6)
        per_video = {}
        for clip in chosen:
            per_video.setdefault(clip["mediaId"], set())
            self.assertNotIn(clip["shot"], per_video[clip["mediaId"]])
            per_video[clip["mediaId"]].add(clip["shot"])
        self.assertIn("two", per_video)
        exhausted = plan.select_clips({"one": candidates("one", 9)}, random.Random(4), target=500)
        self.assertEqual(len(exhausted), 3)

    def test_later_cuts_prefer_clips_earlier_cuts_did_not_use(self):
        pool = {"one": [
            {"albumId": "a", "mediaId": "one", "shot": f"{index}.0", "start": index * 6.0, "duration": 5.0, "quality": 10 - index, "rate": "24"}
            for index in range(6)
        ]}
        first = plan.select_clips(pool, random.Random(1), target=10)
        used = {plan.clip_id(clip) for clip in first}
        second = plan.select_clips(pool, random.Random(2), target=10, used=frozenset(used))
        self.assertFalse(used & {plan.clip_id(clip) for clip in second})
        # Selection works on copies: trimming one cut never changes the pool.
        self.assertTrue(all(item["duration"] == 5.0 for item in pool["one"]))

    def test_fresh_clips_from_any_video_come_before_reusing_one(self):
        def clip(media_id, shot):
            return {"albumId": "a", "mediaId": media_id, "shot": shot, "start": 0.0, "duration": 5.0, "quality": 1, "rate": "24"}

        # "solo" has a single clip that an earlier cut used.
        pool = {"solo": [clip("solo", "0.0")], "many": [clip("many", f"{index}.0") for index in range(4)]}
        used = frozenset({"solo|0.0"})
        for seed in range(8):
            chosen = plan.select_clips(pool, random.Random(seed), target=15, used=used)
            self.assertNotIn("solo", {item["mediaId"] for item in chosen})
        # Reuse only once nothing fresh is left.
        everything = plan.select_clips(pool, random.Random(1), target=25, used=used)
        self.assertIn("solo", {item["mediaId"] for item in everything})
        all_used = frozenset(plan.clip_id(item) for items in pool.values() for item in items)
        self.assertGreaterEqual(plan.reel_seconds(plan.select_clips(pool, random.Random(1), target=10, used=all_used)), 10 - 1e-6)

    def test_interleaving_avoids_back_to_back_clips_from_one_video(self):
        clips = [{"mediaId": "a"}] * 3 + [{"mediaId": "b"}] * 2 + [{"mediaId": "c"}]
        ordered = plan._interleave(clips, random.Random(5))
        self.assertEqual(len(ordered), 6)
        self.assertTrue(all(x["mediaId"] != y["mediaId"] for x, y in zip(ordered, ordered[1:])))
        self.assertNotEqual(ordered[0]["mediaId"], ordered[-1]["mediaId"])
        self.assertEqual(plan._interleave([], random.Random(1)), [])

    def test_output_rate_follows_the_majority(self):
        self.assertEqual(plan.output_rate([{"rate": "25"}, {"rate": "24"}, {"rate": "25"}]), "25")
        self.assertEqual(plan.output_rate([]), "24")


class FilterGraphTests(unittest.TestCase):
    def test_landscape_graph_hard_cuts_into_every_rung_and_a_poster(self):
        clips = [{"duration": 5.0}, {"duration": 4.0}, {"duration": 5.0}]
        graph, total = plan.filter_graph(clips, "24", "landscape")
        self.assertAlmostEqual(total, 14.0)
        self.assertEqual(plan.reel_seconds(clips), 14.0)
        self.assertNotIn("xfade", graph)
        self.assertIn("[c0][c1][c2]concat=n=3:v=1:a=0[joined]", graph)
        self.assertIn("[joined]trim=duration=14.000,setpts=PTS-STARTPTS,fps=24,split=5", graph)
        self.assertNotIn("[3:v]", graph)
        self.assertIn("[s0]null[out0]", graph)
        self.assertIn("[s1]scale=1920:1080:flags=lanczos[out1]", graph)
        self.assertIn("[s3]scale=960:540:flags=lanczos[out3]", graph)
        self.assertIn("[s4]trim=end_frame=1[poster]", graph)

    def test_portrait_graph_has_its_own_master_and_no_poster(self):
        graph, _ = plan.filter_graph([{"duration": 5.0}], "30", "portrait")
        self.assertIn("split=3", graph)
        self.assertIn("[s0]null[out0]", graph)
        self.assertIn("[s2]scale=540:960:flags=lanczos[out2]", graph)
        self.assertNotIn("poster", graph)

    def test_clip_filter_covers_the_master_frame_and_tone_maps_hdr(self):
        self.assertIn("scale=2560:1440:force_original_aspect_ratio=increase", plan.clip_filter("24", "landscape"))
        self.assertIn("crop=1080:1920", plan.clip_filter("24", "portrait"))
        self.assertNotIn("tonemap", plan.clip_filter("24", "portrait"))
        hdr = plan.clip_filter("24", "portrait", hdr=True)
        self.assertTrue(hdr.startswith("zscale=t=linear"))
        self.assertIn("tonemap=hable", hdr)
        self.assertTrue(hdr.endswith("format=yuv420p"))

    def test_master_playlist_lists_the_start_rung_first_with_peak_and_average_rates(self):
        sizes = {plan.rung_name(1, rung): 3_000_000 for rung in plan.LADDERS["landscape"]}
        text = plan.master_playlist(1, "landscape", "24000/1001", sizes, 60.0)
        lines = text.splitlines()
        self.assertEqual(lines[:3], ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"])
        self.assertEqual(
            [line for line in lines if not line.startswith("#")],
            ["reel-1-1280x720.m3u8", "reel-1-2560x1440.m3u8", "reel-1-1920x1080.m3u8", "reel-1-960x540.m3u8"],
        )
        self.assertIn("BANDWIDTH=4000000,AVERAGE-BANDWIDTH=400000,RESOLUTION=1280x720,FRAME-RATE=23.976", lines[3])
        self.assertIn('CODECS="avc1.640032"', lines[5])
        self.assertTrue(text.endswith("\n"))
        portrait = plan.master_playlist(0, "portrait", "30", {plan.rung_name(0, rung): 1 for rung in plan.LADDERS["portrait"]}, 0)
        self.assertIn("reel-0-720x1280.m3u8", portrait.splitlines()[4])
        self.assertIn("FRAME-RATE=30.000", portrait)

    def test_every_rung_fits_its_h264_level(self):
        # Level 4.1 allows 8192 macroblocks a frame; 5.0 allows 22080.
        for ladder in plan.LADDERS.values():
            for rung in ladder:
                blocks = -(-rung["width"] // 16) * -(-rung["height"] // 16)
                self.assertLessEqual(blocks, 8192 if rung["level"] == "4.1" else 22080, rung)
                self.assertEqual(rung["width"] % 2 + rung["height"] % 2, 0)


if __name__ == "__main__":
    unittest.main()
