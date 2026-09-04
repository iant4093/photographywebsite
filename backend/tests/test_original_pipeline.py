"""Offline original-comparison pipeline safety and race regression tests."""

import copy
import gzip
import hashlib
import io
import json
import os
import unittest
from contextlib import ExitStack
from unittest.mock import Mock, call, patch

from test_support import DEFAULT_ENV
from botocore.exceptions import ClientError
from botocore.endpoint import Endpoint
from PIL import Image, ImageCms

import original_comparison_jobs as jobs
import original_comparison_store as store
import original_comparison_worker as worker
import original_index_refresh as refresh
from original_drive import DriveCursorExpired
from media_access import media_id_for_key
from validation_helpers import ValidationError


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ALBUM_ID = "22222222-2222-4222-8222-222222222222"
RAW_KEY = f"albums/{ALBUM_ID}/original/random.jpg"
MEDIA_ID = media_id_for_key(RAW_KEY)
IMAGE = {"rawKey": RAW_KEY, "originalFilename": "DSC_0001.JPG"}
ALBUM = {"albumId": ALBUM_ID, "type": "photo", "status": "active", "images": [IMAGE]}
ROOT_ID = "camera-root"
FOLDER_TYPE = "application/vnd.google-apps.folder"
INDEX_KEY = "index/" + "a" * 32 + ".json.gz"
STATE = {"indexKey": INDEX_KEY, "rootId": ROOT_ID, "generation": "generation-1", "pageToken": "token-1", "lastFullScanAt": 1000}
ENV = {
    "ORIGINAL_COMPARISON_TABLE": "comparison-test",
    "ORIGINAL_PREVIEW_BUCKET": "original-private-test",
    "ORIGINAL_COMPARISON_QUEUE_URL": "https://sqs.us-west-2.amazonaws.com/test/original-preview",
}


def error(code, operation="Operation"):
    return ClientError({"Error": {"Code": code, "Message": "private provider details"}}, operation)


