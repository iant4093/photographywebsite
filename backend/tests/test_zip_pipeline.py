"""Archive freshness, original bytes, queue recovery, and background preparation."""

from contextlib import ExitStack
import io
import json
import os
import unittest
from unittest.mock import Mock, patch
import zipfile
from botocore.exceptions import ClientError

import test_support  # noqa: F401
import create_zip
import worker_zip
import zip_archive_refresh as refresh
import zip_jobs
import zip_helpers
from zip_helpers import archive_entries, zip_keys, zip_version


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
KEY = f"albums/{ALBUM_ID}/original/one.jpg"
KEY2 = f"albums/{ALBUM_ID}/original/two.mp4"


def album(**changes):
    return {
        "albumId": ALBUM_ID, "title": "Summer", "visibility": "public", "status": "active",
        "type": "photo", "images": [{"rawKey": KEY, "originalFilename": "Beach.jpg"}], **changes,
    }


class ArchiveIdentityTests(unittest.TestCase):
    def test_shared_lookup_reloads_current_manifest_after_eventually_consistent_index(self):
        table = Mock()
        table.query.return_value = {"Items": [album(title="Old title")]}
        current = album(title="Current title", images=[{"rawKey": KEY2}])
        table.get_item.return_value = {"Item": current}
        resource = Mock()
        resource.Table.return_value = table
        with patch.object(zip_helpers, "dynamodb", resource):
            self.assertEqual(zip_helpers.get_album_record(share_code="shared-code"), current)
        table.get_item.assert_called_once_with(Key={"albumId": ALBUM_ID}, ConsistentRead=True)

    def test_names_membership_order_and_access_change_the_version(self):
        original = album(images=[{"rawKey": KEY}, {"rawKey": KEY2}])
        for change in (
            {"title": "Renamed"}, {"visibility": "private"}, {"type": "video"},
            {"images": [{"rawKey": KEY}]}, {"images": [{"rawKey": KEY2}, {"rawKey": KEY}]},
            {"images": [{"rawKey": KEY, "originalFilename": "New.jpg"}, {"rawKey": KEY2}]},
        ):
            with self.subTest(change=change):
                self.assertNotEqual(zip_version(original), zip_version({**original, **change}))
        self.assertEqual(zip_version(original), zip_version({**original, "description": "New description", "coverThumbKey": "new"}))

    def test_filenames_are_safe_and_duplicates_remain_distinct(self):
        entries = archive_entries(album(images=[
            {"rawKey": KEY, "originalFilename": "../Beach.jpg"},
            {"rawKey": KEY2, "originalFilename": "C:\\folder\\Beach.jpg"},
            {"rawKey": KEY, "originalFilename": "bad\r\n\x00.jpg"},
        ]))
        self.assertEqual([item["name"] for item in entries], ["0001_Beach.jpg", "0002_Beach.jpg", "0003_bad___.jpg"])

    def test_queue_serializes_one_album_and_deduplicates_clicks_but_not_later_edits(self):
        sqs = Mock()
        with patch.dict(os.environ, {"ZIP_QUEUE_URL": "queue"}), patch.object(zip_jobs.boto3, "client", return_value=sqs):
            zip_jobs.enqueue_zip(ALBUM_ID, album())
            zip_jobs.enqueue_zip(ALBUM_ID, album())
            zip_jobs.enqueue_zip(ALBUM_ID, album(), request_id="later-rename-back")
        calls = [call.kwargs for call in sqs.send_message.call_args_list]
        self.assertTrue(all(call["MessageGroupId"] == ALBUM_ID for call in calls))
        self.assertEqual(calls[0]["MessageDeduplicationId"], calls[1]["MessageDeduplicationId"])
        self.assertNotEqual(calls[1]["MessageDeduplicationId"], calls[2]["MessageDeduplicationId"])
        self.assertNotIn("DelaySeconds", calls[0])


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.record = album()
        self.s3 = Mock()
        self.s3.head_object.return_value = {"ContentLength": 4, "VersionId": "source-version"}
        self.s3.get_object.side_effect = lambda **kwargs: {"Body": io.BytesIO(b"data")}
        self.s3.create_multipart_upload.return_value = {"UploadId": "upload"}
        self.s3.upload_part.side_effect = lambda **kwargs: {"ETag": str(kwargs["PartNumber"])}
        self.s3.get_paginator.return_value.paginate.return_value = [{"Contents": []}]
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in (("s3", self.s3), ("object_metadata", Mock(return_value=None)), ("get_album_record", Mock(side_effect=lambda **kwargs: self.record))):
            self.stack.enter_context(patch.object(worker_zip, name, value))

    def test_both_media_types_preserve_original_bytes_names_and_source_versions(self):
        for kind in ("photo", "video"):
            with self.subTest(kind=kind):
                self.s3.reset_mock()
                self.record = album(type=kind)
                result = worker_zip.handler({"albumId": ALBUM_ID}, None)
                self.assertEqual(result, {"status": "complete", "objectCount": 1, "totalBytes": 4})
                parts = sorted(self.s3.upload_part.call_args_list, key=lambda call: call.kwargs["PartNumber"])
                with zipfile.ZipFile(io.BytesIO(b"".join(call.kwargs["Body"] for call in parts))) as archive:
                    self.assertEqual(archive.namelist(), ["0001_Beach.jpg"])
                    self.assertEqual(archive.read("0001_Beach.jpg"), b"data")
                    self.assertIsNone(archive.testzip())
                self.s3.get_object.assert_called_once_with(Bucket="images-test", Key=KEY, VersionId="source-version")

    def test_stale_queue_message_builds_latest_title_and_membership(self):
        old_version = zip_version(self.record)
        self.record = album(title="New title", images=[{"rawKey": KEY2, "originalFilename": "Film.mp4"}])
        worker_zip.handler({"albumId": ALBUM_ID, "version": old_version}, None)
        self.assertEqual(self.s3.create_multipart_upload.call_args.kwargs["Key"], zip_keys(self.record)[0])
        self.assertEqual(self.s3.get_object.call_args.kwargs["Key"], KEY2)

    def test_ready_archive_needs_no_source_reads(self):
        with patch.object(worker_zip, "object_metadata", return_value={"Key": "ready"}):
            self.assertEqual(worker_zip.handler({"albumId": ALBUM_ID}, None)["status"], "ready")
        self.s3.head_object.assert_not_called()
        self.s3.create_multipart_upload.assert_not_called()

    def test_rename_or_removal_during_build_aborts_unpublished_archive(self):
        for current in (album(title="Changed"), album(images=[]), None):
            self.s3.reset_mock()
            self.record = album()
            def changed_get(**kwargs):
                self.record = current
                return {"Body": io.BytesIO(b"data")}
            self.s3.get_object.side_effect = changed_get
            result = worker_zip.handler({"albumId": ALBUM_ID}, None)
            self.assertEqual(result["status"], "superseded")
            self.s3.abort_multipart_upload.assert_called_once()
            self.s3.complete_multipart_upload.assert_not_called()

    def test_edit_during_finalize_removes_obsolete_result(self):
        original_key = zip_keys(self.record)[0]
        self.s3.complete_multipart_upload.side_effect = lambda **kwargs: setattr(self, "record", album(title="Changed"))
        self.assertEqual(worker_zip.handler({"albumId": ALBUM_ID}, None)["status"], "superseded")
        self.assertEqual(self.s3.delete_object.call_args.kwargs["Key"], original_key)

    def test_deleted_empty_and_unavailable_albums_cannot_be_resurrected(self):
        for record in (None, album(images=[]), album(status="pending"), album(visibility="unknown")):
            self.s3.reset_mock()
            self.record = record
            self.s3.get_paginator.return_value.paginate.return_value = [{"Contents": [{"Key": "album-zips/old.zip"}]}]
            worker_zip.handler({"albumId": ALBUM_ID}, None)
            self.s3.delete_object.assert_called_once()
            self.s3.create_multipart_upload.assert_not_called()

    def test_quota_failure_is_reported_without_retrying_impossible_work(self):
        for env, record in (({"ZIP_MAX_TOTAL_BYTES": "3"}, album()), ({"ZIP_MAX_OBJECTS": "1"}, album(images=[{"rawKey": KEY}, {"rawKey": KEY2}]))):
            self.record = record
            with patch.dict(os.environ, env):
                result = worker_zip.handler({"albumId": ALBUM_ID}, None)
            self.assertEqual(result, {"status": "failed", "code": "ZIP_TOO_LARGE"})
            self.assertEqual(json.loads(self.s3.put_object.call_args.kwargs["Body"])["status"], "failed")
        self.s3.create_multipart_upload.assert_not_called()

    def test_failed_finalize_aborts_upload_and_reports_failure(self):
        self.s3.complete_multipart_upload.side_effect = RuntimeError("complete failed")
        with self.assertRaisesRegex(RuntimeError, "complete failed"):
            worker_zip.handler({"albumId": ALBUM_ID}, None)
        self.s3.abort_multipart_upload.assert_called_once()
        self.assertEqual(json.loads(self.s3.put_object.call_args.kwargs["Body"])["code"], "ZIP_FAILED")

    def test_failed_part_aborts_instead_of_completing_a_partial_archive(self):
        self.s3.upload_part.side_effect = RuntimeError("part failed")
        with self.assertRaisesRegex(RuntimeError, "part failed"):
            worker_zip.handler({"albumId": ALBUM_ID}, None)
        self.s3.abort_multipart_upload.assert_called_once()
        self.s3.complete_multipart_upload.assert_not_called()

    def test_deadline_failure_is_retryable_before_lambda_is_killed(self):
        context = Mock()
        context.get_remaining_time_in_millis.return_value = 20_000
        with self.assertRaises(TimeoutError):
            worker_zip.handler({"albumId": ALBUM_ID}, context)
        self.s3.create_multipart_upload.assert_not_called()

    def test_fifo_failure_retries_promptly_and_leaves_remaining_messages_unprocessed(self):
        records = [{"messageId": str(i), "receiptHandle": "receipt", "body": json.dumps({"albumId": ALBUM_ID})} for i in range(2)]
        sqs = Mock()
        with patch.object(worker_zip, "_build", side_effect=RuntimeError("network")) as build, patch.object(
            worker_zip.boto3, "client", return_value=sqs
        ), patch.dict(os.environ, {"ZIP_QUEUE_URL": "queue"}):
            result = worker_zip.handler({"Records": records}, None)
        self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "0"}, {"itemIdentifier": "1"}]})
        build.assert_called_once()
        self.assertEqual(sqs.change_message_visibility.call_args.kwargs["VisibilityTimeout"], 30)


