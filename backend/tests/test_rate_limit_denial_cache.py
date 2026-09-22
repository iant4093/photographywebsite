"""Repeated denials save database work without granting or extending access."""

from concurrent.futures import ThreadPoolExecutor
import os
from threading import Lock
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

import test_support  # noqa: F401
import security_helpers


class RateTable:
    def __init__(self):
        self.rows = {}
        self.calls = 0
        self.lock = Lock()

    def update_item(self, **request):
        with self.lock:
            self.calls += 1
            key = request["Key"]["identifier"]
            values = request["ExpressionAttributeValues"]
            row = self.rows.get(key)
            if "ConditionExpression" in request:
                if row and row["ttl"] > values[":now"]:
                    raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
                row = self.rows[key] = {"count": 1, "ttl": values[":expiry"]}
            else:
                row["count"] += 1
            return {"Attributes": dict(row)}


class RateLimitDenialCacheTests(unittest.TestCase):
    def setUp(self):
        security_helpers._denied_requests.clear()
        self.addCleanup(security_helpers._denied_requests.clear)
        self.table = RateTable()
        table_patch = patch.object(security_helpers, "_get_rate_table", return_value=self.table)
        self.get_table = table_patch.start()
        self.addCleanup(table_patch.stop)

    def check(self, identifier="visitor", action="download", limit=1, window=60, now=100):
        return security_helpers.check_rate_limit(identifier, action, limit, window, now=now)

    def test_repeat_denials_skip_database_and_expire_at_original_window_end(self):
        self.assertTrue(self.check())
        self.assertFalse(self.check(now=101))
        calls = self.table.calls
        lookups = self.get_table.call_count
        for second in range(102, 160):
            self.assertFalse(self.check(now=second))
        self.assertEqual(self.table.calls, calls)
        self.assertEqual(self.get_table.call_count, lookups)
        self.assertTrue(self.check(now=160))
        self.assertEqual(self.table.calls, calls + 1)

    def test_success_is_never_cached_and_cold_instances_share_database_limit(self):
        self.assertTrue(self.check(limit=2))
        self.assertTrue(self.check(limit=2))
        self.assertFalse(self.check(limit=2))
        self.assertEqual(self.table.calls, 5)
        security_helpers._denied_requests.clear()  # Another Lambda has no local decision.
        self.assertFalse(self.check(limit=2))
        self.assertEqual(self.table.calls, 7)

    def test_identifier_action_policy_table_and_secret_are_isolated(self):
        self.assertTrue(self.check())
        self.assertFalse(self.check())
        self.assertTrue(self.check(identifier="other-visitor"))
        self.assertTrue(self.check(action="login"))
        self.assertTrue(self.check(limit=100))
        for updates in ({"window": 30}, {}):
            calls = self.table.calls
            with patch.dict(os.environ, {"RATE_LIMIT_TABLE": "other-table"} if not updates else {}):
                self.assertFalse(self.check(**updates))
            self.assertGreater(self.table.calls, calls)
        with patch.dict(os.environ, {"RATE_LIMIT_HASH_SECRET": "rotated-test-secret"}):
            self.assertTrue(self.check())
        self.assertNotIn("visitor", repr(security_helpers._denied_requests))

    def test_provider_failures_are_not_cached_or_mistaken_for_quota_blocks(self):
        self.get_table.side_effect = RuntimeError("unavailable")
        self.assertFalse(self.check())
        self.assertTrue(security_helpers.check_rate_limit("visitor", "download", 1, 60, now=100, fail_closed=False))
        self.get_table.side_effect = None
        self.assertTrue(self.check())

    def test_only_confirmed_denials_with_a_valid_bounded_expiry_are_cached(self):
        invalid_rows = [
            {"count": 2}, {"count": 2, "ttl": None}, {"count": 2, "ttl": "bad"},
            {"count": 2, "ttl": float("inf")}, {"count": 2, "ttl": 100},
            {"count": 2, "ttl": 161}, {"ttl": 160},
        ]
        for row in invalid_rows:
            with self.subTest(row=row):
                table = Mock()
                table.update_item.side_effect = [
                    {"Attributes": row}, {"Attributes": {"count": 1, "ttl": 160}},
                ]
                self.get_table.return_value = table
                self.assertFalse(self.check())
                self.assertTrue(self.check())
                self.assertEqual(table.update_item.call_count, 2)
                self.assertFalse(security_helpers._denied_requests)

    def test_cache_is_bounded_and_eviction_only_falls_back_to_database(self):
        with patch.object(security_helpers, "_MAX_DENIED_REQUESTS", 2):
            for visitor in ("first", "second"):
                self.assertTrue(self.check(identifier=visitor))
                self.assertFalse(self.check(identifier=visitor))
            self.assertFalse(self.check(identifier="first"))  # Retain the recently active block.
            self.assertTrue(self.check(identifier="third"))
            self.assertFalse(self.check(identifier="third"))
            self.assertEqual(len(security_helpers._denied_requests), 2)
            calls = self.table.calls
            self.assertFalse(self.check(identifier="first"))
            self.assertEqual(self.table.calls, calls)
            self.assertFalse(self.check(identifier="second"))
            self.assertGreater(self.table.calls, calls)
            self.assertEqual(len(security_helpers._denied_requests), 2)

    def test_concurrent_calls_never_cache_an_allowance(self):
        with ThreadPoolExecutor(max_workers=8) as workers:
            decisions = list(workers.map(lambda _: self.check(), range(40)))
        self.assertEqual(sum(decisions), 1)
        self.assertEqual(len(security_helpers._denied_requests), 1)

