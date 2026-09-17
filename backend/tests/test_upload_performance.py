"""Regression coverage for batched authorization and safe create retries."""
import hashlib
import json
import threading
import time
import unittest
from contextlib import ExitStack
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError
from test_support import claims, response_body
from test_album_write_branch_coverage import create_body, album, ALBUM_ID
import create_album
import get_upload_url
import original_comparison_jobs as jobs


class BatchAuthorizationTests(unittest.TestCase):
    def request(self, files, **overrides):
        return {"body": json.dumps({"albumId": ALBUM_ID, "files": files, **overrides})}

    def intent(self, **overrides):
        return {"filename": "photo.jpg", "contentType": "image/jpeg", "size": 1024, "kind": "original", **overrides}

    def test_eight_intents_preserve_order_length_type_and_pending_policy(self):
        files = [self.intent(size=index + 1, kind="thumbnail" if index % 2 else "original", albumId="ignored") for index in range(8)]
        with patch.object(get_upload_url, "require_admin", return_value=None), patch.object(get_upload_url.s3, "generate_presigned_url", return_value="https://upload.example") as sign:
            response = get_upload_url.handler(self.request(files), None)
        self.assertEqual(response["statusCode"], 200)
        uploads = response_body(response)["uploads"]
        self.assertEqual(len({upload["key"] for upload in uploads}), 8)
        for index, upload in enumerate(uploads):
            self.assertTrue(upload["key"].startswith(f"albums/{ALBUM_ID}/{files[index]['kind']}/"))
            self.assertEqual(upload["requiredHeaders"], {"Content-Type": "image/jpeg", "x-amz-tagging": "visibility=pending"})
            params = sign.call_args_list[index].kwargs["Params"]
            self.assertEqual(params["ContentLength"], index + 1)
            self.assertEqual(params["Tagging"], "visibility=pending")

    def test_entire_batch_validated_before_any_signature_and_admin_still_required(self):
        for files in [[], [self.intent()] * 9, "invalid", [None], [self.intent(), self.intent(size=0)], [self.intent(contentType="text/html")]]:
            with self.subTest(files=files), patch.object(get_upload_url, "require_admin", return_value=None), patch.object(get_upload_url.s3, "generate_presigned_url") as sign:
                self.assertEqual(get_upload_url.handler(self.request(files), None)["statusCode"], 400)
                sign.assert_not_called()
        with patch.object(get_upload_url, "require_admin", return_value={"statusCode": 403}), patch.object(get_upload_url.s3, "generate_presigned_url") as sign:
            self.assertEqual(get_upload_url.handler(self.request([self.intent()]), None)["statusCode"], 403)
            sign.assert_not_called()


class UploadRetryTests(unittest.TestCase):
    def test_lost_response_returns_committed_album_without_dispatch_or_tagging(self):
        body = create_body(uploadRequestId=ALBUM_ID)
        digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        record = album(uploadRequestId=ALBUM_ID, uploadRequestHash=digest, uploadActorSub="user-sub")
        for change, expected in [({}, 201), ({"uploadActorSub": "someone-else"}, 409), ({"uploadRequestHash": "different"}, 409), ({"status": "deleted"}, 409)]:
            with self.subTest(change=change), ExitStack() as stack:
                table = Mock()
                table.put_item.side_effect = ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem")
                table.get_item.return_value = {"Item": {**record, **change}}
                stack.enter_context(patch.object(create_album, "table", table))
                stack.enter_context(patch.object(create_album, "require_admin", return_value=None))
                stack.enter_context(patch.object(create_album, "get_caller_claims", return_value=claims()))
                stack.enter_context(patch.object(create_album, "_extract_exif"))
                calls = [stack.enter_context(patch.object(create_album, name)) for name in ["tag_album_visibility", "enqueue_preview_jobs", "request_original_comparisons", "send_email", "_ensure_album_qr"]]
                response = create_album.handler({"body": json.dumps(body)}, None)
                self.assertEqual(response["statusCode"], expected)
                table.update_item.assert_not_called()
                for call in calls:
                    call.assert_not_called()
                if expected == 201:
                    self.assertEqual(response_body(response)["albumId"], ALBUM_ID)
                    self.assertNotIn("uploadActorSub", response_body(response))

    def test_new_creation_retains_retry_identity_but_does_not_expose_it(self):
        from test_album_write_branch_coverage import CreateAlbumBranchTests
        helper = CreateAlbumBranchTests()
        try:
            response, table, _ = helper._run_success(create_body(uploadRequestId=ALBUM_ID))
            self.assertEqual(response["statusCode"], 201)
            item = table.put_item.call_args.kwargs["Item"]
            self.assertEqual(item["uploadActorSub"], "user-sub")
            self.assertEqual(item["uploadRequestId"], ALBUM_ID)
            self.assertEqual(len(item["uploadRequestHash"]), 64)
            self.assertNotIn("uploadRequestHash", response_body(response))
        finally:
            helper.doCleanups()


class BoundedDispatchTests(unittest.TestCase):
    def test_220_photos_use_same_operations_with_at_most_eight_outstanding_calls(self):
        lock = threading.Lock()
        active = maximum = 0
        def operation():
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            time.sleep(.001)
            with lock:
                active -= 1
        client = Mock()
        def send(**kwargs):
            operation()
            return {"Successful": [{"Id": item["Id"]} for item in kwargs["Entries"]]}
        client.send_message_batch.side_effect = send
        client.update_item.side_effect = lambda **kwargs: operation()
        with patch.dict(jobs.os.environ, {"ORIGINAL_COMPARISON_TABLE": "markers", "ORIGINAL_COMPARISON_QUEUE_URL": "queue"}), patch.object(jobs.boto3, "client", return_value=client):
            self.assertEqual(jobs.enqueue_original_comparisons(ALBUM_ID, [{"rawKey": f"albums/{ALBUM_ID}/original/{i}.jpg"} for i in range(220)]), 220)
        self.assertEqual(client.send_message_batch.call_count, 22)
        self.assertEqual(client.update_item.call_count, 220)
        self.assertGreater(maximum, 1)
        self.assertLessEqual(maximum, 8)
        self.assertEqual(active, 0)
        for call in client.update_item.call_args_list:
            self.assertEqual(call.kwargs["TableName"], "markers")
            self.assertEqual(call.kwargs["Key"]["albumId"], {"S": ALBUM_ID})
            self.assertEqual(call.kwargs["ExpressionAttributeValues"][":pending"], {"S": "pending"})
            self.assertIn("attribute_not_exists(#status)", call.kwargs["ConditionExpression"])
