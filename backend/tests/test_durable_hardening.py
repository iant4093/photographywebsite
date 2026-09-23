"""Stateful regressions for cleanup completion and bounded continuations."""
import io
import json
import os
import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock, patch

import test_support
from botocore.exceptions import ClientError
import test_publication_recovery as fixture
from test_publication_recovery import ALBUM, RAW, THUMB, NEW, RECORD, CONTEXT
import cache_invalidation, cleanup_work, video_cleanup, visibility_change
import delete_album, delete_images, delete_user, update_image, tag_media_object
import get_album_media, album_media_store, cache_invalidation_worker
from validation_helpers import ValidationError


class DurableHardeningTests(unittest.TestCase):
    setUp = fixture.PublicationRecoveryTests.setUp
    put = fixture.PublicationRecoveryTests.put
    album = fixture.PublicationRecoveryTests.album
    event = fixture.PublicationRecoveryTests.event
    object = fixture.PublicationRecoveryTests.object
    tag = fixture.PublicationRecoveryTests.tag
    s3_event = fixture.PublicationRecoveryTests.s3_event

    def provider_purge(self):
        self.stack.enter_context(patch.dict(os.environ, {"IMAGES_DISTRIBUTION_ID": "media-distribution"}))
        self.stack.enter_context(patch.object(cleanup_work, "prepare_media_revocation", cache_invalidation.prepare_media_revocation))
        self.stack.enter_context(patch.object(cleanup_work, "advance_media_revocation", cache_invalidation.advance_media_revocation))
        client = self.stack.enter_context(patch.object(cache_invalidation, "_client")).return_value
        client.create_invalidation.return_value = {"Invalidation": {"Id": "purge", "Status": "InProgress"}}
        client.get_invalidation.return_value = {"Invalidation": {"Id": "purge", "Status": "Completed"}}
        return client

    def tagging_message(self):
        message = json.loads(self.queue.return_value.send_message.call_args.kwargs["MessageBody"])
        message.pop("version")
        message["source"] = message.pop("kind")
        return message

    def test_tagging_busy_uses_delayed_retry_then_rechecks_current_privacy(self):
        self.object(RAW)
        self.put({**RECORD, "status": "updating"})
        self.assertEqual(tag_media_object.handler(self.s3_event(RAW), CONTEXT), {"tagged": 0})
        message = self.tagging_message()
        self.assertEqual(self.queue.return_value.send_message.call_args.kwargs["DelaySeconds"], 30)
        self.assertEqual(self.tag(RAW), "pending")
        self.put({**RECORD, "visibility": "private"})
        self.assertEqual(tag_media_object.handler(message, CONTEXT)["statusCode"], 200)
        self.assertEqual(self.tag(RAW), "private")
        tag_media_object.handler(message, CONTEXT)
        self.assertEqual(self.tag(RAW), "private")

    def test_tagging_deleted_or_missing_album_never_publishes_or_deletes_initial_upload(self):
        self.object(RAW)
        self.put({**RECORD, "status": "updating"})
        tag_media_object.handler(self.s3_event(RAW), CONTEXT)
        message = self.tagging_message()
        self.queue.reset_mock()
        for status in ("deleting", None):
            if status: self.put({**RECORD, "status": status})
            else: self.table.delete_item(Key={"albumId": ALBUM})
            self.assertEqual(tag_media_object.handler(message, CONTEXT)["statusCode"], 200)
            self.assertEqual(self.tag(RAW), "pending")
        self.queue.return_value.send_message.assert_not_called()

    def test_tagging_dispatch_failure_expires_and_invalid_scope_do_not_acknowledge_lost_work(self):
        self.put({**RECORD, "status": "updating"})
        self.queue.return_value.send_message.side_effect = RuntimeError("send failed")
        with self.assertRaises(RuntimeError): tag_media_object.handler(self.s3_event(RAW), CONTEXT)
        message = self.tagging_message()
        self.queue.return_value.send_message.side_effect = None
        with patch.object(tag_media_object.time, "time", return_value=message["firstAttemptAt"] + 86400):
            with self.assertRaisesRegex(RuntimeError, "expired"): tag_media_object.handler(message, CONTEXT)
        with self.assertRaises(ValueError): tag_media_object.handler({**message, "albumId": "different"}, CONTEXT)

    def test_media_delete_retains_receipt_until_completed_cdn_purge_and_resumes_without_browser(self):
        client = self.provider_purge()
        self.object(RAW, "public"); self.object(THUMB, "public")
        with patch.object(cache_invalidation.time, "time", return_value=1000) as clock:
            response = delete_images.handler(self.event({"keys": [RAW]}), CONTEXT)
            self.assertEqual(response["statusCode"], 202, response)
            self.assertEqual(self.album()["images"], [])
            self.assertEqual(self.album()["pendingMediaDeletion"]["invalidation"]["id"], "purge")
            self.assertEqual(delete_images.handler(self.event({"keys": [RAW]}), CONTEXT)["statusCode"], 202)
            client.get_invalidation.assert_not_called()
            clock.return_value = 1031
            response = delete_images.handler({"source": "album-media-deletion", "albumId": ALBUM}, CONTEXT)
            self.assertEqual(response["statusCode"], 200, response)
            self.assertNotIn("pendingMediaDeletion", self.album())
        client.create_invalidation.assert_called_once()
        client.get_invalidation.assert_called_once()
        self.assertEqual(delete_images.handler({"source": "album-media-deletion", "albumId": ALBUM}, CONTEXT)["statusCode"], 200)
        browser = delete_images.handler(self.event({"keys": [RAW]}), CONTEXT)
        self.assertEqual(browser["statusCode"], 200)
        self.assertEqual(json.loads(browser["body"])["album"]["coverThumbnailUrl"], "")

    def test_album_delete_keeps_hidden_tombstone_until_cdn_completion(self):
        client = self.provider_purge()
        with patch.object(cache_invalidation.time, "time", return_value=1000) as clock:
            self.assertEqual(delete_album.handler(self.event({}), CONTEXT)["statusCode"], 202)
            self.assertEqual(self.album()["status"], "deleting")
            self.assertNotIn("deletionLeaseOwner", self.album())
            self.assertEqual(delete_album.handler(self.event({}), CONTEXT)["statusCode"], 202)
            clock.return_value = 1031
            self.assertEqual(delete_album.handler({"source": "album-deletion", "albumId": ALBUM}, CONTEXT)["statusCode"], 200)
            self.assertIsNone(self.album())
        client.create_invalidation.assert_called_once()

    def test_thumbnail_replacement_waits_for_purge_without_changing_new_reference(self):
        client = self.provider_purge()
        for key in (RAW, THUMB, NEW): self.object(key, "public")
        request = self.event({"rawKey": RAW, "thumbKey": NEW})
        with patch.object(cache_invalidation.time, "time", return_value=1000) as clock:
            self.assertEqual(update_image.handler(request, CONTEXT)["statusCode"], 202)
            self.assertEqual(self.album()["images"][0]["thumbKey"], NEW)
            self.assertEqual(update_image.handler(request, CONTEXT)["statusCode"], 202)
            self.assertIn("pendingThumbnailCleanup", self.album())
            clock.return_value = 1016
            self.assertEqual(update_image.handler({"source": "album-thumbnail-cleanup", "albumId": ALBUM}, CONTEXT)["statusCode"], 200)
            self.assertNotIn("pendingThumbnailCleanup", self.album())
            self.assertEqual(update_image.handler(request, CONTEXT)["statusCode"], 200)
        client.create_invalidation.assert_called_once()

    def test_failed_purge_submission_keeps_stable_receipt_and_reuses_caller_reference(self):
        client = self.provider_purge()
        client.create_invalidation.side_effect = [RuntimeError("lost reply"), {"Invalidation": {"Id": "purge", "Status": "Completed"}}]
        self.assertEqual(delete_album.handler(self.event({}), CONTEXT)["statusCode"], 500)
        self.assertIn("invalidation", self.album()["pendingAlbumDeletion"])
        self.assertEqual(delete_album.handler(self.event({}), CONTEXT)["statusCode"], 200)
        self.assertEqual(client.create_invalidation.call_args_list[0], client.create_invalidation.call_args_list[1])

    def test_privacy_polling_coalesces_and_dispatch_failure_can_be_repaired(self):
        pending = {"id": "privacy", "values": {"visibility": "private"}, "remove": [], "phase": "purge", "invalidation": {"id": "purge"}}
        self.put({**RECORD, "status": "updating", "pendingVisibilityChange": pending})
        with patch.object(visibility_change, "advance_media_revocation", return_value=False), patch.object(cleanup_work.time, "time", return_value=1000) as clock:
            self.queue.return_value.send_message.side_effect = RuntimeError("offline")
            with self.assertRaises(RuntimeError): visibility_change.advance(self.table, self.album(), CONTEXT)
            self.assertNotIn("scheduledUntil", self.album()["pendingVisibilityChange"])
            self.queue.return_value.send_message.side_effect = None
            self.queue.reset_mock()
            for _ in range(10): self.assertIsNone(visibility_change.advance(self.table, self.album(), CONTEXT))
            self.queue.return_value.send_message.assert_called_once()
            clock.return_value = 1016
            visibility_change.advance(self.table, self.album(), CONTEXT)
            self.assertEqual(self.queue.return_value.send_message.call_count, 2)
            clock.return_value = 87401
            with self.assertRaises(RuntimeError): visibility_change.advance(self.table, self.album(), CONTEXT)
            self.assertEqual(self.queue.return_value.send_message.call_count, 2)

    def test_current_metadata_does_not_consult_stale_index_even_with_matching_keys(self):
        image = {"rawKey": RAW, "thumbKey": NEW, "altText": "Current description", "isFavorite": True,
                 "captionVtt": "WEBVTT", "transcript": "Current transcript"}
        self.put({**RECORD, "images": [image], "mediaStoreVersion": 1})
        with patch.object(get_album_media, "albums_table", self.table), patch.object(get_album_media, "require_admin", return_value=None), patch.object(get_album_media, "verify_front_door_request", return_value=None), patch.object(get_album_media, "serialize_album_detail", return_value={}), patch.object(get_album_media, "serialize_images", side_effect=lambda album, **_: album["images"]), patch.object(album_media_store, "query_album_media", return_value=([{"rawKey": RAW, "thumbKey": THUMB}], None)) as query:
            response = get_album_media.handler(self.event({}), CONTEXT)
        self.assertEqual(json.loads(response["body"])["items"], [image])
        query.assert_not_called()

    def video_record(self):
        key = RAW.replace(".jpg", ".mp4")
        album = {**RECORD, "visibility": "private", "type": "video", "images": [{"rawKey": key, "mediaConvertJobId": "job"}]}
        return album, key

    def test_running_video_album_keeps_cleanup_intent_and_sweeps_late_outputs(self):
        album, key = self.video_record(); self.put(album); self.object(key)
        provider = Mock()
        job = {"Id": "job", "Settings": {"Inputs": [{"FileInput": "s3://images-test/" + key}]}, "Status": "PROGRESSING"}
        provider.get_job.return_value = {"Job": job}
        with patch.object(video_cleanup, "client", return_value=provider), patch.object(video_cleanup.time, "time", return_value=1000) as clock:
            self.assertEqual(delete_album.handler(self.event({}), CONTEXT)["statusCode"], 202)
            provider.cancel_job.assert_not_called()
            self.assertEqual(self.album()["status"], "deleting")
            late_key = key.rsplit(".", 1)[0] + "_hls/late.ts"
            self.object(late_key)
            tag_media_object.handler(self.s3_event(late_key), CONTEXT)
            self.assertEqual(self.tag(late_key), "pending")
            job["Status"] = "COMPLETE"; clock.return_value = 1031
            self.assertEqual(delete_album.handler({"source": "album-deletion", "albumId": ALBUM}, CONTEXT)["statusCode"], 200)
            self.assertIsNone(self.album())
            self.assertEqual(self.s3.list_objects_v2(Bucket="images-test").get("KeyCount"), 0)

    def test_queued_video_media_cancel_is_confirmed_before_final_cleanup(self):
        album, key = self.video_record(); self.put(album); self.object(key)
        provider = Mock()
        job = {"Id": "job", "Settings": {"Inputs": [{"FileInput": "s3://images-test/" + key}]}, "Status": "SUBMITTED"}
        provider.get_job.return_value = {"Job": job}
        with patch.object(video_cleanup, "client", return_value=provider), patch.object(video_cleanup.time, "time", return_value=1000) as clock:
            self.assertEqual(delete_images.handler(self.event({"keys": [key]}), CONTEXT)["statusCode"], 202)
            provider.cancel_job.assert_called_once_with(Id="job")
            self.assertEqual(self.album()["images"], [])
            self.assertIn("pendingMediaDeletion", self.album())
            job["Status"] = "CANCELED"; clock.return_value = 1031
            self.assertEqual(delete_images.handler({"source": "album-media-deletion", "albumId": ALBUM}, CONTEXT)["statusCode"], 200)
            self.assertNotIn("pendingMediaDeletion", self.album())

    def test_cascade_never_deletes_account_until_album_cleanup_finishes(self):
        with patch.object(delete_user, "verify_front_door_request", return_value=None), patch.object(delete_user, "require_admin", return_value=None), patch.object(delete_user, "cognito_identity", return_value=("username", fixture.SUB, {})), patch.object(delete_user, "assert_admin_target_mutable"), patch.object(delete_user.user_deletion, "begin"), patch.object(delete_user.user_deletion, "advance", return_value=False), patch.object(delete_user.cognito, "admin_delete_user") as erase:
            response = delete_user.handler({"pathParameters": {"email": "owner@example.test"}}, CONTEXT)
        self.assertEqual(response["statusCode"], 202)
        erase.assert_not_called()

    def check_background_audit(self, module, kind, body):
        event = self.event(body)
        event['requestContext'] = {'authorizer': {'jwt': {'claims': {'cognito:groups': ['Admins']}}}}
        with patch.object(cleanup_work, 'advance_media_revocation', side_effect=[False, True, True]), \
             patch.object(cleanup_work, 'emit_audit_event', side_effect=[False, True]) as emit:
            self.assertEqual(module.handler(event, CONTEXT)['statusCode'], 202)
            internal = {'source':kind, 'albumId':ALBUM}
            # Logging failure cannot discard the durable completion receipt.
            with self.assertRaises(RuntimeError): module.handler(internal, CONTEXT)
            field = 'pendingMediaDeletion' if module is delete_images else 'pendingAlbumDeletion'
            self.assertTrue(self.album()[field]['cleanupComplete'])
            self.assertNotIn('claims', str(self.album()[field]))
            self.assertEqual(module.handler(internal, CONTEXT)['statusCode'], 200)
        self.assertEqual(emit.call_count, 2)
        for call in emit.call_args_list:
            self.assertEqual(call.kwargs['actor_type'], 'admin')
            self.assertEqual(call.kwargs['auth_method'], 'jwt')
        self.assertEqual(emit.call_args_list[0].kwargs['event'], emit.call_args_list[1].kwargs['event'])

    def test_background_album_audit_preserves_actor_and_survives_emission_failure(self):
        self.check_background_audit(delete_album, 'album-deletion', {})

    def test_background_media_audit_preserves_actor_and_survives_emission_failure(self):
        self.check_background_audit(delete_images, 'album-media-deletion', {'keys':[RAW]})

    def test_oversized_cleanup_receipt_is_rejected_before_claiming_or_deleting_album(self):
        with patch.object(delete_album, "ensure_album_item_budget", side_effect=ValidationError("too large")), patch.object(delete_album, "delete_prefix_all_versions") as erase:
            response = delete_album.handler(self.event({}), CONTEXT)
        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(self.album()["status"], "active")
        erase.assert_not_called()


