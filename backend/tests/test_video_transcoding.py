import os
import unittest
from copy import deepcopy
from unittest.mock import Mock, patch

from botocore.session import get_session
from botocore.validate import validate_parameters

from test_support import DEFAULT_ENV

import create_album
import media_access
import media_helpers


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
RAW_KEY = f"albums/{ALBUM_ID}/original/movie.mp4"
THUMB_KEY = f"albums/{ALBUM_ID}/thumbnail/movie.jpg"
MASTER_KEY = f"albums/{ALBUM_ID}/original/movie_hls/v2/movie.m3u8"
LEGACY_KEY = f"albums/{ALBUM_ID}/original/movie_hls/movie_1080p5m.m3u8"


class VideoTranscodingTests(unittest.TestCase):
    def submit(self, image):
        client = Mock()
        client.create_job.return_value = {"Job": {"Id": "job-new"}}
        with patch.object(media_helpers, "get_mediaconvert_client", return_value=client), patch.dict(
            os.environ, {"MEDIACONVERT_ROLE_ARN": "arn:aws:iam::123456789012:role/MediaConvert"}
        ):
            create_album._start_video_jobs([image])
        request = client.create_job.call_args.kwargs
        # Validate the actual submission against the SDK without an AWS request.
        service_model = get_session().get_service_model("mediaconvert")
        validate_parameters(request, service_model.operation_model("CreateJob").input_shape)
        return request, service_model

    def rungs(self, request):
        return [
            (
                output["NameModifier"],
                output["VideoDescription"]["Width"],
                output["VideoDescription"]["Height"],
                output["VideoDescription"]["CodecSettings"]["H264Settings"]["MaxBitrate"],
            )
            for output in request["Settings"]["OutputGroups"][0]["Outputs"]
        ]

    def test_new_video_job_is_a_single_file_ladder_up_to_4k_in_a_versioned_folder(self):
        image = create_album._normalize_images(
            [{"rawKey": RAW_KEY, "thumbKey": THUMB_KEY, "thumbnailTime": 5, "width": 3840, "height": 2160}],
            ALBUM_ID,
            "video",
        )[0]
        request, service_model = self.submit(image)
        settings = request["Settings"]
        self.assertEqual(settings["Inputs"][0]["FileInput"], f"s3://{DEFAULT_ENV['IMAGES_BUCKET']}/{RAW_KEY}")
        self.assertEqual(settings["Inputs"][0]["VideoSelector"], {"Rotate": "AUTO"})
        group = settings["OutputGroups"][0]
        hls_group = group["OutputGroupSettings"]["HlsGroupSettings"]
        destination = f"s3://{DEFAULT_ENV['IMAGES_BUCKET']}/{RAW_KEY.rsplit('.', 1)[0]}_hls/v2/"
        self.assertEqual(hls_group["Destination"], destination)
        self.assertEqual(hls_group["OutputSelection"], "MANIFESTS_AND_SEGMENTS")
        # One file per rendition (byte ranges), so object counts stay tiny.
        self.assertEqual(hls_group["SegmentControl"], "SINGLE_FILE")
        self.assertIn(hls_group["SegmentControl"], service_model.shape_for("HlsSegmentControl").enum)
        self.assertEqual(hls_group["SegmentLength"], 6)
        self.assertEqual(self.rungs(request), [
            ("_2160p", 3840, 2160, 16_000_000),
            ("_1440p", 2560, 1440, 10_000_000),
            ("_1080p", 1920, 1080, 6_500_000),
            ("_720p", 1280, 720, 3_500_000),
            ("_540p", 960, 540, 1_800_000),
            ("_360p", 640, 360, 800_000),
        ])
        for output in group["Outputs"]:
            video = output["VideoDescription"]
            self.assertEqual(video["ScalingBehavior"], "FIT_NO_UPSCALE")
            self.assertIn(video["ScalingBehavior"], service_model.shape_for("ScalingBehavior").enum)
            self.assertEqual(video["CodecSettings"]["Codec"], "H_264")
            self.assertEqual(video["CodecSettings"]["H264Settings"]["RateControlMode"], "QVBR")
            self.assertIn(video["CodecSettings"]["H264Settings"]["QvbrSettings"]["QvbrQualityLevel"], (7, 8))
            self.assertEqual(output["ContainerSettings"]["Container"], "M3U8")
            self.assertEqual(output["AudioDescriptions"][0]["CodecSettings"]["Codec"], "AAC")
        self.assertEqual(image["hlsUrl"], MASTER_KEY)
        self.assertEqual(image["mediaConvertJobId"], "job-new")
        self.assertEqual(image["thumbKey"], THUMB_KEY)
        self.assertEqual(image["thumbnailTime"], 5)

    def test_smaller_and_portrait_sources_get_only_distinct_rungs(self):
        names = lambda *size: [rung[0] for rung in media_helpers.hls_ladder(*size)]
        self.assertEqual(names(1920, 1080), ["_1080p", "_720p", "_540p", "_360p"])
        self.assertEqual(names(1280, 720), ["_720p", "_540p", "_360p"])
        # An ultrawide or in-between source keeps a rung at its full size.
        self.assertEqual(names(2560, 1080), ["_1440p", "_1080p", "_720p", "_540p", "_360p"])
        self.assertEqual(names(3000, 1688), ["_2160p", "_1440p", "_1080p", "_720p", "_540p", "_360p"])
        # Portrait boxes follow the source, so "1080p" is 1080 wide.
        portrait = media_helpers.hls_ladder(1080, 1920)
        self.assertEqual([(name, width, height) for name, width, height, _, _ in portrait], [
            ("_1080p", 1080, 1920), ("_720p", 720, 1280), ("_540p", 540, 960), ("_360p", 360, 640),
        ])
        self.assertEqual(len(media_helpers.hls_ladder()), 6)
        self.assertEqual(len(media_helpers.hls_ladder("wide", None)), 6)
        self.assertEqual(names(320, 180), ["_360p"])

    def test_unknown_sizes_submit_the_whole_ladder(self):
        image = create_album._normalize_images([{"rawKey": RAW_KEY}], ALBUM_ID, "video")[0]
        request, _ = self.submit(image)
        self.assertEqual(len(self.rungs(request)), 6)
        portrait = create_album._normalize_images([{"rawKey": RAW_KEY, "width": 1080, "height": 1920}], ALBUM_ID, "video")[0]
        request, _ = self.submit(portrait)
        self.assertEqual(self.rungs(request)[0], ("_1080p", 1080, 1920, 6_500_000))

    def test_stream_paths_mark_the_current_ladder(self):
        self.assertEqual(media_helpers.hls_destination_prefix(RAW_KEY), f"albums/{ALBUM_ID}/original/movie_hls/v2/")
        self.assertTrue(media_helpers.hls_is_current(RAW_KEY, MASTER_KEY))
        self.assertFalse(media_helpers.hls_is_current(RAW_KEY, LEGACY_KEY))
        self.assertFalse(media_helpers.hls_is_current(RAW_KEY, f"albums/{ALBUM_ID}/original/movie_hls/movie.m3u8"))
        self.assertFalse(media_helpers.hls_is_current(RAW_KEY, None))

    def test_retried_job_restores_master_url_after_previous_failure_or_legacy_normalization(self):
        images = [{"rawKey": RAW_KEY}, {"rawKey": RAW_KEY, "hlsUrl": LEGACY_KEY}]
        with patch.object(create_album, "start_mediaconvert_job", return_value="job-retry"):
            create_album._start_video_jobs(images)
        for image in images:
            self.assertEqual(image["hlsUrl"], MASTER_KEY)
            self.assertEqual(image["mediaConvertJobId"], "job-retry")

    def test_failed_submission_keeps_raw_video_and_thumbnail_without_unavailable_hls(self):
        image = create_album._normalize_images(
            [{"rawKey": RAW_KEY, "thumbKey": THUMB_KEY}], ALBUM_ID, "video"
        )[0]
        with patch.object(create_album, "start_mediaconvert_job", side_effect=RuntimeError("offline")):
            create_album._start_video_jobs([image])
        self.assertNotIn("hlsUrl", image)
        self.assertNotIn("mediaConvertJobId", image)
        self.assertEqual(image["rawKey"], RAW_KEY)
        self.assertEqual(image["thumbKey"], THUMB_KEY)

    def test_existing_video_rendition_urls_remain_usable_in_details_and_album_covers(self):
        image = {"rawKey": RAW_KEY, "thumbKey": THUMB_KEY, "hlsUrl": LEGACY_KEY, "mediaConvertJobId": "old-job"}
        album = {
            "albumId": ALBUM_ID,
            "type": "video",
            "visibility": "public",
            "coverImageUrl": RAW_KEY,
            "coverThumbKey": THUMB_KEY,
            "images": [image],
        }
        original = deepcopy(album)
        detail = media_access.serialize_image(image, "public")
        summary = media_access.serialize_album_summary(album)
        self.assertEqual(detail["hlsUrl"], f"https://{DEFAULT_ENV['CLOUDFRONT_DOMAIN']}/{LEGACY_KEY}")
        self.assertEqual(summary["coverHlsUrl"], detail["hlsUrl"])
        self.assertEqual(album, original)


if __name__ == "__main__":
    unittest.main()