def jpeg_bytes(size=(80, 50), *, orientation=1, profile=False):
    image = Image.new("RGB", size, "red")
    image.paste("blue", (size[0] // 2, 0, size[0], size[1]))
    exif = Image.Exif()
    exif[274] = orientation
    exif[315] = "Private photographer name"
    exif[37510] = b"Private camera serial"
    output = io.BytesIO()
    kwargs = {"exif": exif, "quality": 95, "subsampling": 0}
    if profile:
        kwargs["icc_profile"] = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    image.save(output, "JPEG", **kwargs)
    return output.getvalue()


JPEG = jpeg_bytes()
CHECKSUM = hashlib.md5(JPEG).hexdigest()
SOURCE = {
    "id": "source-jpg", "name": "DSC_0001.JPG", "mimeType": "image/jpeg",
    "parents": [ROOT_ID], "md5Checksum": CHECKSUM, "version": "7",
    "capabilities": {"canDownload": True},
    "imageMediaMetadata": {"cameraModel": "NIKON Z 6_2", "time": "2026:08:01 12:34:56"},
}
ROOT = {"id": ROOT_ID, "name": "Camera Originals", "mimeType": FOLDER_TYPE, "parents": []}


class OfflineTestCase(unittest.TestCase):
    def setUp(self):
        network = patch.object(Endpoint, "make_request", side_effect=AssertionError("Unexpected AWS network call in offline test"))
        network.start()
        self.addCleanup(network.stop)


class OriginalRenderingTests(OfflineTestCase):
    def test_rotates_entire_frame_without_cropping_or_upscaling_and_strips_metadata(self):
        width, height, outputs = worker.generate_previews(jpeg_bytes((80, 50), orientation=6, profile=True))
        self.assertEqual((width, height), (50, 80))
        self.assertEqual(set(outputs), {"50"})
        with Image.open(io.BytesIO(outputs["50"])) as preview:
            self.assertEqual(preview.size, (50, 80))
            self.assertEqual(preview.format, "WEBP")
            self.assertFalse(preview.getexif())
            for field in ("exif", "xmp", "icc_profile"):
                self.assertFalse(preview.info.get(field))
            # EXIF orientation turns the left/right color panels into top/bottom
            # panels. Both remain in the frame, including the outer edges.
            top = preview.convert("RGB").getpixel((25, 3))
            bottom = preview.convert("RGB").getpixel((25, 76))
            self.assertGreater(top[0], 200)
            self.assertLess(top[2], 50)
            self.assertGreater(bottom[2], 200)
            self.assertLess(bottom[0], 50)

    def test_responsive_widths_keep_original_aspect_and_never_exceed_source_width(self):
        width, height, outputs = worker.generate_previews(jpeg_bytes((1100, 550)))
        self.assertEqual((width, height), (1100, 550))
        self.assertEqual(set(outputs), {"640", "960", "1100"})
        for target, data in outputs.items():
            with Image.open(io.BytesIO(data)) as preview:
                self.assertEqual(preview.size, (int(target), int(target) // 2))

    def test_non_jpeg_and_oversized_pixel_images_are_rejected(self):
        output = io.BytesIO()
        Image.new("RGB", (10, 10)).save(output, "PNG")
        with self.assertRaisesRegex(ValueError, "JPEG"):
            worker.generate_previews(output.getvalue())
        with patch.object(worker.Image, "MAX_IMAGE_PIXELS", 1000):
            with self.assertRaises((ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning)):
                worker.generate_previews(JPEG)

    def test_camera_mpo_jpeg_renders_only_the_primary_photo(self):
        output = io.BytesIO()
        primary = Image.new("RGB", (80, 50), "red")
        secondary = Image.new("RGB", (40, 25), "blue")
        primary.save(output, "MPO", save_all=True, append_images=[secondary])
        width, height, previews = worker.generate_previews(output.getvalue())
        self.assertEqual((width, height), (80, 50))
        with Image.open(io.BytesIO(previews["80"])) as rendered:
            self.assertGreater(rendered.convert("RGB").getpixel((40, 25))[0], 200)


class OriginalWorkerTests(OfflineTestCase):
    def setUp(self):
        super().setUp()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, ENV))
        self.album_table = Mock()
        self.album_table.get_item.return_value = {"Item": copy.deepcopy(ALBUM)}
        self.resource = Mock()
        self.resource.Table.return_value = self.album_table
        self.stack.enter_context(patch.object(worker.boto3, "resource", return_value=self.resource))
        self.table = Mock()
        self.table.update_item.return_value = {"Attributes": {}}
        self.stack.enter_context(patch.object(worker, "comparison_table", return_value=self.table))
        self.state = self.stack.enter_context(patch.object(worker, "index_state", return_value=STATE))
        self.stack.enter_context(patch.object(worker, "match_index", return_value={}))
        self.evidence = self.stack.enter_context(patch.object(worker, "extract_evidence", return_value={"filenames": ["dsc_0001"], "captureTime": "2026:08:01 12:34:56", "cameraModel": "NIKON Z 6_2"}))
        self.match = self.stack.enter_context(patch.object(worker, "match_original", return_value={"status": "matched", "source": SOURCE}))
        self.s3 = Mock()
        self.stream = io.BytesIO(JPEG)
        self.s3.get_object.return_value = {"Body": self.stream, "ETag": '"edited-1"'}
        self.s3.head_object.return_value = {"ETag": '"edited-1"'}
        self.transaction = Mock()
        self.client = self.stack.enter_context(patch.object(worker.boto3, "client", side_effect=lambda service: {"s3": self.s3, "dynamodb": self.transaction}[service]))
        self.drive = Mock(spec=["root_id", "file", "download"])
        self.drive.root_id = ROOT_ID
        self.drive.file.side_effect = lambda file_id: {SOURCE["id"]: SOURCE, ROOT_ID: ROOT}[file_id]
        self.drive.download.return_value = JPEG
        self.drive_factory = self.stack.enter_context(patch.object(worker.OriginalDrive, "from_environment", return_value=self.drive))
        self.publish = self.stack.enter_context(patch.object(worker, "publish"))
        self.job = {"albumId": ALBUM_ID, "rawKey": RAW_KEY}

    def test_only_committed_active_photos_are_processed(self):
        for record in (None, {**ALBUM, "status": "deleted"}, {**ALBUM, "status": "pending"}, {**ALBUM, "type": "video"}, {**ALBUM, "images": []}):
            with self.subTest(record=record):
                self.album_table.get_item.return_value = {"Item": record}
                self.assertEqual(worker.process_job(self.job), "skipped")
        self.table.update_item.assert_not_called()
        self.state.assert_not_called()
        self.drive_factory.assert_not_called()

    def test_cross_album_key_is_rejected_before_claiming_or_contacting_drive(self):
        with self.assertRaises(ValidationError):
            worker.process_job({**self.job, "rawKey": f"albums/{OTHER_ALBUM_ID}/original/image.jpg"})
        self.table.update_item.assert_not_called()
        self.drive_factory.assert_not_called()

    def test_unbuilt_index_publishes_pending_without_source_reads(self):
        self.state.return_value = {}
        self.assertEqual(worker.process_job(self.job), "pending")
        self.assertEqual(self.publish.call_args.args[2]["status"], "pending")
        self.s3.get_object.assert_not_called()
        self.drive_factory.assert_not_called()

    def test_match_writes_immutable_encrypted_private_previews_only(self):
        self.assertEqual(worker.process_job(self.job), "ready")
        self.assertTrue(self.stream.closed)
        self.evidence.assert_called_once_with(JPEG, "DSC_0001.JPG")
        self.s3.get_object.assert_called_once_with(Bucket=DEFAULT_ENV["IMAGES_BUCKET"], Key=RAW_KEY, Range="bytes=0-1048575")
        self.drive.download.assert_called_once_with(SOURCE["id"], worker.MAX_SOURCE_BYTES, expected_md5=CHECKSUM)
        record = self.publish.call_args.args[2]
        self.assertEqual(record["status"], "ready")
        self.assertEqual(record["sourceFileId"], SOURCE["id"])
        self.assertEqual(record["sourceChecksum"], CHECKSUM)
        self.assertEqual(record["rawKey"], RAW_KEY)
        self.assertEqual((record["width"], record["height"]), (80, 50))
        expected_key = f"before/{ALBUM_ID}/{MEDIA_ID}/{CHECKSUM}/w80.webp"
        self.assertEqual(record["previews"], {"80": expected_key})
        written = self.s3.put_object.call_args.kwargs
        self.assertEqual(written["Bucket"], ENV["ORIGINAL_PREVIEW_BUCKET"])
        self.assertEqual(written["Key"], expected_key)
        self.assertEqual(written["IfNoneMatch"], "*")
        self.assertEqual(written["ServerSideEncryption"], "AES256")
        self.assertEqual(written["CacheControl"], "private, max-age=1800")
        self.assertEqual({call[0] for call in self.s3.method_calls}, {"get_object", "head_object", "put_object"})
        self.assertEqual({call[0] for call in self.drive.method_calls}, {"file", "download"})

    def test_existing_derivative_conditional_write_is_reused_without_overwrite(self):
        self.s3.put_object.side_effect = error("PreconditionFailed", "PutObject")
        self.assertEqual(worker.process_job(self.job), "ready")
        self.assertEqual(self.publish.call_args.args[2]["status"], "ready")

    def test_duplicate_queue_delivery_reuses_verified_immutable_outputs(self):
        previous = {
            "albumId": ALBUM_ID, "mediaId": MEDIA_ID, "rawKey": RAW_KEY,
            "status": "ready", "sourceChecksum": CHECKSUM, "sourceFileId": SOURCE["id"],
            "websiteEtag": '"edited-1"', "width": 80, "height": 50,
            "previews": {"80": f"before/{ALBUM_ID}/{MEDIA_ID}/{CHECKSUM}/w80.webp"},
            "leaseOwner": "claim-owner", "leaseUntil": 9999999999,
        }
        self.table.update_item.return_value = {"Attributes": previous}
        self.assertEqual(worker.process_job(self.job), "ready")
        kept = self.publish.call_args.args[2]
        self.assertNotIn("leaseOwner", kept)
        self.assertNotIn("leaseUntil", kept)
        self.assertEqual(kept["previews"], previous["previews"])
        self.drive.download.assert_not_called()
        self.s3.put_object.assert_not_called()

    def test_missing_and_ambiguous_evidence_never_downloads_or_invents_original(self):
        for match_status, stored_status in (("unavailable", "unavailable"), ("ambiguous", "ambiguous")):
            with self.subTest(status=match_status):
                self.s3.get_object.return_value = {"Body": io.BytesIO(JPEG), "ETag": '"edited-1"'}
                self.match.return_value = {"status": match_status}
                self.assertEqual(worker.process_job(self.job), stored_status)
                self.assertEqual(self.publish.call_args.args[2]["status"], stored_status)
        self.drive_factory.assert_not_called()
        self.s3.put_object.assert_not_called()

    def test_provider_failure_is_retryable_failed_and_releases_only_owned_lease(self):
        self.drive.download.side_effect = RuntimeError("private source path and provider details")
        with self.assertRaises(RuntimeError):
            worker.process_job(self.job)
        self.publish.assert_not_called()
        update = self.table.update_item.call_args.kwargs
        self.assertEqual(update["Key"], {"albumId": ALBUM_ID, "mediaId": MEDIA_ID})
        self.assertEqual(update["ExpressionAttributeValues"][":failed"], "failed")
        self.assertIn("REMOVE leaseOwner, leaseUntil", update["UpdateExpression"])
        self.assertEqual(update["ConditionExpression"], "leaseOwner = :owner")
        self.assertNotIn("private source", repr(update))

    def test_changed_edited_object_prevents_publishing_ready_mapping(self):
        self.s3.head_object.return_value = {"ETag": '"edited-replaced"'}
        with self.assertRaisesRegex(ValueError, "Edited photo changed"):
            worker.process_job(self.job)
        self.publish.assert_not_called()
        self.assertEqual(self.table.update_item.call_args.kwargs["ExpressionAttributeValues"][":failed"], "failed")

    def test_oversized_header_is_closed_and_failed_without_parsing_or_matching(self):
        stream = io.BytesIO(b"x" * (worker.MAX_HEADER_BYTES + 1))
        self.s3.get_object.return_value = {"Body": stream, "ETag": '"edited-1"'}
        with self.assertRaisesRegex(ValueError, "header exceeds"):
            worker.process_job(self.job)
        self.assertTrue(stream.closed)
        self.evidence.assert_not_called()
        self.drive_factory.assert_not_called()
        self.publish.assert_not_called()

    def test_missing_checksum_never_downloads_or_publishes_original(self):
        self.match.return_value = {"status": "matched", "source": {**SOURCE, "md5Checksum": ""}}
        with self.assertRaisesRegex(ValueError, "checksum is unavailable"):
            worker.process_job(self.job)
        self.drive_factory.assert_not_called()
        self.publish.assert_not_called()

    def test_configured_archive_root_change_stops_before_drive_download(self):
        self.drive.root_id = "replacement-root"
        with self.assertRaisesRegex(ValueError, "archive root changed"):
            worker.process_job(self.job)
        self.drive.download.assert_not_called()
        self.publish.assert_not_called()

    def test_s3_denial_is_not_mistaken_for_an_already_existing_preview(self):
        self.s3.put_object.side_effect = error("AccessDenied", "PutObject")
        with self.assertRaises(ClientError):
            worker.process_job(self.job)
        self.publish.assert_not_called()
        self.assertEqual(self.table.update_item.call_args.kwargs["ExpressionAttributeValues"][":failed"], "failed")

    def test_lost_worker_lease_during_failed_publish_preserves_original_exception(self):
        self.table.update_item.side_effect = [{"Attributes": {}}, error("ConditionalCheckFailedException")]
        self.publish.side_effect = error("TransactionCanceledException", "TransactWriteItems")
        with self.assertRaises(ClientError) as raised:
            worker.process_job(self.job)
        self.assertEqual(raised.exception.response["Error"]["Code"], "TransactionCanceledException")
        self.assertEqual(self.table.update_item.call_args.kwargs["ConditionExpression"], "leaseOwner = :owner")

    def test_live_ancestry_checks_checksum_download_permission_and_root(self):
        self.assertEqual(worker.verify_live_source(self.drive, SOURCE), SOURCE)
        for source in ({**SOURCE, "md5Checksum": "b" * 32}, {**SOURCE, "trashed": True}, {**SOURCE, "capabilities": {"canDownload": False}}, {**SOURCE, "parents": []}):
            with self.subTest(source=source):
                self.drive.file.side_effect = lambda file_id: source if file_id == SOURCE["id"] else ROOT
                with self.assertRaises(ValueError):
                    worker.verify_live_source(self.drive, SOURCE)
        self.drive.file.side_effect = lambda file_id: {**SOURCE, "parents": ["loop"]} if file_id == SOURCE["id"] else {"id": "loop", "mimeType": FOLDER_TYPE, "parents": ["loop"]}
        with self.assertRaisesRegex(ValueError, "repeats"):
            worker.verify_live_source(self.drive, SOURCE)

    def test_busy_lease_short_circuits_and_other_claim_errors_propagate(self):
        self.table.update_item.side_effect = error("ConditionalCheckFailedException")
        self.assertEqual(worker.process_job(self.job), "busy")
        self.state.assert_not_called()
        self.table.update_item.side_effect = error("AccessDeniedException")
        with self.assertRaises(ClientError):
            worker.process_job(self.job)

    def test_sqs_partial_failure_retries_only_failed_message(self):
        with patch.object(worker, "process_job", side_effect=["ready", RuntimeError("private"), "skipped"]):
            result = worker.handler({"Records": [{"messageId": str(index), "body": json.dumps(self.job)} for index in range(3)]}, None)
        self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "1"}]})


