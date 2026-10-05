"""Re-converting existing videos onto the current HLS ladder."""

import json
import os
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

import test_support  # noqa: F401  (adds backend/functions to sys.path)
import test_publication_recovery as publication
from test_publication_recovery import ALBUM, CONTEXT, RECORD

import hls_ladder
import video_jobs
import video_upgrade


RAW = f"albums/{ALBUM}/original/movie.mp4"
OLD_MASTER = f"albums/{ALBUM}/original/movie_hls/movie.m3u8"
NEW_MASTER = f"albums/{ALBUM}/original/movie_hls/v2/movie.m3u8"


def client_error(code):
    return ClientError({"Error": {"Code": code, "Message": code}}, "Operation")


class LadderPathTests(unittest.TestCase):
    def test_candidates_are_converted_videos_on_an_older_ladder_without_a_receipt(self):
        album = {
            "images": [
                {"rawKey": RAW, "hlsUrl": OLD_MASTER, "mediaConvertJobId": "j1"},
                {"rawKey": f"albums/{ALBUM}/original/new.mp4", "hlsUrl": f"albums/{ALBUM}/original/new_hls/v2/new.m3u8", "mediaConvertJobId": "j2"},
                {"rawKey": f"albums/{ALBUM}/original/pending.mp4"},
                {"rawKey": f"albums/{ALBUM}/original/failed.mp4", "mediaConvertJobId": "j3"},
                {"rawKey": f"albums/{ALBUM}/original/queued.mp4", "hlsUrl": "x", "mediaConvertJobId": "j4"},
                "legacy-string",
            ],
            "videoJobs": {hls_ladder.receipt_identity(f"albums/{ALBUM}/original/queued.mp4"): {}},
        }
        self.assertEqual(hls_ladder.upgrade_candidates(album), [RAW, f"albums/{ALBUM}/original/failed.mp4"])
        identity, receipt = hls_ladder.upgrade_receipt(RAW)
        self.assertEqual(identity, hls_ladder.receipt_identity(RAW))
        self.assertEqual((receipt["key"], receipt["phase"], receipt["upgrade"]), (RAW, "prepared", True))
        self.assertEqual(len(receipt["token"]), 32)
        self.assertEqual(hls_ladder.upgrade_candidates({}), [])


