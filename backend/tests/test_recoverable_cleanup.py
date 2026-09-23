"""Failure injection at each destructive boundary; all data/services are synthetic."""
from copy import deepcopy
from contextlib import ExitStack
import json
import unittest
from unittest.mock import Mock, patch
from botocore.exceptions import ClientError
import test_support
import delete_album
import delete_user
import edit_user
from explore_budget import ExploreBudget, ExploreUnavailable, current_budget, read
import get_public_album

ALBUM = "11111111-1111-4111-8111-111111111111"
RECORD = {"albumId": ALBUM, "images": [], "visibility": "public", "ownerSub": "subject", "ownerEmail": "old@example.com"}


def conflict():
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.record = deepcopy(RECORD)
        self.table = Mock()
        self.table.update_item.side_effect = self.update
        self.table.delete_item.side_effect = self.remove
        self.stack.enter_context(patch.object(delete_album, "table", self.table))
        self.mocks = {}
        for name, result in [("load_preview_metadata", {}), ("preflight_deletion", 0),
                             ("delete_prefix_all_versions", 2), ("invalidate_album_media", True),
                             ("delete_preview_metadata", None), ("delete_album_media", None),
                             ("request_public_api_invalidation", True), ("request_random_photo_pool_refresh", True)]:
            self.mocks[name] = self.stack.enter_context(patch.object(delete_album, name, return_value=result))
        self.retention = self.stack.enter_context(patch.object(delete_album.drive_backup_jobs, "begin_retention", return_value=True))
        self.end_retention = self.stack.enter_context(patch.object(delete_album.drive_backup_jobs, "end_retention"))

    def update(self, **request):
        values = request["ExpressionAttributeValues"]
        if request["UpdateExpression"].startswith("REMOVE"):
            self.assertEqual(self.record["deletionId"], values[":operation"])
            self.assertEqual(self.record["deletionLeaseOwner"], values[":owner"])
            self.record.pop("deletionLeaseOwner", None)
            self.record.pop("deletionLeaseUntil", None)
            return {}
        self.assertIn("attribute_exists(albumId)", request["ConditionExpression"])
        if self.record.get("deletionLeaseUntil", 0) >= values[":now"]:
            raise conflict()
        for name, field in request["ExpressionAttributeNames"].items():
            if not name.startswith("#snapshot"):
                continue
            value = ":" + name[1:]
            if (value in values and self.record.get(field) != values[value]) or (value not in values and field in self.record):
                raise conflict()
        self.record.update(status="deleting", deletionId=values[":operation"],
                           deletionLeaseOwner=values[":owner"], deletionLeaseUntil=values[":until"])
        return {}

    def remove(self, **request):
        self.assertEqual(self.record["status"], "deleting")
        self.assertEqual(self.record["deletionId"], request["ExpressionAttributeValues"][":operation"])
        self.assertIn("deletionLeaseOwner = :owner", request["ConditionExpression"])
        self.record = None

    def test_every_cleanup_failure_keeps_retryable_manifest_and_drive_retirement(self):
        for boundary in ("delete_prefix_all_versions", "invalidate_album_media", "delete_preview_metadata", "delete_album_media"):
            with self.subTest(boundary=boundary):
                self.record = deepcopy(RECORD)
                self.mocks[boundary].side_effect = RuntimeError("provider unavailable")
                with self.assertRaises(RuntimeError):
                    delete_album.delete_album_record(deepcopy(self.record))
                self.assertEqual(self.record["status"], "deleting")
                self.assertEqual(self.record["images"], RECORD["images"])
                operation = self.record["deletionId"]
                self.assertNotIn("deletionLeaseOwner", self.record)
                self.assertNotIn(False, [call.args[-1] for call in self.end_retention.call_args_list])
                self.mocks[boundary].side_effect = None
                delete_album.delete_album_record(deepcopy(self.record))
                self.assertIsNone(self.record)
                self.assertEqual(self.table.delete_item.call_args.kwargs["ExpressionAttributeValues"][":operation"], operation)

    def test_active_cleanup_blocks_duplicate_and_transferred_snapshot_before_s3(self):
        self.record.update(status="deleting", deletionId="existing", deletionLeaseUntil=10**12)
        with self.assertRaises(delete_album.DeletionConflict):
            delete_album.delete_album_record(deepcopy(self.record))
        self.mocks["delete_prefix_all_versions"].assert_not_called()
        self.record = {**RECORD, "ownerSub": "new-owner"}
        with self.assertRaises(delete_album.DeletionConflict):
            delete_album.delete_album_record(deepcopy(RECORD))
        self.mocks["delete_prefix_all_versions"].assert_not_called()

    def test_pending_individual_media_cleanup_is_included(self):
        self.record["pendingMediaDeletion"] = {"mediaIds": ["removed"], "indexKeys": {"removed": [{"albumId": "facet", "mediaId": "entry"}]}}
        delete_album.delete_album_record(deepcopy(self.record))
        self.mocks["delete_preview_metadata"].assert_called_once_with(ALBUM, {"removed"}, {"removed": [{"albumId": "facet", "mediaId": "entry"}]})

    def test_retention_commit_failure_keeps_album_for_retry(self):
        self.end_retention.side_effect = RuntimeError("state unavailable")
        with self.assertRaises(RuntimeError):
            delete_album.delete_album_record(deepcopy(self.record))
        self.assertEqual(self.record["status"], "deleting")
        self.table.delete_item.assert_not_called()