class OriginalPublishTests(OfflineTestCase):
    def test_transaction_checks_committed_image_active_photo_and_lease_owner(self):
        client = Mock()
        with patch.dict(os.environ, ENV), patch.object(worker.boto3, "client", return_value=client):
            worker.publish(ALBUM, IMAGE, {"albumId": ALBUM_ID, "mediaId": MEDIA_ID, "status": "pending"}, "owner-token")
        transaction = client.transact_write_items.call_args.kwargs["TransactItems"]
        check, put = transaction[0]["ConditionCheck"], transaction[1]["Put"]
        self.assertEqual(check["TableName"], DEFAULT_ENV["ALBUMS_TABLE"])
        self.assertIn("contains(images, :image)", check["ConditionExpression"])
        self.assertIn("#status = :active", check["ConditionExpression"])
        self.assertIn("#type = :photo", check["ConditionExpression"])
        self.assertEqual(check["ExpressionAttributeValues"][":photo"], {"S": "photo"})
        self.assertEqual(check["ExpressionAttributeValues"][":image"]["M"]["rawKey"], {"S": RAW_KEY})
        self.assertEqual(put["TableName"], ENV["ORIGINAL_COMPARISON_TABLE"])
        self.assertEqual(put["ConditionExpression"], "leaseOwner = :owner")
        self.assertEqual(put["ExpressionAttributeValues"][":owner"], {"S": "owner-token"})


