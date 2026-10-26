"""Delivery, retry, privacy, severity escalation, and public-probe regressions."""

import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


class ConditionalFailure(Exception):
    pass


class Database:
    exceptions = types.SimpleNamespace(ConditionalCheckFailedException=ConditionalFailure)

    def __init__(self):
        self.items = {}

    def put_item(self, **kw):
        item = kw["Item"]
        key = item["notificationKey"]["S"]
        old = self.items.get(key)
        now = int(kw["ExpressionAttributeValues"][":now"]["N"])
        if old and int(old["expiresAt"]["N"]) > now:
            if old["status"]["S"] == "sent" or int(old["leaseUntil"]["N"]) > now:
                raise ConditionalFailure()
        self.items[key] = item

    def get_item(self, **kw):
        return {"Item": self.items.get(kw["Key"]["notificationKey"]["S"], {})}

    def delete_item(self, **kw):
        self.items.pop(kw["Key"]["notificationKey"]["S"])

    def update_item(self, **kw):
        item = self.items[kw["Key"]["notificationKey"]["S"]]
        item["status"] = {"S": "sent"}
        item.pop("leaseUntil", None)


class NotificationProcessorTests(unittest.TestCase):
    def setUp(self):
        self.messages = []
        self.metrics = []
        self.database = Database()
        self.fail_publish = False

        def publish(**kw):
            if self.fail_publish:
                raise RuntimeError("temporary delivery failure")
            self.messages.append(kw)

        clients = {
            "sns": types.SimpleNamespace(publish=publish),
            "dynamodb": self.database,
            "cloudwatch": types.SimpleNamespace(put_metric_data=lambda **kw: self.metrics.append(kw)),
        }
        fake = types.SimpleNamespace(client=lambda name, **kw: clients[name])
        spec = importlib.util.spec_from_file_location("signal_processor_test", ROOT / "ops/security_signal_processor.py")
        self.processor = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"boto3": fake}), patch.dict(os.environ, {
            "SECURITY_TOPIC_ARN": "arn:aws:sns:us-west-2:123456789012:test",
            "STAGE": "prod", "NOTIFICATION_STATE_TABLE": "notification-test",
        }):
            spec.loader.exec_module(self.processor)
        # Keep the isolated environment for lazy clients and the state table.
        self.environment = patch.dict(os.environ, {"NOTIFICATION_STATE_TABLE": "notification-test"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def signal(self, severity=8, **changes):
        return {"schemaVersion": 1, "eventName": "guardduty.finding", "severity": severity,
                "findingId": "a" * 32, "sample": "", "stage": "prod", **changes}

    def deliver(self, value):
        return self.processor.handler({"Records": [{"body": json.dumps(value)}]}, None)

    def test_inline_deployment_matches_tested_source(self):
        import textwrap
        source = (ROOT / "ops/security_notifications_template.yaml").read_text()
        code = source.split("        ZipFile: |\n", 1)[1].split("      Tags:\n", 1)[0]
        self.assertEqual(textwrap.dedent(code), (ROOT / "ops/security_signal_processor.py").read_text())

    def test_repeat_is_suppressed_and_critical_escalation_is_delivered(self):
        self.assertEqual(self.deliver(self.signal()), {"forwarded": 1})
        self.assertEqual(self.deliver(self.signal(8.9)), {"forwarded": 0, "suppressed": 1})
        self.assertEqual(self.deliver(self.signal(9)), {"forwarded": 1})
        self.assertEqual(len(self.messages), 2)
        self.assertEqual([json.loads(m["Message"])["severity"] for m in self.messages], ["high", "critical"])
        self.assertNotIn("a" * 32, json.dumps(self.messages))
        self.assertTrue(all(len(key) == 64 for key in self.database.items))

    def test_publish_failure_does_not_suppress_retry(self):
        self.fail_publish = True
        with self.assertRaises(RuntimeError):
            self.deliver(self.signal())
        self.assertFalse(self.database.items)
        self.fail_publish = False
        self.assertEqual(self.deliver(self.signal()), {"forwarded": 1})

    def test_pending_delivery_retries_instead_of_acknowledging_a_lost_message(self):
        original = self.database.update_item
        self.database.update_item = lambda **kw: (_ for _ in ()).throw(RuntimeError("process interrupted"))
        with self.assertRaises(RuntimeError):
            self.deliver(self.signal())
        self.database.update_item = original
        with self.assertRaisesRegex(RuntimeError, "already in progress"):
            self.deliver(self.signal())
        with patch.object(self.processor.time, "time", return_value=self.processor.time.time() + 181):
            self.assertEqual(self.deliver(self.signal()), {"forwarded": 1})

    def test_samples_are_labelled_and_do_not_suppress_real_findings(self):
        self.deliver(self.signal(sample="true"))
        self.assertTrue(self.messages[0]["Subject"].startswith("[TEST]"))
        self.assertTrue(json.loads(self.messages[0]["Message"])["test"])
        self.assertEqual(self.deliver(self.signal()), {"forwarded": 1})

    def test_rejects_noise_private_data_wrong_stage_and_malformed_input(self):
        invalid = [self.signal(s) for s in [0, 6.9, 10.1, True, "8", float("nan"), float("inf")]]
        invalid += [self.signal(private="must-not-forward"), self.signal(stage="other"),
                    self.signal(findingId="private/resource/path"), self.signal(schemaVersion=True),
                    self.signal(sample="arbitrary"), self.signal(sample=True)]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.deliver(value)
        self.assertFalse(self.messages)
        self.assertFalse(self.database.items)

    def test_probe_checks_both_endpoints_and_does_not_email_on_one_failure(self):
        with patch.object(self.processor, "_check", side_effect=[True, False]) as check:
            self.assertEqual(self.processor._availability(), {"healthy": False})
        self.assertEqual(check.call_count, 2)
        self.assertEqual(self.metrics[0]["MetricData"][0]["Value"], 1)
        self.assertFalse(self.messages)
        with patch.object(self.processor, "_check", return_value=True):
            self.assertEqual(self.processor._availability(), {"healthy": True})
        self.assertEqual(self.metrics[-1]["MetricData"][0]["Value"], 0)

    def test_tls_dns_or_bad_content_fail_the_probe_and_close_connections(self):
        def connection(status=200, body=b'{"items":[]}', error=False):
            def request(*args, **kwargs):
                if error:
                    raise OSError("DNS or TLS failure")
            return types.SimpleNamespace(request=request, close=lambda: closed.append(True),
                                         getresponse=lambda: types.SimpleNamespace(status=status, read=lambda n: body))
        for candidate, path, expected in [
            (connection(), "/api/public/albums?limit=1", True),
            (connection(body=b'<div id="root"></div>'), "/", True),
            (connection(status=500), "/api/public/albums?limit=1", False),
            (connection(body=b"not json"), "/api/public/albums?limit=1", False),
            (connection(body=b'{"error":"unexpected"}'), "/api/public/albums?limit=1", False),
            (connection(error=True), "/", False),
        ]:
            closed = []
            with patch.object(self.processor.http.client, "HTTPSConnection", return_value=candidate):
                self.assertEqual(self.processor._check(path), expected)
            self.assertEqual(closed, [True])


if __name__ == "__main__":
    unittest.main()