class OwnershipTests(unittest.TestCase):
    def test_email_update_skips_removed_or_transferred_rows_without_counting_them(self):
        table = Mock()
        table.update_item.side_effect = [conflict(), {}]
        with patch.object(edit_user, "require_admin", return_value=None), patch.object(edit_user, "verify_front_door_request", return_value=None), patch.object(edit_user, "cognito_identity", return_value=("user", "subject", {})), patch.object(edit_user, "assert_admin_target_mutable"), patch.object(edit_user, "albums_owned_by", return_value=[RECORD, RECORD]), patch.object(edit_user, "table", table):
            response = edit_user.handler({"pathParameters": {"email": "old@example.com"}, "body": json.dumps({"email": "old@example.com"})}, None)
        self.assertEqual(test_support.response_body(response)["albumsUpdated"], 1)
        condition = table.update_item.call_args.kwargs["ConditionExpression"]
        for required in ("attribute_exists(albumId)", "#status = :active", "ownerSub = :ownerSub", "attribute_not_exists(ownerSub) AND ownerEmail = :oldEmail"):
            self.assertIn(required, condition)

    def test_user_deletion_keeps_identity_on_cleanup_failure_and_skips_transferred_rows(self):
        with ExitStack() as stack:
            for name, value in [("require_admin", None), ("verify_front_door_request", None), ("assert_admin_target_mutable", None), ("preflight_deletion", None), ("cognito_identity", ("user", "subject", {})), ("albums_owned_by", [RECORD])]:
                stack.enter_context(patch.object(delete_user, name, return_value=value))
            table = stack.enter_context(patch.object(delete_user, "table"))
            table.get_item.return_value = {"Item": RECORD}
            cleanup = stack.enter_context(patch.object(delete_user, "delete_album_record", side_effect=RuntimeError("S3")))
            identity = stack.enter_context(patch.object(delete_user.cognito, "admin_delete_user"))
            event = {"pathParameters": {"email": "old@example.com"}}
            self.assertEqual(delete_user.handler(event, None)["statusCode"], 500)
            identity.assert_not_called()
            cleanup.reset_mock()
            table.get_item.return_value = {"Item": {**RECORD, "ownerSub": "other"}}
            response = delete_user.handler(event, None)
            self.assertEqual(test_support.response_body(response)["albumsDeleted"], 0)
            cleanup.assert_not_called()
            identity.assert_called_once()


class ExploreBudgetTests(unittest.TestCase):
    def test_scan_and_read_caps_are_shared_without_returning_partial_results(self):
        budget = ExploreBudget(reads=3, scans=1)
        token = current_budget.set(budget)
        self.addCleanup(current_budget.reset, token)
        service = Mock(return_value={})
        read(service, _scan=True)
        with self.assertRaises(ExploreUnavailable):
            read(service, _scan=True)
        service.assert_called_once()
        read(service)
        read(service)
        with self.assertRaises(ExploreUnavailable):
            read(service)

    def test_parallel_facet_workers_share_one_budget(self):
        budget = ExploreBudget(reads=2)
        token = current_budget.set(budget)
        self.addCleanup(current_budget.reset, token)
        client = Mock()
        client.query.return_value = {"Count": 1}
        with patch.object(get_public_album, "dynamodb_client", client), patch.dict(get_public_album.os.environ, {"PREVIEW_METADATA_TABLE": "previews"}):
            with self.assertRaises(ExploreUnavailable):
                get_public_album._parallel_partition_counts(["a", "b", "c", "d"])
        self.assertEqual(client.query.call_count, 2)

    def test_fallback_scan_stops_at_eight_pages_and_returns_no_partial_gallery(self):
        previews = Mock()
        previews.scan.return_value = {"Items": [], "LastEvaluatedKey": {"albumId": "next", "mediaId": "next"}}
        with patch.object(get_public_album, "_explore_index_ready", return_value=False), patch.object(get_public_album, "_preview_table", return_value=previews):
            result = get_public_album._explore_response({"queryStringParameters": {"mode": "colors"}})
        self.assertEqual(result["statusCode"], 503)
        self.assertEqual(previews.scan.call_count, 8)
        self.assertNotIn("items", test_support.response_body(result))
        self.assertTrue(all(call.kwargs["Limit"] == 1000 for call in previews.scan.call_args_list))

    def test_expired_request_returns_retryable_response_and_resets_context(self):
        context = Mock()
        context.get_remaining_time_in_millis.return_value = 1000
        with patch.object(get_public_album, "_explore_response_inner", return_value={"statusCode": 200, "body": "partial"}):
            result = get_public_album._explore_response({}, context)
        self.assertEqual(result["statusCode"], 503)
        self.assertEqual(test_support.response_body(result)["code"], "explore_unavailable")
        self.assertIsNone(current_budget.get())
