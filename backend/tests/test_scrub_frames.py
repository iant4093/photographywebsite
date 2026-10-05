"""Timeline preview frames for the video player's seek bar."""

import os
import unittest
from unittest.mock import Mock, patch

from botocore.session import get_session
from botocore.validate import validate_parameters

import test_support  # noqa: F401  (adds backend/functions to sys.path)
from test_support import DEFAULT_ENV
import test_publication_recovery as publication
from test_publication_recovery import ALBUM, CONTEXT, RECORD

import create_album
import hls_ladder
import media_access
import media_helpers
import media_mutation
import video_jobs
import video_upgrade


RAW = f"albums/{ALBUM}/original/movie.mp4"
CURRENT = f"albums/{ALBUM}/original/movie_hls/v2/movie.m3u8"
OLD = f"albums/{ALBUM}/original/movie_hls/movie.m3u8"
FRAMES = f"albums/{ALBUM}/original/movie_hls/frames/v1/"
BUCKET = DEFAULT_ENV["IMAGES_BUCKET"]


def frame_group(request):
    return next(group for group in request["Settings"]["OutputGroups"] if group["Name"] == "Timeline frames")


class FrameLayoutTests(unittest.TestCase):
    def test_frames_live_in_the_stream_folder_and_both_copies_of_the_naming_agree(self):
        self.assertEqual(hls_ladder.scrub_frames_prefix(RAW), FRAMES)
        self.assertEqual(hls_ladder.scrub_frame_base_key(RAW), f"{FRAMES}movie.")
        for key in (RAW, f"albums/{ALBUM}/original/a.b.c.MOV", f"albums/{ALBUM}/original/noext"):
            with self.subTest(key=key):
                self.assertEqual(media_access.scrub_frame_base_key(key), hls_ladder.scrub_frame_base_key(key))
        self.assertEqual(media_access.SCRUB_FRAMES_VERSION, hls_ladder.SCRUB_FRAMES_VERSION)
        self.assertEqual(media_access.SCRUB_FRAME_INTERVAL, hls_ladder.SCRUB_FRAME_INTERVAL)
        self.assertTrue(hls_ladder.scrub_frames_current({"v": 1, "interval": 2}))
        self.assertFalse(hls_ladder.scrub_frames_current({"v": 0}))
        self.assertFalse(hls_ladder.scrub_frames_current(None))

    def test_frames_are_committed_outputs_of_a_saved_video(self):
        album = {"albumId": ALBUM, "type": "video", "images": [{"rawKey": RAW, "hlsUrl": CURRENT}]}
        self.assertTrue(media_mutation.object_is_committed(album, f"{FRAMES}movie.0000003.jpg"))
        self.assertFalse(media_mutation.object_is_committed(album, f"albums/{ALBUM}/original/other_hls/frames/v1/other.0000003.jpg"))
        self.assertFalse(media_mutation.object_is_committed({**album, "type": "photo"}, f"{FRAMES}movie.0000003.jpg"))

    def test_candidates_are_current_streams_without_frames_or_pending_work(self):
        def video(name, **extra):
            raw = f"albums/{ALBUM}/original/{name}.mp4"
            return {"rawKey": raw, "hlsUrl": hls_ladder.hls_master_playlist_key(raw), "mediaConvertJobId": "j", **extra}
        album = {"images": [
            video("ready"),
            video("framed", scrubFrames={"v": 1, "interval": 2}),
            video("stale-frames", scrubFrames={"v": 0}),
            {**video("old"), "hlsUrl": OLD},
            {"rawKey": f"albums/{ALBUM}/original/unconverted.mp4"},
            video("queued"), video("upgrading"), "legacy",
        ]}
        album["videoJobs"] = {
            hls_ladder.frames_receipt_identity(f"albums/{ALBUM}/original/queued.mp4"): {},
            hls_ladder.receipt_identity(f"albums/{ALBUM}/original/upgrading.mp4"): {},
        }
        self.assertEqual(hls_ladder.frames_candidates(album), [
            f"albums/{ALBUM}/original/ready.mp4", f"albums/{ALBUM}/original/stale-frames.mp4",
        ])
        identity, receipt = hls_ladder.frames_receipt(RAW)
        self.assertNotEqual(identity, hls_ladder.receipt_identity(RAW))
        self.assertEqual((receipt["key"], receipt["phase"], receipt["frames"]), (RAW, "prepared", True))
        self.assertEqual(hls_ladder.frames_candidates({}), [])


