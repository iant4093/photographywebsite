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
MASTER_KEY = f"albums/{ALBUM_ID}/original/movie_hls/movie.m3u8"
LEGACY_KEY = f"albums/{ALBUM_ID}/original/movie_hls/movie_1080p5m.m3u8"


class VideoTranscodingTests(unittest.TestCase):
    def test_new_video_job_has_two_bounded_renditions_and_uses_the_master(self):
        image = create_album._normalize_images(
            [{"rawKey": RAW_KEY, "thumbKey": THUMB_KEY, "thumbnailTime": 5}],
            ALBUM_ID,
            "video",
        )[0]
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
        settings = request["Settings"]
        self.assertEqual(settings["Inputs"][0]["FileInput"], f"s3://{DEFAULT_ENV['IMAGES_BUCKET']}/{RAW_KEY}")
        group = settings["OutputGroups"][0]
        hls_group = group["OutputGroupSettings"]["HlsGroupSettings"]
        destination = f"s3://{DEFAULT_ENV['IMAGES_BUCKET']}/{RAW_KEY.rsplit('.', 1)[0]}_hls/"
        self.assertEqual(hls_group["Destination"], destination)
        self.assertEqual(hls_group["OutputSelection"], "MANIFESTS_AND_SEGMENTS")
        self.assertEqual(len(group["Outputs"]), 2)
        self.assertEqual(
            {
                (
                    output["VideoDescription"]["Width"],
                    output["VideoDescription"]["Height"],
                    output["VideoDescription"]["CodecSettings"]["H264Settings"]["MaxBitrate"],
                )
                for output in group["Outputs"]
            },
            {(1920, 1080, 5000000), (960, 540, 1200000)},
        )
        modifiers = set()
        for output in group["Outputs"]:
            video = output["VideoDescription"]
            self.assertEqual(video["ScalingBehavior"], "FIT_NO_UPSCALE")
            self.assertIn(video["ScalingBehavior"], service_model.shape_for("ScalingBehavior").enum)
            self.assertEqual(video["CodecSettings"]["Codec"], "H_264")
            self.assertEqual(video["CodecSettings"]["H264Settings"]["GopSizeUnits"], "AUTO")
            self.assertEqual(output["ContainerSettings"]["Container"], "M3U8")
            self.assertEqual(output["AudioDescriptions"][0]["CodecSettings"]["Codec"], "AAC")
            modifiers.add(output["NameModifier"])
        self.assertEqual(len(modifiers), 2)
        self.assertEqual(image["hlsUrl"], MASTER_KEY)
        self.assertTrue(all(f"{modifier}.m3u8" not in image["hlsUrl"] for modifier in modifiers))
        self.assertEqual(image["mediaConvertJobId"], "job-new")
        self.assertEqual(image["thumbKey"], THUMB_KEY)
        self.assertEqual(image["thumbnailTime"], 5)

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
