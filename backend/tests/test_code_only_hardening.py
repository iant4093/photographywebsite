"""Regression cases for cursor cost amplification and early request rejection."""
import base64
import json
import os
import unittest
from unittest.mock import Mock, patch

import test_support  # noqa: F401
from botocore.exceptions import ClientError
from test_rate_limit_denial_cache import RateTable
import analytics
import create_zip
import cursor_helpers
import get_albums
import get_download_url
import get_public_albums
import prepare_print
import security_helpers
from validation_helpers import ValidationError

ALBUM = "11111111-1111-4111-8111-111111111111"
IP = "192.0.2.83"
INDEX_ENV = {"ALBUM_INDEX_DEPLOYMENT_PHASE": "both", "PUBLIC_SUMMARY_INDEX": "SummaryIndex", "VISIBILITY_CREATED_AT_INDEX": "VisibilityIndex"}
KEY = {"albumId": ALBUM, "visibility": "public", "createdAt": "2026-01-01T00:00:00Z"}


def fetch_page(module, key):
    args = dict(album_type=None, limit=10, start_key=key)
    if module is get_albums:
        args.update(visibility="public", public_summary_only=True)
    return module._fetch_page(**args)


class CursorHardeningTests(unittest.TestCase):
    def test_strict_envelope_rejects_ambiguous_or_deep_json(self):
        invalid = [
            '{"v":1,"v":1,"scope":"public:*","key":{"albumId":"x"}}',
            '{"v":true,"scope":"public:*","key":{"albumId":"x"}}',
            '{"v":1,"scope":"public:*","key":{"albumId":"x"},"extra":1}',
            '{"v":1,"scope":"public:*","key":{"albumId":"x","albumId":"y"}}',
            '{"v":1,"scope":"public:*","key":{"offset":NaN}}',
            '{"v":1,"scope":"public:*","key":' + '[' * 1000 + '0' + ']' * 1000 + '}',
        ]
        for raw in invalid:
            encoded = base64.urlsafe_b64encode(raw.encode()).decode().rstrip('=')
            with self.subTest(raw=raw[:70]), self.assertRaises(ValidationError):
                cursor_helpers.decode_cursor(encoded, "public:*")
        valid = cursor_helpers.encode_cursor(KEY, "public:*")
        with self.assertRaises(ValidationError):
            cursor_helpers.decode_cursor(valid[:8] + '!' + valid[8:], "public:*")
        self.assertEqual(cursor_helpers.decode_cursor(valid, "public:*"), KEY)

    def test_wrong_catalog_cursor_shapes_are_rejected_without_database_calls(self):
        keys = [{"offset": "1"}, {"albumId": "not-a-uuid"}, {**KEY, "visibility": "private"},
                {**KEY, "createdAt": "é" * 513}, {**KEY, "ownerSub": "someone"}, {"albumId": ALBUM, "createdAt": "now"}]
        for module in (get_albums, get_public_albums):
            for key in keys:
                with self.subTest(module=module.__name__, key=key), patch.object(module, "table") as table:
                    with self.assertRaises(ValidationError):
                        fetch_page(module, key)
                    table.query.assert_not_called()
                    table.scan.assert_not_called()

    def test_database_cursor_errors_never_activate_scan_fallback(self):
        invalid = ClientError({"Error": {"Code": "ValidationException", "Message": "The provided starting key is invalid"}}, "Query")
        for module in (get_albums, get_public_albums):
            with self.subTest(module=module.__name__), patch.dict(os.environ, INDEX_ENV), patch.object(module, "table") as table:
                table.query.side_effect = invalid
                with self.assertRaisesRegex(ValidationError, "Invalid cursor"):
                    fetch_page(module, KEY)
                self.assertEqual(table.query.call_count, 1)
                table.scan.assert_not_called()

    def test_actual_missing_index_fallback_and_existing_cursor_are_preserved(self):
        for code, message in (("ResourceNotFoundException", "Index unavailable"),
                              ("ValidationException", "The table does not have the specified index: SummaryIndex"),
                              ("ValidationException", "Cannot read from backfilling global secondary index")):
            for module in (get_albums, get_public_albums):
                with self.subTest(module=module.__name__, code=code, message=message), patch.dict(os.environ, INDEX_ENV), patch.object(module, "table") as table:
                    table.query.side_effect = [ClientError({"Error": {"Code": code, "Message": message}}, "Query"), {"Items": [], "LastEvaluatedKey": None}]
                    self.assertEqual(fetch_page(module, KEY), ([], None))
                    self.assertEqual(table.query.call_args.kwargs["ExclusiveStartKey"], KEY)
                    table.scan.assert_not_called()

    def test_scan_owner_and_admin_scopes_only_accept_their_key_contract(self):
        cursor_helpers.validate_catalog_cursor({"albumId": ALBUM}, visibility="all", admin_all=True)
        cursor_helpers.validate_catalog_cursor({"albumId": ALBUM, "ownerSub": "owner", "createdAt": "now"}, visibility="private", owner_sub="owner")
        for kwargs in (dict(visibility="private", owner_sub="owner"), dict(visibility="all", admin_all=True)):
            with self.assertRaises(ValidationError):
                cursor_helpers.validate_catalog_cursor(KEY, **kwargs)