class OriginalIndexTests(OfflineTestCase):
    def setUp(self):
        super().setUp()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, ENV))
        self.drive = Mock()
        self.drive.root_id = ROOT_ID
        self.drive.start_page_token.return_value = "before-scan"
        self.drive.list_inventory.return_value = [ROOT, SOURCE]
        self.drive.changes.return_value = ([], "after-scan")
        self.s3 = Mock()
        self.stack.enter_context(patch.object(refresh.boto3, "client", return_value=self.s3))

    def test_full_scan_replays_changes_from_cursor_taken_before_inventory(self):
        newly_uploaded = {**SOURCE, "id": "late-upload", "name": "DSC_0002.JPG"}
        self.drive.changes.return_value = ([{"fileId": "late-upload", "file": newly_uploaded}], "after-scan")
        state, candidates = refresh.refresh_index(self.drive, {}, 2000)
        self.assertEqual(self.drive.method_calls, [call.start_page_token(), call.list_inventory(), call.changes("before-scan")])
        self.assertEqual({item["id"] for item in candidates}, {SOURCE["id"], "late-upload"})
        self.assertEqual(state["pageToken"], "after-scan")
        self.assertEqual(state["lastFullScanAt"], 2000)
        upload = self.s3.put_object.call_args.kwargs
        self.assertEqual(upload["Bucket"], ENV["ORIGINAL_PREVIEW_BUCKET"])
        self.assertEqual(upload["ServerSideEncryption"], "AES256")
        self.assertEqual(upload["CacheControl"], "private, no-store")
        snapshot = json.loads(gzip.decompress(upload["Body"]))
        self.assertEqual({item["id"] for item in snapshot["files"]}, {ROOT_ID, SOURCE["id"], "late-upload"})
        self.assertEqual({call[0] for call in self.s3.method_calls}, {"put_object"})

    def test_delta_removals_and_trashed_files_disappear_without_rescanning(self):
        old_files = [ROOT, SOURCE, {**SOURCE, "id": "second"}]
        self.drive.changes.return_value = ([{"fileId": SOURCE["id"], "removed": True}, {"fileId": "second", "file": {**SOURCE, "id": "second", "trashed": True}}], "next-token")
        with patch.object(refresh, "load_snapshot", return_value={"files": old_files}):
            state, candidates = refresh.refresh_index(self.drive, STATE, 2000)
        self.assertEqual(candidates, [])
        self.assertEqual(state["pageToken"], "next-token")
        self.assertEqual(state["lastFullScanAt"], 1000)
        self.drive.list_inventory.assert_not_called()
        self.drive.start_page_token.assert_not_called()
        self.drive.changes.assert_called_once_with("token-1")
        self.assertEqual(old_files[1], SOURCE)

    def test_expired_cursor_rebuilds_but_provider_failure_preserves_prior_snapshot(self):
        self.drive.changes.side_effect = [DriveCursorExpired("expired"), ([], "rebuilt-token")]
        with patch.object(refresh, "load_snapshot", return_value={"files": [ROOT, SOURCE]}):
            state, _ = refresh.refresh_index(self.drive, STATE, 2000)
        self.assertEqual(state["pageToken"], "rebuilt-token")
        self.drive.list_inventory.assert_called_once_with()
        self.s3.reset_mock()
        self.drive.reset_mock()
        self.drive.changes.side_effect = RuntimeError("provider outage")
        previous = copy.deepcopy(STATE)
        with patch.object(refresh, "load_snapshot", return_value={"files": [ROOT, SOURCE]}), self.assertRaisesRegex(RuntimeError, "provider outage"):
            refresh.refresh_index(self.drive, previous, 2000)
        self.s3.put_object.assert_not_called()
        self.drive.list_inventory.assert_not_called()
        self.assertEqual(previous, STATE)

    def test_change_identity_mismatch_does_not_replace_index(self):
        self.drive.changes.return_value = ([{"fileId": "one", "file": {**SOURCE, "id": "another"}}], "bad")
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            refresh.refresh_index(self.drive, {}, 2000)
        self.s3.put_object.assert_not_called()

    def test_coordinator_preserves_index_pointer_on_failure_and_releases_only_own_lease(self):
        table = Mock()
        table.update_item.return_value = {"Attributes": STATE}
        with patch.object(refresh, "comparison_table", return_value=table), patch.object(refresh.OriginalDrive, "from_environment", return_value=self.drive), patch.object(refresh, "refresh_index", side_effect=RuntimeError("private provider message")), patch.object(refresh, "reconcile") as reconcile:
            with self.assertRaisesRegex(RuntimeError, "^Original index refresh failed$"):
                refresh.handler({}, None)
        self.assertEqual(table.update_item.call_count, 2)
        release = table.update_item.call_args.kwargs
        self.assertEqual(release["UpdateExpression"], "REMOVE leaseOwner, leaseUntil")
        self.assertEqual(release["ConditionExpression"], "leaseOwner = :owner")
        reconcile.assert_not_called()

    def test_coordinator_publishes_state_under_owned_lease_before_reconciliation(self):
        table = Mock()
        table.update_item.return_value = {"Attributes": STATE}
        events = Mock()
        events.attach_mock(table.update_item, "state_write")
        new_state = {**STATE, "generation": "new-generation", "pageToken": "new-token"}
        with patch.object(refresh, "comparison_table", return_value=table), patch.object(refresh.OriginalDrive, "from_environment", return_value=self.drive), patch.object(refresh, "refresh_index", return_value=(new_state, [SOURCE])), patch.object(refresh, "reconcile", return_value=5) as reconcile:
            events.attach_mock(reconcile, "reconcile")
            result = refresh.handler({}, None)
        self.assertEqual(result, {"status": "ready", "jpgCount": 1, "queued": 5})
        self.assertEqual([entry[0] for entry in events.mock_calls], ["state_write", "state_write", "reconcile", "state_write"])
        publish = table.update_item.call_args_list[1].kwargs
        self.assertEqual(publish["ConditionExpression"], "leaseOwner = :owner")
        self.assertEqual(publish["ExpressionAttributeValues"][":pageToken"], "new-token")

    def test_lost_release_lease_cannot_overwrite_the_primary_refresh_failure(self):
        table = Mock()
        table.update_item.side_effect = [{"Attributes": STATE}, error("ConditionalCheckFailedException")]
        with patch.object(refresh, "comparison_table", return_value=table), patch.object(refresh.OriginalDrive, "from_environment", return_value=self.drive), patch.object(refresh, "refresh_index", side_effect=RuntimeError("private original failure")):
            with self.assertRaisesRegex(RuntimeError, "^Original index refresh failed$"):
                refresh.handler({}, None)

    def test_concurrent_coordinator_does_not_contact_drive_and_other_claim_errors_surface(self):
        table = Mock()
        table.update_item.side_effect = error("ConditionalCheckFailedException")
        with patch.object(refresh, "comparison_table", return_value=table), patch.object(refresh.OriginalDrive, "from_environment") as factory:
            self.assertEqual(refresh.handler({}, None), {"status": "busy"})
            factory.assert_not_called()
            table.update_item.side_effect = error("AccessDeniedException")
            with self.assertRaises(ClientError):
                refresh.handler({}, None)

    def test_reconciliation_backfills_existing_photos_and_retries_late_backups_only_for_active_photos(self):
        table = Mock()
        albums = Mock()
        resource = Mock()
        resource.Table.return_value = albums
        album_rows = [ALBUM, {**ALBUM, "albumId": OTHER_ALBUM_ID, "type": "video"}, {**ALBUM, "status": "deleted"}]
        with patch.object(refresh, "comparison_table", return_value=table), patch.object(refresh.boto3, "resource", return_value=resource), patch.object(refresh, "scan_all", side_effect=lambda requested, **kwargs: iter([] if requested is table else album_rows)), patch.object(refresh, "enqueue_original_comparisons", return_value=1) as enqueue:
            self.assertEqual(refresh.reconcile(STATE, [SOURCE]), 1)
        enqueue.assert_called_once_with(ALBUM_ID, [IMAGE])