class RefreshTests(unittest.TestCase):
    def test_stream_coalesces_an_album_and_reports_failed_sequence_for_retry(self):
        records = [{"dynamodb": {"SequenceNumber": str(i), "Keys": {"albumId": {"S": ALBUM_ID}}}} for i in range(3)]
        with patch.object(refresh, "refresh_album", side_effect=[RuntimeError("queue"), None]) as request:
            result = refresh.handler({"Records": records}, None)
        self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "0"}]})
        self.assertEqual(request.call_count, 2)

    def test_cached_or_uncommitted_album_skips_preparation_and_deleted_album_queues_cleanup(self):
        with patch.object(refresh, "enqueue_zip") as enqueue, patch.object(refresh, "object_metadata", return_value={"Key": "ready"}):
            for record in (album(), album(status="pending"), album(createdBySub="upload-owner")):
                with patch.object(refresh, "get_album_record", return_value=record):
                    refresh.refresh_album(ALBUM_ID)
            enqueue.assert_not_called()
            with patch.object(refresh, "get_album_record", return_value=None):
                refresh.refresh_album(ALBUM_ID)
            enqueue.assert_called_once_with(ALBUM_ID, None, request_id=None)

    def test_reconciliation_paginates_existing_albums_and_persists_cursor_after_enqueue(self):
        resource, s3 = Mock(), Mock()
        resource.Table.return_value.scan.return_value = {"Items": [{"albumId": ALBUM_ID}], "LastEvaluatedKey": {"albumId": ALBUM_ID}}
        with patch.object(refresh.boto3, "resource", return_value=resource), patch.object(refresh, "s3", s3), patch.object(
            refresh, "object_metadata", return_value=None
        ), patch.object(refresh, "refresh_album") as enqueue:
            result = refresh.handler({}, None)
        self.assertEqual(result, {"checked": 1, "hasMore": True})
        self.assertEqual(enqueue.call_args.args, (ALBUM_ID,))
        self.assertEqual(json.loads(s3.put_object.call_args.kwargs["Body"]), {"albumId": ALBUM_ID})
        self.assertEqual(resource.Table.return_value.scan.call_args.kwargs["Limit"], 100)

    def test_reconciliation_resumes_cursor_and_does_not_skip_a_failed_page(self):
        resource, s3 = Mock(), Mock()
        cursor = {"albumId": ALBUM_ID}
        resource.Table.return_value.scan.return_value = {"Items": [{"albumId": "__SYSTEM__"}, {"albumId": ALBUM_ID}]}
        s3.get_object.return_value = {"Body": io.BytesIO(json.dumps(cursor).encode())}
        with patch.object(refresh.boto3, "resource", return_value=resource), patch.object(refresh, "s3", s3), patch.object(
            refresh, "object_metadata", return_value={"Key": refresh.CURSOR_KEY}
        ), patch.object(refresh, "refresh_album", side_effect=RuntimeError("queue unavailable")):
            with self.assertRaises(RuntimeError):
                refresh.handler({}, None)
        self.assertEqual(resource.Table.return_value.scan.call_args.kwargs["ExclusiveStartKey"], cursor)
        s3.put_object.assert_not_called()


