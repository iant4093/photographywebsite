import json
import unittest
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from test_support import response_body

import hero_cover
import hero_reel_admin


VERSION = "a" * 24
REEL_KEY = f"site/hero/versions/video/reel/v1/{VERSION}/reel-1920x1080.mp4"


def event(operation, body=None):
    return {
        "pathParameters": {"operation": operation},
        "body": json.dumps(body or {}),
        "requestContext": {
            "requestId": "request-reel",
            "authorizer": {"jwt": {"claims": {"cognito:groups": ["Admins"]}}},
        },
    }


def conditional_failure():
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "busy"}}, "UpdateItem")


class ReelAdminTests(unittest.TestCase):
    def setUp(self):
        self.table = Mock()
        self.lambda_client = Mock()
        patches = [
            patch.object(hero_reel_admin, "_settings", return_value=self.table),
            patch.object(hero_reel_admin, "_lambda_client", return_value=self.lambda_client),
            patch.dict("os.environ", {"HERO_REEL_FUNCTION_NAME": "hero-reel-fn"}),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def test_status_exposes_preview_urls_but_never_source_ids(self):
        record = {
            "version": VERSION,
            "mode": "auto",
            "duration": "58.24",
            "clipCount": Decimal(14),
            "sourceCount": Decimal(9),
            "mediaIds": ["secret-media"],
            "albumIds": ["secret-album"],
            "pending": ["p"],
            "posterKey": f"site/hero/versions/video/reel/v1/{VERSION}/poster.jpg",
            "renditions": [
                {"key": REEL_KEY, "width": Decimal(1920), "height": Decimal(1080), "bytes": Decimal(123)},
                {"key": "albums/private/elsewhere.mp4", "width": 1, "height": 1, "bytes": 1},
            ],
        }
        self.table.get_item.return_value = {"Item": {
            "published": record,
            "draft": {"version": "not-a-version"},
            "job": {"requestId": "r", "mode": "draft", "status": "ready", "updatedAt": "t", "score": Decimal("1.5")},
            "auto": {"status": "failed", "reason": "not_enough_footage", "at": "t", "inputDigest": "x"},
        }}
        status = hero_reel_admin.status()
        published = status["published"]
        self.assertEqual(published["duration"], 58.2)
        self.assertEqual(published["clipCount"], 14)
        self.assertEqual(published["pendingCount"], 1)
        self.assertEqual(published["renditions"], [{
            "url": f"https://media.example.test/{REEL_KEY}", "width": 1920, "height": 1080, "bytes": 123,
        }])
        self.assertTrue(published["posterUrl"].endswith("/poster.jpg"))
        self.assertNotIn("secret", json.dumps(status))
        self.assertIsNone(status["draft"])
        self.assertEqual(status["job"]["status"], "ready")
        self.assertEqual(status["auto"], {"status": "failed", "reason": "not_enough_footage", "at": "t"})

        self.table.get_item.return_value = {}
        self.assertEqual(hero_reel_admin.status(), {"job": None, "draft": None, "published": None, "auto": None})
        self.assertIsNone(hero_reel_admin._public_record({"version": VERSION, "duration": "bad"})["duration"])
        self.assertEqual(hero_reel_admin._plain([Decimal("0.5")]), [0.5])

    def test_generate_records_a_job_and_invokes_the_worker_asynchronously(self):
        job = hero_reel_admin.generate()
        self.assertEqual(job["status"], "queued")
        self.assertEqual(job["mode"], "draft")
        update = self.table.update_item.call_args.kwargs
        self.assertIn("NOT #job.#status IN (:queued, :running)", update["ConditionExpression"])
        invoke = self.lambda_client.invoke.call_args.kwargs
        self.assertEqual(invoke["FunctionName"], "hero-reel-fn")
        self.assertEqual(invoke["InvocationType"], "Event")
        self.assertEqual(json.loads(invoke["Payload"]), {"action": "generate", "requestId": job["requestId"]})

    def test_publish_validates_the_version(self):
        with self.assertRaises(hero_reel_admin.ValidationError):
            hero_reel_admin.publish({"version": "../../x"})
        job = hero_reel_admin.publish({"version": VERSION.upper()})
        self.assertEqual(job["version"], VERSION)
        payload = json.loads(self.lambda_client.invoke.call_args.kwargs["Payload"])
        self.assertEqual(payload["action"], "publish")
        self.assertEqual(payload["version"], VERSION)

    def test_active_jobs_block_new_requests(self):
        self.table.update_item.side_effect = conditional_failure()
        with self.assertRaises(hero_reel_admin.ReelBusy):
            hero_reel_admin.generate()
        self.lambda_client.invoke.assert_not_called()
        self.table.update_item.side_effect = ClientError({"Error": {"Code": "Throttling"}}, "UpdateItem")
        with self.assertRaises(ClientError):
            hero_reel_admin.generate()

    def test_dispatch_failure_releases_the_job_slot(self):
        self.lambda_client.invoke.side_effect = RuntimeError("down")
        with self.assertRaises(RuntimeError):
            hero_reel_admin.generate()
        released = self.table.update_item.call_args_list[-1].kwargs
        self.assertEqual(released["ExpressionAttributeValues"][":job"]["status"], "failed")
        self.assertEqual(released["ExpressionAttributeValues"][":job"]["reason"], "dispatch_failed")

class ReelAdminClientTests(unittest.TestCase):
    def test_clients_are_created_lazily(self):
        self.addCleanup(setattr, hero_reel_admin, "_lambda", None)
        self.addCleanup(setattr, hero_reel_admin, "_table", None)
        hero_reel_admin._lambda = None
        hero_reel_admin._table = None
        with patch.object(hero_reel_admin.boto3, "client", return_value="lambda") as client, patch.object(
            hero_reel_admin.boto3, "resource"
        ) as resource, patch.dict("os.environ", {"GALLERY_SETTINGS_TABLE": "settings"}):
            self.assertEqual(hero_reel_admin._lambda_client(), "lambda")
            self.assertEqual(hero_reel_admin._lambda_client(), "lambda")
            hero_reel_admin._settings()
            hero_reel_admin._settings()
        client.assert_called_once_with("lambda")
        resource.return_value.Table.assert_called_once_with("settings")


class HeroCoverReelRouteTests(unittest.TestCase):
    def call(self, operation, body=None):
        with patch.object(hero_cover, "verify_front_door_request", return_value=None), patch.object(
            hero_cover, "require_admin", return_value=None
        ), patch.object(hero_cover, "emit_audit_event") as audit:
            response = hero_cover.handler(event(operation, body), SimpleNamespace(aws_request_id="lambda-reel"))
        return response, audit

    def test_status_route(self):
        with patch.object(hero_reel_admin, "status", return_value={"job": None}):
            response, audit = self.call("reel-status")
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        self.assertEqual(response_body(response), {"job": None})
        audit.assert_not_called()

    def test_generate_and_publish_routes_are_audited(self):
        with patch.object(hero_reel_admin, "generate", return_value={"status": "queued"}):
            response, audit = self.call("reel-generate")
        self.assertEqual(response["statusCode"], 202)
        self.assertEqual(audit.call_args.kwargs["event_name"], "admin.hero_reel_requested")
        self.assertEqual(audit.call_args.kwargs["action"], "hero.reel.generate")
        self.assertEqual(audit.call_args.kwargs["reason_code"], "reel_job_queued")

        with patch.object(hero_reel_admin, "publish", return_value={"status": "queued"}) as publish:
            response, audit = self.call("reel-publish", {"version": VERSION})
        self.assertEqual(response["statusCode"], 202)
        self.assertEqual(publish.call_args.args[0], {"version": VERSION})
        self.assertEqual(audit.call_args.kwargs["action"], "hero.reel.publish")

    def test_busy_and_invalid_requests(self):
        with patch.object(hero_reel_admin, "generate", side_effect=hero_reel_admin.ReelBusy()):
            response, audit = self.call("reel-generate")
        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(response_body(response)["code"], "reel_busy")
        self.assertEqual(audit.call_args.kwargs["reason_code"], "reel_job_active")

        response, _ = self.call("reel-publish", {"version": "nope"})
        self.assertEqual(response["statusCode"], 400)
        response, _ = self.call("reel-explode")
        self.assertEqual(response["statusCode"], 400)


if __name__ == "__main__":
    unittest.main()