class OriginalStoreAndDispatchTests(OfflineTestCase):
    def setUp(self):
        super().setUp()
        self.env = patch.dict(os.environ, ENV)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.cache = patch.dict(store._snapshot_cache, {"key": None, "value": None})
        self.cache.start()
        self.addCleanup(self.cache.stop)
        self.resource = Mock()
        self.resource_patch = patch.object(jobs.boto3, "resource", return_value=self.resource)
        self.resource_patch.start()
        self.addCleanup(self.resource_patch.stop)

    def test_snapshot_is_bounded_validated_cached_and_stream_is_closed(self):
        snapshot = {"schemaVersion": 1, "rootId": ROOT_ID, "files": [ROOT, SOURCE]}
        stream = io.BytesIO(gzip.compress(json.dumps(snapshot).encode()))
        client = Mock()
        client.get_object.return_value = {"Body": stream}
        with patch.object(store.boto3, "client", return_value=client):
            self.assertEqual(store.load_snapshot(STATE), snapshot)
            self.assertEqual(store.load_snapshot(STATE), snapshot)
        self.assertTrue(stream.closed)
        client.get_object.assert_called_once_with(Bucket=ENV["ORIGINAL_PREVIEW_BUCKET"], Key=INDEX_KEY)

    def test_cached_snapshot_still_rejects_changed_root_and_noncanonical_keys(self):
        snapshot = {"schemaVersion": 1, "rootId": ROOT_ID, "files": [ROOT, SOURCE]}
        with patch.dict(store._snapshot_cache, {"key": INDEX_KEY, "value": snapshot}):
            with self.assertRaisesRegex(ValueError, "root changed"):
                store.load_snapshot({**STATE, "rootId": "different-root"})
        with patch.object(store.boto3, "client") as factory:
            for key in ("index/../private.json.gz", "index/unknown.json.gz", "before/" + "a" * 32 + ".json.gz"):
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    store.load_snapshot({**STATE, "indexKey": key})
        factory.assert_not_called()

    def test_invalid_or_oversized_snapshot_never_enters_cache(self):
        client = Mock()
        with patch.object(store.boto3, "client", return_value=client):
            for snapshot in ({"schemaVersion": 2, "rootId": ROOT_ID, "files": []}, {"schemaVersion": 1, "rootId": "other-root", "files": []}):
                stream = io.BytesIO(gzip.compress(json.dumps(snapshot).encode()))
                client.get_object.return_value = {"Body": stream}
                with self.assertRaises(ValueError):
                    store.load_snapshot(STATE)
                self.assertTrue(stream.closed)
            client.get_object.return_value = {"Body": io.BytesIO(gzip.compress(b"x" * 100))}
            with patch.object(store, "MAX_SNAPSHOT_BYTES", 20), self.assertRaisesRegex(ValueError, "size limit"):
                store.load_snapshot(STATE)
        self.assertIsNone(store._snapshot_cache["key"])

    def test_work_decision_retries_late_backups_failures_and_changed_sources(self):
        base = {"rawKey": RAW_KEY, "indexGeneration": STATE["generation"]}
        ready = {**base, "status": "ready", "sourceFileId": SOURCE["id"], "sourceChecksum": CHECKSUM}
        candidates = {SOURCE["id"]: SOURCE}
        self.assertFalse(store.needs_work(IMAGE, ready, candidates, STATE["generation"]))
        self.assertTrue(store.needs_work(IMAGE, ready, {}, STATE["generation"]))
        self.assertTrue(store.needs_work(IMAGE, ready, {SOURCE["id"]: {**SOURCE, "md5Checksum": "b" * 32}}, STATE["generation"]))
        self.assertFalse(store.needs_work(IMAGE, {**base, "status": "unavailable"}, candidates, STATE["generation"]))
        self.assertTrue(store.needs_work(IMAGE, {**base, "status": "unavailable"}, candidates, "new-index"))
        for status in ("pending", "failed", "processing"):
            self.assertTrue(store.needs_work(IMAGE, {**base, "status": status}, candidates, STATE["generation"]))
        self.assertFalse(store.needs_work(IMAGE, {**base, "status": "processing", "leaseUntil": 2000}, candidates, STATE["generation"], now=1000))
        for status in ("pending", "failed", "ready"):
            self.assertFalse(store.needs_work(IMAGE, {**base, "status": status, "leaseUntil": 2000}, {}, "new-generation", now=1000))
        self.assertFalse(store.needs_work(IMAGE, {**base, "status": "pending", "queuedUntil": 2000}, {}, "new-generation", now=1000))
        self.assertTrue(store.needs_work(IMAGE, {**base, "status": "pending", "queuedUntil": 999}, {}, "new-generation", now=1000))

    def test_paginated_scan_preserves_consistency_and_cursor(self):
        table = Mock()
        cursor = {"albumId": ALBUM_ID, "mediaId": MEDIA_ID}
        table.scan.side_effect = [{"Items": ["one"], "LastEvaluatedKey": cursor}, {"Items": ["two"]}]
        self.assertEqual(list(store.scan_all(table, ConsistentRead=True)), ["one", "two"])
        self.assertEqual(table.scan.call_args_list, [call(ConsistentRead=True), call(ConsistentRead=True, ExclusiveStartKey=cursor)])

    def test_repeated_scan_cursor_cannot_run_forever(self):
        table = Mock()
        table.scan.return_value = {"Items": [], "LastEvaluatedKey": {"albumId": ALBUM_ID}}
        with self.assertRaisesRegex(RuntimeError, "scan limit"):
            list(store.scan_all(table))
        self.assertEqual(table.scan.call_count, 1000)

    def test_queue_batches_deduplicate_photos_and_write_only_website_sqs(self):
        client = Mock()
        client.send_message_batch.side_effect = lambda **kwargs: {"Successful": [{"Id": item["Id"]} for item in kwargs["Entries"]]}
        images = [{"rawKey": f"albums/{ALBUM_ID}/original/{index}.jpg"} for index in range(11)]
        with patch.object(jobs.boto3, "client", return_value=client) as factory:
            self.assertEqual(jobs.enqueue_original_comparisons(ALBUM_ID, images + images + [None, {}]), 11)
        factory.assert_called_once_with("sqs")
        self.assertEqual([len(entry.kwargs["Entries"]) for entry in client.send_message_batch.call_args_list], [10, 1])
        for entry in client.send_message_batch.call_args_list:
            self.assertEqual(entry.kwargs["QueueUrl"], ENV["ORIGINAL_COMPARISON_QUEUE_URL"])
            for message in entry.kwargs["Entries"]:
                payload = json.loads(message["MessageBody"])
                self.assertEqual(set(payload), {"albumId", "rawKey"})
                self.assertEqual(payload["albumId"], ALBUM_ID)
        self.assertEqual({entry[0] for entry in client.method_calls}, {"send_message_batch"})
        self.resource.Table.assert_called_with(ENV["ORIGINAL_COMPARISON_TABLE"])
        updates = self.resource.Table.return_value.update_item.call_args_list
        self.assertEqual(len(updates), 11)
        for update in updates:
            self.assertEqual(update.kwargs["ConditionExpression"], "attribute_not_exists(#status) OR #status = :pending")
            self.assertIn("queuedUntil = :until", update.kwargs["UpdateExpression"])

    def test_queue_marker_race_cannot_replace_a_completed_worker_record(self):
        client = Mock()
        client.send_message_batch.return_value = {"Successful": [{"Id": "0"}]}
        self.resource.Table.return_value.update_item.side_effect = error("ConditionalCheckFailedException")
        with patch.object(jobs.boto3, "client", return_value=client):
            self.assertEqual(jobs.enqueue_original_comparisons(ALBUM_ID, [IMAGE]), 1)
        update = self.resource.Table.return_value.update_item.call_args.kwargs
        self.assertEqual(update["ConditionExpression"], "attribute_not_exists(#status) OR #status = :pending")

    def test_disabled_queue_is_noop_and_dispatch_failures_are_best_effort(self):
        with patch.dict(os.environ, {"ORIGINAL_COMPARISON_QUEUE_URL": ""}), patch.object(jobs.boto3, "client") as factory:
            self.assertEqual(jobs.enqueue_original_comparisons(ALBUM_ID, [IMAGE]), 0)
            factory.assert_not_called()
        client = Mock()
        client.send_message_batch.return_value = {"Failed": [{"Id": "0", "Message": "private provider details"}]}
        with patch.object(jobs.boto3, "client", return_value=client):
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                jobs.enqueue_original_comparisons(ALBUM_ID, [IMAGE])
            self.assertEqual(jobs.request_original_comparisons(ALBUM_ID, [IMAGE]), 0)


if __name__ == "__main__":
    unittest.main()