class UpgradeJobTests(unittest.TestCase):
    setUp = publication.PublicationRecoveryTests.setUp
    put = publication.PublicationRecoveryTests.put
    album = publication.PublicationRecoveryTests.album

    def seed(self, **image):
        album = {**RECORD, "type": "video", "images": [{
            "rawKey": RAW, "hlsUrl": OLD_MASTER, "mediaConvertJobId": "old-job", "width": 1920, "height": 1080, **image,
        }]}
        identity, receipt = hls_ladder.upgrade_receipt(RAW)
        album["videoJobs"] = {identity: receipt}
        self.put(album)
        return identity

    def resume(self, now, exists=False, **patches):
        with patch.object(video_jobs.time, "time", return_value=now), patch.object(
            video_jobs, "_master_exists", return_value=exists
        ) as head, patch.object(video_jobs, "enqueue") as enqueue:
            video_jobs.resume(self.table, self.album(), CONTEXT)
        return head, enqueue

    def test_the_old_stream_plays_until_the_new_one_is_complete(self):
        identity = self.seed()
        with patch.object(video_jobs, "start_mediaconvert_job", return_value="new-job") as submit:
            _, enqueue = self.resume(1000)
        args, kwargs = submit.call_args
        self.assertEqual(args[1], f"s3://{os.environ['IMAGES_BUCKET']}/{RAW.rsplit('.', 1)[0]}_hls/v2/")
        self.assertEqual((kwargs["width"], kwargs["height"]), (1920, 1080))
        self.assertEqual(kwargs["request_token"], self.album()["videoJobs"][identity]["token"])
        image = self.album()["images"][0]
        self.assertEqual((image["hlsUrl"], image["mediaConvertJobId"]), (OLD_MASTER, "old-job"))
        receipt = self.album()["videoJobs"][identity]
        self.assertEqual((receipt["phase"], receipt["jobId"], receipt["checkAfter"]), ("transcoding", "new-job", 1300))
        enqueue.assert_called_once_with(ALBUM, "album-video-jobs", delay=300)

        head, _ = self.resume(1100)
        head.assert_not_called()
        self.resume(1300)
        receipt = self.album()["videoJobs"][identity]
        self.assertEqual((receipt["checks"], receipt["checkAfter"]), (1, 1600))
        self.assertEqual(self.album()["images"][0]["hlsUrl"], OLD_MASTER)

        with patch.object(video_jobs, "start_mediaconvert_job") as again, patch.object(
            video_jobs, "request_public_api_invalidation"
        ) as invalidate:
            self.resume(1600, exists=True)
        again.assert_not_called()
        invalidate.assert_called_once_with(album_id=ALBUM, catalog=True, reason="video-upgrade")
        image = self.album()["images"][0]
        self.assertEqual((image["hlsUrl"], image["mediaConvertJobId"]), (NEW_MASTER, "new-job"))
        self.assertEqual(self.album()["videoJobs"], {})

    def test_an_upgrade_that_never_completes_keeps_the_old_stream(self):
        identity = self.seed()
        with patch.object(video_jobs, "start_mediaconvert_job", return_value="new-job"):
            self.resume(1000)
        self.resume(1000 + 86400)
        receipt = self.album()["videoJobs"][identity]
        self.assertEqual(receipt["phase"], "unresolved")
        self.assertEqual(self.album()["images"][0]["hlsUrl"], OLD_MASTER)
        head, enqueue = self.resume(1000 + 3 * 86400)
        head.assert_not_called()
        enqueue.assert_not_called()

    def test_upgrades_for_current_or_removed_videos_are_dropped(self):
        self.seed(hlsUrl=NEW_MASTER)
        with patch.object(video_jobs, "start_mediaconvert_job") as submit:
            self.resume(1000)
        submit.assert_not_called()
        self.assertEqual(self.album()["videoJobs"], {})
        self.seed(rawKey=f"albums/{ALBUM}/original/other.mp4")
        with patch.object(video_jobs, "start_mediaconvert_job") as submit:
            self.resume(1000)
        submit.assert_not_called()
        self.assertEqual(self.album()["videoJobs"], {})

    def test_master_check_is_a_head_request(self):
        s3 = Mock()
        with patch.object(video_jobs, "_s3", s3):
            self.assertTrue(video_jobs._master_exists(RAW))
            self.assertEqual(s3.head_object.call_args.kwargs["Key"], NEW_MASTER)
            s3.head_object.side_effect = client_error("404")
            self.assertFalse(video_jobs._master_exists(RAW))
            s3.head_object.side_effect = client_error("AccessDenied")
            with self.assertRaises(ClientError):
                video_jobs._master_exists(RAW)
        with patch.object(video_jobs, "_s3", None), patch.object(video_jobs.boto3, "client", return_value=s3):
            s3.head_object.side_effect = None
            self.assertTrue(video_jobs._master_exists(RAW))


def video_album(album_id, images, **extra):
    return {"albumId": album_id, "type": "video", "status": "active", "images": images, **extra}


def stale(name, album_id="a"):
    return {"rawKey": f"albums/{album_id}/original/{name}.mp4", "hlsUrl": f"albums/{album_id}/original/{name}_hls/{name}.m3u8",
            "mediaConvertJobId": "old"}