class EarlyMediaRejectionTests(unittest.TestCase):
    def setUp(self):
        security_helpers._denied_requests.clear()
        self.addCleanup(security_helpers._denied_requests.clear)
        self.table = RateTable()
        self.now = 1000
        self.lookup = self.enterContext(patch.object(security_helpers, "_get_rate_table", return_value=self.table))
        self.enterContext(patch.object(security_helpers.time, "time", side_effect=lambda: self.now))

    def event(self, **extra):
        return {"pathParameters": {"albumId": ALBUM}, "body": json.dumps({"mediaId": "a" * 24}),
                "requestContext": {"http": {"sourceIp": IP}}, **extra}

    def block(self, action, limit):
        for _ in range(limit):
            self.assertTrue(security_helpers.check_rate_limit(f"{IP}:{ALBUM}", action, limit, 300))
        self.assertFalse(security_helpers.check_rate_limit(f"{IP}:{ALBUM}", action, limit, 300))

    def test_confirmed_blocks_skip_album_identity_and_authoritative_limiter_work(self):
        cases = [(get_download_url, "album_download", 100, {}),
                 (get_download_url, "album_original_comparison", 100, {"rawPath": f"/api/albums/{ALBUM}/original-comparison"}),
                 (create_zip, "zip_status", 120, {}), (prepare_print, "album_print", 30, {})]
        for module, action, limit, extra in cases:
            with self.subTest(action=action):
                self.block(action, limit)
                before = self.lookup.call_count
                with patch.object(module, "get_album_record") as album, patch.object(module, "get_verified_claims") as claims, patch.object(module, "check_rate_limit") as rate:
                    response = module.handler(self.event(**extra), None)
                self.assertEqual(response["statusCode"], 429)
                album.assert_not_called()
                claims.assert_not_called()
                rate.assert_not_called()
                self.assertEqual(self.lookup.call_count, before)

    def test_miss_and_expiry_still_require_album_lookup_and_authorization(self):
        for blocked in (False, True):
            if blocked:
                self.block("album_download", 100)
                self.now += 301
            with patch.object(get_download_url, "get_album_record", return_value=None) as album:
                self.assertEqual(get_download_url.handler(self.event(), None)["statusCode"], 404)
                album.assert_called_once_with(album_id=ALBUM)

    def test_print_media_validation_precedes_lookup(self):
        for media in (None, "../object", "a" * 25):
            with self.subTest(media=media), patch.object(prepare_print, "get_album_record") as album, patch.object(prepare_print, "check_rate_limit") as rate:
                result = prepare_print.handler(self.event(body=json.dumps({"mediaId": media})), None)
                self.assertIn(result["statusCode"], (400, 404))
                album.assert_not_called()
                rate.assert_not_called()

    def test_print_redemption_validates_token_before_peeking_then_skips_database(self):
        self.block("print_redeem", 30)
        with patch.object(prepare_print, "_verify_token", return_value={"a": ALBUM}) as verify, patch.object(prepare_print, "get_album_record") as album, patch.object(prepare_print, "_stage_print") as stage:
            result = prepare_print.handler(self.event(rawPath="/api/print/session", body=json.dumps({"sessionToken": "signed-token"})), None)
        self.assertEqual(result["statusCode"], 429)
        verify.assert_called_once_with("signed-token")
        album.assert_not_called()
        stage.assert_not_called()


class AnalyticsEarlyValidationTests(unittest.TestCase):
    def event(self, events):
        return {"headers": {"origin": os.environ["FRONTEND_URL"]}, "body": json.dumps({"events": events})}

    def test_entire_batch_is_validated_before_rate_or_album_database_work(self):
        invalid = [None, {"name": []}, {"name": "page_view", "extra": True}, {"name": "album_view", "albumId": "bad"},
                   {"name": "site_visit", "source": [], "device": "desktop"},
                   {"name": "web_vital", "metric": "LCP", "rating": "good", "value": -1},
                   {"name": "frontend_error", "kind": {}}]
        for bad in invalid:
            with self.subTest(bad=bad), patch.object(analytics, "check_rate_limit") as rate, patch.object(analytics, "albums_table") as albums, patch.object(analytics, "analytics_table") as counters:
                result = analytics.handler(self.event([{"name": "album_view", "albumId": ALBUM}, bad]), None)
                self.assertEqual(result["statusCode"], 400)
                rate.assert_not_called()
                albums.get_item.assert_not_called()
                counters.update_item.assert_not_called()

    def test_valid_batch_is_rate_limited_before_album_reads_or_counter_writes(self):
        with patch.object(analytics, "check_rate_limit", return_value=False) as rate, patch.object(analytics, "albums_table") as albums, patch.object(analytics, "analytics_table") as counters:
            result = analytics.handler(self.event([{"name": "album_view", "albumId": ALBUM}]), None)
        self.assertEqual(result["statusCode"], 429)
        rate.assert_called_once()
        albums.get_item.assert_not_called()
        counters.update_item.assert_not_called()