class DownloadStatusTests(unittest.TestCase):
    def test_worker_clearing_failure_during_status_read_keeps_polling(self):
        with patch.object(create_zip, "get_album_record", return_value=album()), patch.object(
            create_zip, "get_verified_claims", return_value=None
        ), patch.object(create_zip, "check_rate_limit", return_value=True), patch.object(
            create_zip, "_object_metadata", side_effect=[None, {"Key": "failure"}]
        ), patch.object(create_zip.s3, "get_object", side_effect=ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")), patch.object(
            create_zip, "enqueue_zip"
        ) as enqueue:
            result = create_zip.handler({"pathParameters": {"albumId": ALBUM_ID}}, None)
        self.assertEqual(result["statusCode"], 202)
        enqueue.assert_called_once()

    def test_current_title_is_used_for_ready_link_and_missing_current_version_queues(self):
        current = album(title="Renamed")
        event = {"pathParameters": {"albumId": ALBUM_ID}}
        with ExitStack() as stack:
            for name, value in (("get_album_record", Mock(return_value=current)), ("get_verified_claims", Mock(return_value=None)), ("check_rate_limit", Mock(return_value=True)), ("_audit", Mock())):
                stack.enter_context(patch.object(create_zip, name, value))
            with patch.object(create_zip, "_object_metadata", return_value={"Key": zip_keys(current)[0]}), patch.object(create_zip, "presigned_get_url", return_value="signed") as sign:
                result = create_zip.handler(event, None)
                self.assertEqual(json.loads(result["body"])["url"], "signed")
                self.assertEqual(sign.call_args.kwargs["download_filename"], "Renamed.zip")
            with patch.object(create_zip, "_object_metadata", return_value=None), patch.object(create_zip, "enqueue_zip") as enqueue:
                self.assertEqual(create_zip.handler(event, None)["statusCode"], 202)
                enqueue.assert_called_once_with(ALBUM_ID, current)

    def test_terminal_build_failure_is_exposed_to_polling(self):
        failure = {"status": "failed", "code": "ZIP_TOO_LARGE", "message": "Too large"}
        with patch.object(create_zip, "get_album_record", return_value=album()), patch.object(
            create_zip, "get_verified_claims", return_value=None
        ), patch.object(create_zip, "check_rate_limit", return_value=True), patch.object(
            create_zip, "_object_metadata", side_effect=[None, {"Key": "failure"}]
        ), patch.object(create_zip.s3, "get_object", return_value={"Body": io.BytesIO(json.dumps(failure).encode())}):
            result = create_zip.handler({"pathParameters": {"albumId": ALBUM_ID}}, None)
        self.assertEqual(json.loads(result["body"]), failure)