class ScannerTests(unittest.TestCase):
    def setUp(self):
        self.table = Mock()
        self.sqs = Mock()
        for item in (
            patch.object(video_upgrade, "_table", self.table),
            patch.object(video_upgrade, "_sqs", self.sqs),
            patch.dict(os.environ, {"CACHE_INVALIDATION_QUEUE_URL": "https://sqs.example/queue"}),
        ):
            item.start()
            self.addCleanup(item.stop)

    def receipts(self):
        return [
            (call.kwargs["Key"]["albumId"], call.kwargs["ExpressionAttributeValues"][":receipt"]["key"])
            for call in self.table.update_item.call_args_list if ":receipt" in call.kwargs["ExpressionAttributeValues"]
        ]

    def test_a_run_queues_a_bounded_number_of_upgrades_and_wakes_each_album_once(self):
        in_flight = {f"r{index}": {"upgrade": True, "phase": "transcoding"} for index in range(2)}
        self.table.scan.side_effect = [
            {"Items": [
                video_album("a", [stale(f"v{index}") for index in range(5)], videoJobs={**in_flight, "x": {"upgrade": True, "phase": "unresolved"}}),
                video_album("busy", [stale("v", "busy")], pendingVisibilityChange={"id": "p"}),
            ], "LastEvaluatedKey": {"albumId": "busy"}},
            {"Items": [
                video_album("b", [stale(f"w{index}", "b") for index in range(6)]),
                video_album("deleting", [stale("v", "deleting")], status="deleting"),
            ]},
        ]
        with patch.object(video_upgrade, "MAX_NEW_PER_RUN", 8), patch.object(video_upgrade, "MAX_IN_FLIGHT", 10):
            result = video_upgrade.handler({}, None)
        self.assertEqual(result, {"queued": 8, "frames": 0, "inFlight": 2, "waiting": 3})
        self.assertEqual(self.table.scan.call_args_list[1].kwargs["ExclusiveStartKey"], {"albumId": "busy"})
        queued = self.receipts()
        self.assertEqual([album for album, _ in queued], ["a"] * 5 + ["b"] * 3)
        bodies = [json.loads(call.kwargs["MessageBody"]) for call in self.sqs.send_message.call_args_list]
        self.assertEqual(bodies, [
            {"version": 1, "kind": "album-video-jobs", "albumId": "a"},
            {"version": 1, "kind": "album-video-jobs", "albumId": "b"},
        ])
        first = self.table.update_item.call_args_list[0].kwargs
        self.assertEqual(first["UpdateExpression"], "SET videoJobs = if_not_exists(videoJobs, :empty)")
        nested = self.table.update_item.call_args_list[1].kwargs
        self.assertIn("attribute_not_exists(videoJobs.#identity)", nested["ConditionExpression"])
        self.assertIn("attribute_not_exists(pendingVisibilityChange)", nested["ConditionExpression"])

    def test_nothing_is_queued_while_the_in_flight_limit_is_reached(self):
        jobs = {f"r{index}": {"upgrade": True, "phase": "submitting"} for index in range(video_upgrade.MAX_IN_FLIGHT)}
        self.table.scan.return_value = {"Items": [video_album("a", [stale("v")], videoJobs=jobs)]}
        self.assertEqual(video_upgrade.handler({}, None), {"queued": 0, "frames": 0, "inFlight": video_upgrade.MAX_IN_FLIGHT, "waiting": 1})
        self.table.update_item.assert_not_called()
        self.sqs.send_message.assert_not_called()

    def test_albums_that_changed_meanwhile_are_skipped(self):
        self.table.scan.return_value = {"Items": [video_album("a", [stale("v"), stale("w")])]}
        self.table.update_item.side_effect = [None, client_error("ConditionalCheckFailedException"), client_error("ConditionalCheckFailedException")]
        self.assertEqual(video_upgrade.handler({}, None)["queued"], 0)
        self.sqs.send_message.assert_not_called()
        self.table.update_item.side_effect = client_error("ProvisionedThroughputExceededException")
        with self.assertRaises(ClientError):
            video_upgrade.handler({}, None)

    def test_clients_are_created_lazily(self):
        with patch.object(video_upgrade, "_table", None), patch.object(video_upgrade.boto3, "resource") as resource, patch.dict(
            os.environ, {"ALBUMS_TABLE": "albums"}
        ):
            self.assertIs(video_upgrade._albums(), resource.return_value.Table.return_value)
            resource.return_value.Table.assert_called_once_with("albums")
        with patch.object(video_upgrade, "_sqs", None), patch.object(video_upgrade.boto3, "client") as client:
            video_upgrade._enqueue_video_jobs("a")
            client.return_value.send_message.assert_called_once()


if __name__ == "__main__":
    unittest.main()