class FrameJobTests(unittest.TestCase):
    def submit(self, call):
        client = Mock()
        client.create_job.return_value = {"Job": {"Id": "job-new"}}
        with patch.object(media_helpers, "get_mediaconvert_client", return_value=client), patch.dict(
            os.environ, {"MEDIACONVERT_ROLE_ARN": "arn:aws:iam::123456789012:role/MediaConvert"}
        ):
            self.assertEqual(call(), "job-new")
        request = client.create_job.call_args.kwargs
        model = get_session().get_service_model("mediaconvert")
        validate_parameters(request, model.operation_model("CreateJob").input_shape)
        return request

    def test_frame_sizes_keep_the_shape_with_a_small_long_edge(self):
        self.assertEqual(media_helpers._frame_size(3840, 2160), (320, 180))
        self.assertEqual(media_helpers._frame_size(1080, 1920), (180, 320))
        self.assertEqual(media_helpers._frame_size(200, 100), (200, 100))
        self.assertEqual(media_helpers._frame_size(1001, 3), (320, 2))
        for size in ((None, 10), ("wide", 10), (0, 10), (-5, 10)):
            with self.subTest(size=size):
                self.assertIsNone(media_helpers._frame_size(*size))

    def test_a_conversion_also_writes_frames_and_a_frame_job_writes_only_frames(self):
        request = self.submit(lambda: media_helpers.start_mediaconvert_job(
            f"s3://{BUCKET}/{RAW}", f"s3://{BUCKET}/out/", width=1920, height=1080, frames_s3_prefix=f"s3://{BUCKET}/{FRAMES}",
        ))
        group = frame_group(request)
        self.assertEqual(len(request["Settings"]["OutputGroups"]), 2)
        self.assertEqual(group["OutputGroupSettings"]["FileGroupSettings"]["Destination"], f"s3://{BUCKET}/{FRAMES}")
        output = group["Outputs"][0]
        self.assertEqual(output["ContainerSettings"]["Container"], "RAW")
        video = output["VideoDescription"]
        self.assertEqual((video["Width"], video["Height"]), (320, 180))
        capture = video["CodecSettings"]["FrameCaptureSettings"]
        self.assertEqual((capture["FramerateNumerator"], capture["FramerateDenominator"]), (1, hls_ladder.SCRUB_FRAME_INTERVAL))

        request = self.submit(lambda: media_helpers.start_frame_capture_job(f"s3://{BUCKET}/{RAW}", f"s3://{BUCKET}/{FRAMES}", request_token="t" * 32))
        self.assertEqual([group["Name"] for group in request["Settings"]["OutputGroups"]], ["Timeline frames"])
        self.assertEqual(request["Settings"]["Inputs"][0]["VideoSelector"], {"Rotate": "AUTO"})
        self.assertEqual(request["ClientRequestToken"], "t" * 32)
        self.assertNotIn("Height", frame_group(request)["Outputs"][0]["VideoDescription"])

        # Without a frames destination the job is the stream alone.
        request = self.submit(lambda: media_helpers.start_mediaconvert_job(f"s3://{BUCKET}/{RAW}", f"s3://{BUCKET}/out/"))
        self.assertEqual(len(request["Settings"]["OutputGroups"]), 1)

    def test_a_direct_upload_advertises_frames_with_its_stream(self):
        images = [{"rawKey": RAW, "width": 1920, "height": 1080}]
        with patch.object(create_album, "start_mediaconvert_job", return_value="job-1") as submit:
            create_album._start_video_jobs(images)
        self.assertEqual(submit.call_args.kwargs["frames_s3_prefix"], f"s3://{BUCKET}/{FRAMES}")
        self.assertEqual(images[0]["scrubFrames"], {"v": 1, "interval": 2})


