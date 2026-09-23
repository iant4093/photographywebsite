"""Stateful local AWS emulation for publication races and interrupted mutations."""
from contextlib import ExitStack
from contextvars import Context
from copy import deepcopy
import io
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import test_support
import boto3
from botocore.exceptions import ClientError
from moto import mock_aws

import add_images, album_media_store, cache_invalidation_worker, delete_images, delete_album
import deletion_helpers, media_access, media_mutation, owner_helpers, tag_media_object, update_album, update_image
import upload_followup, user_email_update, visibility_change, zip_archive_refresh

ALBUM = "11111111-1111-4111-8111-111111111111"
SUB = "22222222-2222-4222-8222-222222222222"
RAW = f"albums/{ALBUM}/original/photo.jpg"
THUMB = f"albums/{ALBUM}/thumbnail/old.jpg"
NEW = f"albums/{ALBUM}/thumbnail/new.jpg"
RECORD = {"albumId": ALBUM, "status": "active", "visibility": "public", "type": "photo", "title": "Example",
          "images": [{"rawKey": RAW, "thumbKey": THUMB}], "imageCount": 1, "coverImageUrl": RAW, "coverThumbKey": THUMB}
CONTEXT = SimpleNamespace(get_remaining_time_in_millis=lambda: 60_000)


class PublicationRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(mock_aws())
        self.stack.enter_context(patch.dict(os.environ, {"MEDIA_MUTATION_PROTOCOL": "1", "ALBUM_MEDIA_TABLE": "media-test",
            "PREVIEW_METADATA_TABLE": "", "DRIVE_BACKUP_STATE_TABLE": "", "ALBUM_INDEX_DEPLOYMENT_PHASE": "none",
            "GOOGLE_DRIVE_SYNC_FUNCTION_NAME": "", "RANDOM_PHOTO_REFRESH_QUEUE_URL": "queue", "IMAGES_BUCKET": "images-test"}))
        db = boto3.resource("dynamodb", region_name="us-west-2")
        self.table = db.create_table(TableName="albums-test", KeySchema=[{"AttributeName": "albumId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "albumId", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST")
        self.media = db.create_table(TableName="media-test", KeySchema=[{"AttributeName": "albumId", "KeyType": "HASH"}, {"AttributeName": "mediaId", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "albumId", "AttributeType": "S"}, {"AttributeName": "mediaId", "AttributeType": "S"}, {"AttributeName": "orderKey", "AttributeType": "S"}],
            GlobalSecondaryIndexes=[{"IndexName": "AlbumOrderIndex", "KeySchema": [{"AttributeName": "albumId", "KeyType": "HASH"}, {"AttributeName": "orderKey", "KeyType": "RANGE"}], "Projection": {"ProjectionType": "ALL"}}], BillingMode="PAY_PER_REQUEST")
        self.s3 = boto3.client("s3", region_name="us-west-2")
        self.s3.create_bucket(Bucket="images-test", CreateBucketConfiguration={"LocationConstraint": "us-west-2"})
        self.stack.enter_context(patch.object(media_access, "_s3", self.s3))
        self.stack.enter_context(patch.object(deletion_helpers, "s3", self.s3))
        self.stack.enter_context(patch.object(owner_helpers, "table", self.table))
        for module in (add_images, delete_images, delete_album, tag_media_object, update_album, update_image):
            self.stack.enter_context(patch.object(module, "table", self.table))
            for name in ("require_admin", "verify_front_door_request", "_audit"):
                if hasattr(module, name):
                    self.stack.enter_context(patch.object(module, name, return_value=None))
        self.stack.enter_context(patch.object(add_images, "_extract_exif"))
        self.queue = self.stack.enter_context(patch.object(visibility_change, "_queue_client"))
        self.stack.enter_context(patch.dict(os.environ, {"CACHE_INVALIDATION_QUEUE_URL": "queue"}))
        self.stack.enter_context(patch.object(visibility_change, "invalidate_album_media", return_value=True))
        self.stack.enter_context(patch.object(update_image, "invalidate_album_media", return_value=True))
        for module in (add_images, update_image, update_album, upload_followup):
            for name in ("request_public_api_invalidation", "request_random_photo_pool_refresh", "request_hover_preview_refresh", "_sync_drive_folder"):
                if hasattr(module, name): self.stack.enter_context(patch.object(module, name, return_value=True))
        self.preview = self.stack.enter_context(patch.object(upload_followup, "enqueue_preview_jobs", return_value=1))
        self.comparison = self.stack.enter_context(patch.object(upload_followup, "enqueue_original_comparisons", return_value=1))
        self.put(RECORD)

    def put(self, value):
        self.table.put_item(Item=deepcopy(value))

    def album(self):
        return self.table.get_item(Key={"albumId": ALBUM}, ConsistentRead=True).get("Item")

    def object(self, key, tag="pending"):
        self.s3.put_object(Bucket="images-test", Key=key, Body=b"synthetic", Tagging=f"visibility={tag}")

    def tag(self, key):
        return dict((x["Key"], x["Value"]) for x in self.s3.get_object_tagging(Bucket="images-test", Key=key)["TagSet"])["visibility"]

    def event(self, body):
        return {"pathParameters": {"albumId": ALBUM}, "body": json.dumps(body)}

    def s3_event(self, key):
        return {"Records": [{"s3": {"bucket": {"name": "images-test"}, "object": {"key": key}}}]}

    def test_lease_excludes_another_invocation_and_never_recreates_a_missing_album(self):
        with media_mutation.album_lease(self.table, ALBUM, CONTEXT):
            leased = self.album()
            self.assertGreaterEqual(leased["mediaLeaseUntil"], 60)
            with self.assertRaises(media_mutation.MediaMutationBusy):
                Context().run(lambda: media_mutation.album_lease(self.table, ALBUM, CONTEXT).__enter__())
            with media_mutation.album_lease(self.table, ALBUM, CONTEXT):
                self.assertEqual(self.album()["mediaLeaseOwner"], leased["mediaLeaseOwner"])
        self.assertNotIn("mediaLeaseOwner", self.album())
        self.table.delete_item(Key={"albumId": ALBUM})
        with self.assertRaises(media_mutation.MediaAlbumMissing):
            with media_mutation.album_lease(self.table, ALBUM): pass
        self.assertIsNone(self.album())

    def test_failed_release_does_not_release_a_different_owner_and_expired_lease_can_recover(self):
        with media_mutation.album_lease(self.table, ALBUM, CONTEXT):
            self.table.update_item(Key={"albumId": ALBUM}, UpdateExpression="SET mediaLeaseOwner = :owner, mediaLeaseUntil = :until", ExpressionAttributeValues={":owner": "different", ":until": 0})
        self.assertEqual(self.album()["mediaLeaseOwner"], "different")
        with media_mutation.album_lease(self.table, ALBUM, CONTEXT): pass
        self.assertNotIn("mediaLeaseUntil", self.album())

    def test_uncommitted_upload_stays_pending_but_saved_sources_and_derivatives_publish(self):
        for key in (RAW, THUMB, NEW, media_access.expected_preview_keys(ALBUM, RAW)["640"]):
            self.object(key)
            tag_media_object.handler(self.s3_event(key), CONTEXT)
        self.assertEqual(self.tag(RAW), "public")
        self.assertEqual(self.tag(THUMB), "public")
        self.assertEqual(self.tag(NEW), "pending")
        self.assertEqual(self.tag(media_access.expected_preview_keys(ALBUM, RAW)["640"]), "public")
        self.table.delete_item(Key={"albumId": ALBUM})
        self.assertEqual(tag_media_object.handler(self.s3_event(NEW), CONTEXT), {"tagged": 0})
        self.assertEqual(self.tag(NEW), "pending")

    def test_admission_rejects_unrelated_keys_and_preserves_video_and_legacy_cover_support(self):
        video = {**RECORD, "type": "video", "images": [{"rawKey": RAW.replace('.jpg', '.mp4')}]}
        for extension in ('m3u8', 'ts', 'm4s', 'mp4'):
            self.assertTrue(media_mutation.object_is_committed(video, RAW.rsplit('.', 1)[0] + '_hls/output.' + extension))
        self.assertFalse(media_mutation.object_is_committed(video, RAW.rsplit('.', 1)[0] + '_hls/other.exe'))
        self.assertFalse(media_mutation.object_is_committed(RECORD, 'albums/other/private.jpg'))
        self.assertFalse(media_mutation.object_is_committed({**RECORD, 'images': [{}]}, NEW))

    def test_tag_event_cannot_overlap_privacy_change_or_republish_private_objects(self):
        self.object(RAW, "public")
        with media_mutation.album_lease(self.table, ALBUM, CONTEXT):
            with self.assertRaises(media_mutation.MediaMutationBusy):
                Context().run(tag_media_object.handler, self.s3_event(RAW), CONTEXT)
            self.table.update_item(Key={"albumId": ALBUM}, UpdateExpression="SET visibility = :value", ExpressionAttributeValues={":value": "private"})
            media_access.tag_keys_visibility([RAW], "private")
        tag_media_object.handler(self.s3_event(RAW), CONTEXT)
        self.assertEqual(self.tag(RAW), "private")

    def test_privacy_transition_includes_orphans_and_preserves_pending_upload_cleanup(self):
        for key, tag in ((RAW, "public"), (THUMB, "public"), (NEW, "pending"), (f"albums/{ALBUM}/preview/v3/orphan.webp", "public")):
            self.object(key, tag)
        body = {"visibility": "private", "ownerEmail": "customer@example.test", "ownerSub": SUB}
        response = update_album.handler(self.event(body), CONTEXT)
        self.assertEqual(response["statusCode"], 200, response)
        self.assertEqual(self.album()["visibility"], "private")
        self.assertEqual(self.album()["status"], "active")
        self.assertNotIn("pendingVisibilityChange", self.album())
        self.assertEqual(self.tag(RAW), "private")
        self.assertEqual(self.tag(f"albums/{ALBUM}/preview/v3/orphan.webp"), "private")
        self.assertEqual(self.tag(NEW), "pending")

    def test_release_to_public_does_not_publish_uncommitted_protected_or_pending_objects(self):
        target = {**RECORD, "visibility": "public"}
        self.object(RAW, "private"); self.object(NEW, "private")
        media_access.retag_album_objects(target, [RAW, NEW], "public")
        self.assertEqual(self.tag(RAW), "public")
        self.assertEqual(self.tag(NEW), "pending")

    def test_5002_video_objects_resume_past_old_cap_and_do_not_commit_early(self):
        album = {**RECORD, "type": "video", "images": [{"rawKey": RAW.replace('.jpg', '.mp4')}]}
        self.put(album)
        target = {**album, "visibility": "unlisted", "shareCode": "secret", "isShared": True}
        pages = Mock()
        keys = [RAW.rsplit('.', 1)[0] + f"_hls/{index:05}.ts" for index in range(5002)]
        def page(**params):
            start = int(params.get("ContinuationToken", "0")); end = min(len(keys), start + params["MaxKeys"])
            return {"Contents": [{"Key": key} for key in keys[start:end]], "IsTruncated": end < len(keys),
                    **({"NextContinuationToken": str(end)} if end < len(keys) else {})}
        pages.list_objects_v2.side_effect = page
        tagged = set()
        with patch.object(visibility_change, "get_s3_client", return_value=pages), patch.object(visibility_change, "retag_album_objects", side_effect=lambda a, k, v: tagged.update(k)):
            state = visibility_change.begin(self.table, album, target, {"visibility": "unlisted"}, update_album.MUTABLE_FIELDS)
            first = visibility_change.advance(self.table, state, CONTEXT)
            self.assertIsNone(first)
            self.assertEqual(self.album()["status"], "updating")
            attempts = 1
            while first is None and attempts < 20:
                state = self.album(); first = visibility_change.advance(self.table, state, CONTEXT); attempts += 1
            self.assertIsNotNone(first)
            self.assertEqual(len(tagged), 5002)
            visibility_change.commit(self.table, state, first)
        self.assertEqual(self.album()["visibility"], "unlisted")
        self.assertGreater(attempts, 1)

    def test_privacy_provider_or_invalidation_failure_retains_progress_and_blocks_other_writers(self):
        self.object(RAW, "public")
        body = {"visibility": "private", "ownerEmail": "customer@example.test", "ownerSub": SUB}
        with patch.object(visibility_change, "invalidate_album_media", side_effect=RuntimeError("outage")):
            self.assertEqual(update_album.handler(self.event(body), CONTEXT)["statusCode"], 500)
        self.assertEqual(self.album()["status"], "updating")
        self.assertEqual(update_album.handler(self.event({"title": "other"}), CONTEXT)["statusCode"], 409)
        with self.assertRaises(media_mutation.MediaMutationBusy):
            tag_media_object.handler(self.s3_event(RAW), CONTEXT)
        response = update_album.handler(self.event(body), CONTEXT)
        self.assertEqual(response["statusCode"], 200, response)
        self.assertEqual(self.tag(RAW), "private")

    def test_upload_retry_resumes_work_exactly_once_without_duplicate_media(self):
        self.put({**RECORD, "images": [], "imageCount": 0})
        self.object(RAW); self.object(THUMB)
        request = self.event({"images": [{"rawKey": RAW, "thumbKey": THUMB}]})
        with patch.object(upload_followup, "tag_keys_visibility", side_effect=RuntimeError("tag outage")):
            self.assertEqual(add_images.handler(request, CONTEXT)["statusCode"], 500)
        self.assertIn("pendingMediaUpload", self.album())
        response = add_images.handler(request, CONTEXT)
        self.assertEqual(response["statusCode"], 200, response)
        self.assertEqual(len(self.album()["images"]), 1)
        self.preview.assert_called_once(); self.comparison.assert_called_once()
        self.assertNotIn("pendingMediaUpload", self.album())
        self.assertEqual(add_images.handler(request, CONTEXT)["statusCode"], 200)
        self.preview.assert_called_once()

    def test_followup_stage_failure_retries_only_unfinished_stages(self):
        self.put({**RECORD, "images": [], "imageCount": 0})
        self.object(RAW)
        self.preview.side_effect = RuntimeError("queue unavailable")
        request = self.event({"images": [{"rawKey": RAW}]})
        self.assertEqual(add_images.handler(request, CONTEXT)["statusCode"], 500)
        self.assertIn("comparisons", self.album()["pendingMediaUpload"]["done"])
        self.preview.side_effect = None
        self.assertEqual(add_images.handler({"source": "album-upload-followup", "albumId": ALBUM}, CONTEXT)["statusCode"], 200)
        self.comparison.assert_called_once(); self.assertEqual(self.preview.call_count, 2)
        self.assertNotIn("pendingMediaUpload", self.album())

    def test_normalized_failure_leaves_authoritative_reads_enabled_and_repairs_on_worker_retry(self):
        self.put({**RECORD, "mediaStoreVersion": 1})
        album_media_store.replace_album_media(ALBUM, RECORD["images"])
        with patch.object(update_image, "update_album_media", side_effect=RuntimeError("secondary unavailable")):
            response = update_image.handler(self.event({"rawKey": RAW, "isFavorite": True}), CONTEXT)
        self.assertEqual(response["statusCode"], 200, response)
        album = self.album()
        self.assertTrue(album["images"][0]["isFavorite"])
        self.assertNotIn("mediaStoreVersion", album)
        self.assertTrue(album["mediaStoreDirty"])
        add_images.handler({"source": "album-media-sync", "albumId": ALBUM}, CONTEXT)
        self.assertEqual(self.album()["mediaStoreVersion"], 1)
        self.assertNotIn("mediaStoreDirty", self.album())
        self.assertTrue(self.media.get_item(Key={"albumId": ALBUM, "mediaId": media_access.media_id_for_key(RAW)})["Item"]["isFavorite"])

    def test_thumbnail_cleanup_survives_failure_and_retry_deletes_old_key(self):
        for key in (RAW, THUMB, NEW): self.object(key, "public")
        request = self.event({"rawKey": RAW, "thumbKey": NEW})
        with patch.object(update_image, "delete_keys_all_versions", side_effect=RuntimeError("delete outage")):
            self.assertEqual(update_image.handler(request, CONTEXT)["statusCode"], 500)
        self.assertEqual(self.album()["images"][0]["thumbKey"], NEW)
        self.assertIn("pendingThumbnailCleanup", self.album())
        response = update_image.handler(request, CONTEXT)
        self.assertEqual(response["statusCode"], 200, response)
        self.assertNotIn("pendingThumbnailCleanup", self.album())
        with self.assertRaises(ClientError): self.s3.head_object(Bucket="images-test", Key=THUMB)
        self.assertEqual(self.tag(NEW), "public")

    def test_cleanup_never_deletes_a_thumbnail_adopted_by_another_reference(self):
        pending = {"id": "cleanup", "keys": [THUMB], "wasPublic": True}
        self.put({**RECORD, "pendingThumbnailCleanup": pending})
        self.object(THUMB, "public")
        update_image.handler({"source": "album-thumbnail-cleanup", "albumId": ALBUM}, CONTEXT)
        self.assertEqual(self.tag(THUMB), "public")
        self.assertNotIn("pendingThumbnailCleanup", self.album())

    def test_email_retry_uses_stable_identity_and_preserves_legacy_ownership(self):
        self.put({**RECORD, "visibility": "private", "ownerEmail": "old@example.test"})
        cognito = Mock(); cognito.exceptions = boto3.client("cognito-idp", region_name="us-west-2").exceptions
        email = ["old@example.test"]
        def identity(_client, _pool, value):
            if value not in {"stable", SUB, email[0]}:
                raise cognito.exceptions.UserNotFoundException({"Error": {"Code": "UserNotFoundException"}}, "AdminGetUser")
            return "stable", SUB, {"email": email[0]}
        cognito.admin_update_user_attributes.side_effect = lambda **kw: email.__setitem__(0, "new@example.test")
        real_update = self.table.update_item
        failed = [False]
        def write(**kw):
            if kw["UpdateExpression"] == "SET ownerEmail = :newEmail" and not failed[0]:
                failed[0] = True; raise RuntimeError("database outage after Cognito")
            return real_update(**kw)
        with patch.object(user_email_update, "cognito_identity", side_effect=identity), patch.object(user_email_update, "assert_admin_target_mutable"), patch.object(self.table, "update_item", side_effect=write):
            with self.assertRaises(RuntimeError): user_email_update.update(self.table, cognito, "pool", "old@example.test", "new@example.test", {}, {}, CONTEXT)
            self.assertEqual(self.album()["ownerSub"], SUB)
            self.assertEqual(email[0], "new@example.test")
            count = user_email_update.update(self.table, cognito, "pool", "old@example.test", "new@example.test", {}, {}, CONTEXT)
            self.assertEqual(count, 1)
            self.assertEqual(user_email_update.update(self.table, cognito, "pool", "old@example.test", "new@example.test", {"userId": SUB}, {}, CONTEXT), 1)
        self.assertEqual(self.album()["ownerEmail"], "new@example.test")
        cognito.admin_update_user_attributes.assert_called_once()

    def test_deletion_claim_cannot_overlap_any_publisher(self):
        with patch.object(delete_album, "load_preview_metadata", return_value={}), patch.object(delete_album, "preflight_deletion"), patch.object(delete_album, "delete_prefix_all_versions") as destroy:
            with media_mutation.album_lease(self.table, ALBUM, CONTEXT):
                response = Context().run(delete_album.handler, self.event({}), CONTEXT)
            self.assertEqual(response["statusCode"], 409)
            self.assertEqual(self.album()["status"], "active")
            destroy.assert_not_called()

    def test_legacy_upload_retry_uses_saved_thumbnail_instead_of_uncommitted_input(self):
        for key in (RAW, THUMB, NEW): self.object(key)
        response = add_images.handler(self.event({"images": [{"rawKey": RAW, "thumbKey": NEW}]}), CONTEXT)
        self.assertEqual(response["statusCode"], 200, response)
        self.assertEqual(self.tag(THUMB), "public")
        self.assertEqual(self.tag(NEW), "pending")
        self.assertEqual(self.album()["images"][0]["thumbKey"], THUMB)

    def test_email_recovery_refuses_reused_alias_and_changed_stable_account(self):
        key = user_email_update._key("LOOKUP", "old@example.test")
        self.table.put_item(Item={**key, "status": "internal", "payload": {"subject": "another", "username": "other"}})
        cognito = Mock(); cognito.exceptions = boto3.client("cognito-idp", region_name="us-west-2").exceptions
        with patch.object(user_email_update, "cognito_identity", return_value=("stable", SUB, {"email": "old@example.test"})), patch.object(user_email_update, "assert_admin_target_mutable"):
            with self.assertRaises(media_mutation.MediaMutationBusy):
                user_email_update.update(self.table, cognito, "pool", "old@example.test", "new@example.test", {}, {}, CONTEXT)
        with patch.object(user_email_update, "cognito_identity", return_value=("stable", SUB, {"email": "unexpected@example.test"})), patch.object(user_email_update, "assert_admin_target_mutable"):
            with self.assertRaises(media_mutation.MediaMutationBusy):
                user_email_update.update(self.table, cognito, "pool", "old@example.test", "new@example.test", {"userId": SUB}, {}, CONTEXT)
        cognito.admin_update_user_attributes.assert_not_called()

    def test_legacy_empty_album_can_complete_a_privacy_change(self):
        album = {key: value for key, value in RECORD.items() if key not in {"images", "coverImageUrl", "coverThumbKey"}}
        self.put(album)
        result = update_album.handler(self.event({"visibility": "private", "ownerSub": SUB, "ownerEmail": "owner@example.test"}), CONTEXT)
        self.assertEqual(result["statusCode"], 200, result)
        self.assertEqual(self.album()["visibility"], "private")

    def test_visibility_dispatch_failure_keeps_intent_and_same_save_recovers(self):
        self.object(RAW, "public"); self.object(THUMB, "public")
        body = {"visibility": "private", "ownerSub": SUB, "ownerEmail": "owner@example.test"}
        self.queue.return_value.send_message.side_effect = RuntimeError("queue unavailable")
        self.assertEqual(update_album.handler(self.event(body), CONTEXT)["statusCode"], 500)
        self.assertEqual(self.album()["status"], "updating")
        self.assertEqual(update_image.handler(self.event({"rawKey": RAW, "isFavorite": True}), CONTEXT)["statusCode"], 409)
        self.queue.return_value.send_message.side_effect = None
        self.assertEqual(update_album.handler(self.event(body), CONTEXT)["statusCode"], 200)
        self.assertEqual(self.album()["visibility"], "private")
        self.assertEqual(self.tag(RAW), "private")

    def test_queue_continuations_isolate_failures_deduplicate_and_preserve_normal_invalidations(self):
        event = {"Records": [{"messageId": "one", "body": json.dumps({"version": 1, "kind": "album-visibility", "albumId": ALBUM})},
                              {"messageId": "two", "body": json.dumps({"version": 1, "kind": "album-visibility", "albumId": ALBUM})},
                              {"messageId": "catalog", "body": json.dumps({"version": 1, "catalog": True})}]}
        with patch.object(cache_invalidation_worker, "_continue_album_work", side_effect=RuntimeError("busy")) as work, patch.object(cache_invalidation_worker, "invalidate_public_api_batch"):
            result = cache_invalidation_worker.handler(event, CONTEXT)
        work.assert_called_once()
        self.assertTrue(result["invalidated"])
        self.assertEqual(result["batchItemFailures"], [{"itemIdentifier": "one"}, {"itemIdentifier": "two"}])
        with patch.object(cache_invalidation_worker, "_continue_album_work") as work, patch.object(cache_invalidation_worker, "invalidate_public_api_batch"):
            result = cache_invalidation_worker.handler(event, SimpleNamespace(get_remaining_time_in_millis=lambda: 1000))
        work.assert_not_called(); self.assertEqual(len(result["batchItemFailures"]), 2)

    def test_queue_invocation_validates_and_closes_response_stream(self):
        stream = io.BytesIO(b'{"statusCode":202}')
        client = Mock(); client.invoke.return_value = {"Payload": stream}
        with patch.dict(os.environ, {"VISIBILITY_WORKER_FUNCTION_NAME": "existing-worker"}), patch.object(boto3.session.Session, "client", return_value=client):
            cache_invalidation_worker._continue_album_work({"kind": "album-visibility", "albumId": ALBUM})
        self.assertTrue(stream.closed)
        self.assertEqual(json.loads(client.invoke.call_args.kwargs["Payload"]), {"source": "album-visibility", "albumId": ALBUM})

    def test_bookkeeping_stream_writes_do_not_trigger_zip_work(self):
        old = {"albumId": {"S": ALBUM}, "title": {"S": "Example"}}
        event = {"Records": [{"dynamodb": {"Keys": {"albumId": {"S": ALBUM}}, "SequenceNumber": "1", "OldImage": old,
                  "NewImage": {**old, "mediaLeaseOwner": {"S": "worker"}}}}]}
        with patch.object(zip_archive_refresh, "refresh_album") as refresh:
            self.assertEqual(zip_archive_refresh.handler(event, None), {"batchItemFailures": []})
        refresh.assert_not_called()


if __name__ == "__main__": unittest.main()