class VideoCleanupTests(unittest.TestCase):
    def test_prepared_work_is_never_submitted_by_deletion_and_unknown_tokens_are_retained(self):
        album = {**RECORD, "videoJobs": {"a": {"key": RAW, "phase": "prepared", "token": "token"}}}
        self.assertEqual(video_cleanup.prepare(album, album["images"]), [])
        album["videoJobs"]["a"]["phase"] = "submitting"
        self.assertEqual(video_cleanup.prepare(album, album["images"]), [{"key": RAW, "token": "token"}])

    def test_ambiguous_job_search_retains_pagination_and_accepts_only_matching_source(self):
        pending = {"videoCleanup": [{"key": RAW, "token": "token"}]}
        provider = Mock(); provider.search_jobs.side_effect = [{"NextToken": "page"}, {"Jobs": [{"Id": "found", "UserMetadata": {"dispatchToken": "token"}}]}]
        provider.get_job.return_value = {"Job": {"Status": "COMPLETE", "Settings": {"Inputs": [{"FileInput": "s3://images-test/" + RAW}]}}}
        save = Mock()
        with patch.dict(os.environ, {"IMAGES_BUCKET": "images-test"}), patch.object(video_cleanup, "client", return_value=provider), patch.object(video_cleanup.time, "time", return_value=1000) as clock:
            self.assertFalse(video_cleanup.settle(RECORD, pending, save))
            self.assertEqual(pending["videoCleanup"][0]["searchToken"], "page")
            self.assertFalse(video_cleanup.settle(RECORD, pending, save))
            clock.return_value = 1031
            self.assertTrue(video_cleanup.settle(RECORD, pending, save))
            self.assertEqual(provider.search_jobs.call_args.kwargs["NextToken"], "page")
            self.assertTrue(video_cleanup.settle(RECORD, pending, save))
        provider.cancel_job.assert_not_called()
        provider.create_job.assert_not_called()

    def test_unknown_job_never_becomes_an_unbounded_retry_or_blind_delete(self):
        pending = {"videoCleanup": [{"key": RAW, "token": "token"}]}
        provider = Mock(); provider.search_jobs.return_value = {"Jobs": []}
        with patch.object(video_cleanup, "client", return_value=provider), patch.object(video_cleanup.time, "time", return_value=1000) as clock:
            self.assertFalse(video_cleanup.settle(RECORD, pending, Mock()))
            clock.return_value = 87401
            with self.assertRaises(RuntimeError): video_cleanup.settle(RECORD, pending, Mock())
        self.assertFalse(pending["videoCleanup"][0].get("complete"))

    def test_cancel_race_and_wrong_source_fail_closed(self):
        provider = Mock(); provider.get_job.return_value = {"Job": {"Status": "SUBMITTED", "Settings": {"Inputs": [{"FileInput": "s3://images-test/" + RAW}]}}}
        pending = {"videoCleanup": [{"key": RAW, "jobId": "job"}]}
        with patch.dict(os.environ, {"IMAGES_BUCKET": "images-test"}), patch.object(video_cleanup, "client", return_value=provider):
            provider.cancel_job.side_effect = ClientError({"Error": {"Code": "BadRequestException"}}, "CancelJob")
            self.assertFalse(video_cleanup.settle(RECORD, pending, Mock()))
            pending.pop("videoCheckAfter"); provider.get_job.return_value["Job"]["Settings"]["Inputs"] = []
            with self.assertRaisesRegex(RuntimeError, "source"): video_cleanup.settle(RECORD, pending, Mock())

    def test_large_job_list_rotates_bounded_checks_without_starving_later_jobs(self):
        pending = {"videoCleanup": [{"key": RAW, "jobId": str(index)} for index in range(20)]}
        provider = Mock(); provider.get_job.return_value = {"Job": {"Status": "PROGRESSING", "Settings": {"Inputs": [{"FileInput": "s3://images-test/" + RAW}]}}}
        with patch.dict(os.environ, {"IMAGES_BUCKET": "images-test"}), patch.object(video_cleanup, "client", return_value=provider), patch.object(video_cleanup.time, "time", return_value=1000) as clock:
            for turn in range(3):
                clock.return_value = 1000 + 31 * turn
                self.assertFalse(video_cleanup.settle(RECORD, pending, Mock()))
        self.assertEqual({call.kwargs["Id"] for call in provider.get_job.call_args_list}, {str(i) for i in range(20)})
        self.assertEqual(provider.get_job.call_count, 24)

    def test_expired_provider_job_history_does_not_block_old_album_deletion(self):
        pending = {"videoCleanup": [{"key": RAW, "jobId": "old-job"}]}
        provider = Mock(); provider.get_job.side_effect = ClientError({"Error": {"Code": "NotFoundException"}}, "GetJob")
        with patch.object(video_cleanup, "client", return_value=provider):
            self.assertTrue(video_cleanup.settle(RECORD, pending, Mock()))
            pending = {"videoCleanup": [{"key": RAW, "jobId": "old-job"}]}
            provider.get_job.side_effect = ClientError({"Error": {"Code": "ForbiddenException"}}, "GetJob")
            with self.assertRaises(ClientError): video_cleanup.settle(RECORD, pending, Mock())
            self.assertFalse(pending["videoCleanup"][0].get("complete"))

    def test_queue_routes_include_distinct_tagging_keys_and_both_deletion_handlers(self):
        bodies = [{"version": 1, "kind": kind, "albumId": ALBUM, **extra} for kind, extra in (
            ("album-deletion", {}), ("album-media-deletion", {}),
            ("album-object-tagging", {"key": RAW, "firstAttemptAt": 1000, "attempt": 1}),
            ("album-object-tagging", {"key": THUMB, "firstAttemptAt": 1000, "attempt": 1}))]
        with patch.object(cache_invalidation_worker, "_continue_album_work") as resume:
            result = cache_invalidation_worker.handler({"Records": [{"messageId": str(i), "body": json.dumps(body)} for i, body in enumerate(bodies)]}, None)
        self.assertEqual(resume.call_count, 4)
        self.assertEqual(result["batchItemFailures"], [])
        with patch.dict(os.environ, {"TAGGING_WORKER_FUNCTION_NAME": "tagger"}), patch.object(cache_invalidation_worker.boto3.session, "Session") as factory:
            factory.return_value.client.return_value.invoke.return_value = {"Payload": io.BytesIO(b'{"statusCode":200}')}
            cache_invalidation_worker._continue_album_work(bodies[2])
            payload = json.loads(factory.return_value.client.return_value.invoke.call_args.kwargs["Payload"])
        self.assertEqual(payload["source"], "album-object-tagging")
        self.assertEqual(payload["key"], RAW)