class FrameReceiptTests(unittest.TestCase):
    setUp = publication.PublicationRecoveryTests.setUp
    put = publication.PublicationRecoveryTests.put
    album = publication.PublicationRecoveryTests.album

    def seed(self, receipt_for, **image):
        album = {**RECORD, "type": "video", "images": [{
            "rawKey": RAW, "hlsUrl": CURRENT, "mediaConvertJobId": "job", "width": 1920, "height": 1080, **image,
        }]}
        identity, receipt = receipt_for(RAW)
        album["videoJobs"] = {identity: receipt}
        self.put(album)
        return identity

    def resume(self, **patches):
        with patch.object(video_jobs.time, "time", return_value=1000), patch.object(video_jobs, "enqueue") as enqueue:
            video_jobs.resume(self.table, self.album(), CONTEXT)
        return enqueue

    def test_a_frame_job_marks_the_video_once_accepted(self):
        self.seed(hls_ladder.frames_receipt)
        with patch.object(video_jobs, "start_frame_capture_job", return_value="frames-job") as submit, \
                patch.object(video_jobs, "start_mediaconvert_job") as convert:
            self.resume()
        convert.assert_not_called()
        args, kwargs = submit.call_args
        self.assertEqual(args, (f"s3://{BUCKET}/{RAW}", f"s3://{BUCKET}/{FRAMES}"))
        self.assertEqual((kwargs["width"], kwargs["height"]), (1920, 1080))
        image = self.album()["images"][0]
        self.assertEqual(image["scrubFrames"], {"v": 1, "interval": 2})
        self.assertEqual((image["hlsUrl"], image["mediaConvertJobId"]), (CURRENT, "job"))
        self.assertEqual(self.album()["videoJobs"], {})

    def test_a_frame_receipt_for_a_framed_or_missing_video_is_dropped(self):
        self.seed(hls_ladder.frames_receipt, scrubFrames={"v": 1, "interval": 2})
        with patch.object(video_jobs, "start_frame_capture_job") as submit:
            self.resume()
        submit.assert_not_called()
        self.assertEqual(self.album()["videoJobs"], {})

    def test_a_refused_frame_job_waits_and_retries(self):
        identity = self.seed(hls_ladder.frames_receipt)
        error = video_jobs.ClientError({"Error": {"Code": "TooManyRequestsException"}}, "CreateJob")
        with patch.object(video_jobs, "start_frame_capture_job", side_effect=error):
            enqueue = self.resume()
        receipt = self.album()["videoJobs"][identity]
        self.assertEqual((receipt["phase"], receipt["checks"]), ("prepared", 1))
        self.assertNotIn("scrubFrames", self.album()["images"][0])
        enqueue.assert_called_once()

    def test_new_and_upgraded_streams_come_with_frames(self):
        album = {**RECORD, "type": "video", "images": [{"rawKey": RAW, "width": 1920, "height": 1080}]}
        album["videoJobs"] = video_jobs.prepare(album, album["images"])
        self.put(album)
        with patch.object(video_jobs, "start_mediaconvert_job", return_value="new-job") as submit:
            self.resume()
        self.assertEqual(submit.call_args.kwargs["frames_s3_prefix"], f"s3://{BUCKET}/{FRAMES}")
        self.assertEqual(self.album()["images"][0]["scrubFrames"], {"v": 1, "interval": 2})

        self.seed(hls_ladder.upgrade_receipt, hlsUrl=OLD)
        with patch.object(video_jobs, "start_mediaconvert_job", return_value="upgrade-job") as submit:
            self.resume()
        self.assertEqual(submit.call_args.kwargs["frames_s3_prefix"], f"s3://{BUCKET}/{FRAMES}")
        self.assertNotIn("scrubFrames", self.album()["images"][0])
        with patch.object(video_jobs.time, "time", return_value=1300), patch.object(video_jobs, "_master_exists", return_value=True), \
                patch.object(video_jobs, "enqueue"), patch.object(video_jobs, "request_public_api_invalidation"):
            video_jobs.resume(self.table, self.album(), CONTEXT)
        self.assertEqual(self.album()["images"][0]["scrubFrames"], {"v": 1, "interval": 2})


class FrameScanTests(unittest.TestCase):
    def test_current_videos_without_frames_get_a_bounded_number_of_frame_jobs(self):
        def video(index, album_id):
            raw = f"albums/{album_id}/original/v{index}.mp4"
            return {"rawKey": raw, "hlsUrl": hls_ladder.hls_master_playlist_key(raw), "mediaConvertJobId": "j"}
        table, sqs = Mock(), Mock()
        table.scan.return_value = {"Items": [
            {"albumId": "a", "type": "video", "status": "active", "images": [video(index, "a") for index in range(3)]},
            {"albumId": "b", "type": "video", "status": "active", "images": [video(index, "b") for index in range(4)]},
        ]}
        with patch.object(video_upgrade, "_table", table), patch.object(video_upgrade, "_sqs", sqs), \
                patch.object(video_upgrade, "MAX_FRAMES_PER_RUN", 5), \
                patch.dict(os.environ, {"CACHE_INVALIDATION_QUEUE_URL": "https://sqs.example/queue"}):
            result = video_upgrade.handler({}, None)
        self.assertEqual(result, {"queued": 0, "frames": 5, "inFlight": 0, "waiting": 0})
        receipts = [call.kwargs["ExpressionAttributeValues"][":receipt"] for call in table.update_item.call_args_list
                    if ":receipt" in call.kwargs["ExpressionAttributeValues"]]
        self.assertEqual(len(receipts), 5)
        self.assertTrue(all(receipt["frames"] is True for receipt in receipts))
        self.assertEqual(sqs.send_message.call_count, 2)


class FrameSerializationTests(unittest.TestCase):
    def test_players_get_a_frame_url_wherever_they_get_the_stream(self):
        image = {"rawKey": RAW, "hlsUrl": CURRENT, "scrubFrames": {"v": 1, "interval": 2}}
        public = media_access.serialize_image(image, "public")
        self.assertEqual(public["scrubFrames"], {"url": f"https://{os.environ['CLOUDFRONT_DOMAIN']}/{FRAMES}movie.", "interval": 2})
        with patch.object(media_access, "presigned_get_url", side_effect=lambda key, **_: f"https://signed.example/{key}"):
            private = media_access.serialize_image(image, "private", private_media_base="https://site.example/private-media")
            self.assertEqual(private["scrubFrames"]["url"], f"https://site.example/private-media/{FRAMES}movie.")
            # Without album cookies there is no stream, so no frames either.
            self.assertNotIn("scrubFrames", media_access.serialize_image(image, "private"))
        self.assertNotIn("scrubFrames", media_access.serialize_image({**image, "scrubFrames": {"v": 9}}, "public"))
        self.assertNotIn("scrubFrames", media_access.serialize_image({**image, "scrubFrames": "yes"}, "public"))


if __name__ == "__main__":
    unittest.main()
