"""Cached denials save external work without replacing CAPTCHA or database limits."""

import json
import os
import unittest
from unittest.mock import Mock, patch

import test_support  # noqa: F401
from test_rate_limit_denial_cache import RateTable
import complete_challenge
import contact
import get_shared_album
import login
import security_helpers


IP = "192.0.2.82"
CASES = (
    (login, "login_ip", 15, 600, {"email": "user@example.com", "password": "Password123!", "turnstileToken": "token"}),
    (complete_challenge, "login_challenge_ip", 10, 600, {
        "email": "user@example.com", "session": "opaque-session", "turnstileToken": "token",
        "challengeName": "SOFTWARE_TOKEN_MFA", "code": "123456",
    }),
    (contact, "contact", 3, 600, {"name": "Visitor", "email": "user@example.com", "message": "Hi", "turnstileToken": "token"}),
    (get_shared_album, "shared_album", 30, 300, {}),
)


class EarlyAbuseRejectionTests(unittest.TestCase):
    def setUp(self):
        security_helpers._denied_requests.clear()
        self.addCleanup(security_helpers._denied_requests.clear)
        self.now = 1000
        self.table = RateTable()
        self.get_table = self.enterContext(patch.object(security_helpers, "_get_rate_table", return_value=self.table))
        self.enterContext(patch.object(security_helpers.time, "time", side_effect=lambda: self.now))

    def event(self, body):
        return {"body": json.dumps(body), "requestContext": {"http": {"sourceIp": IP}},
                "pathParameters": {"shareCode": "share-code-123"}, "headers": {"X-Turnstile-Token": "token"}}

    def block(self, action, limit, window, identifier=IP):
        for _ in range(limit):
            self.assertTrue(security_helpers.check_rate_limit(identifier, action, limit, window))
        self.assertFalse(security_helpers.check_rate_limit(identifier, action, limit, window))

    def test_confirmed_ip_blocks_skip_captcha_and_database_for_all_four_handlers(self):
        for module, action, limit, window, body in CASES:
            with self.subTest(handler=module.__name__):
                self.block(action, limit, window)
                lookups = self.get_table.call_count
                with patch.object(module, "verify_turnstile") as captcha, patch.object(module, "check_rate_limit") as rate:
                    response = module.handler(self.event(body), None)
                self.assertEqual(response["statusCode"], 429)
                captcha.assert_not_called()
                rate.assert_not_called()
                self.assertEqual(self.get_table.call_count, lookups)

    def test_expired_blocks_resume_captcha_then_authoritative_rate_check(self):
        for module, action, limit, window, body in CASES:
            with self.subTest(handler=module.__name__):
                self.block(action, limit, window)
                self.now += window
                order = []
                with patch.object(module, "verify_turnstile", side_effect=lambda *_a, **_k: order.append("captcha") or True), patch.object(
                    module, "check_rate_limit", side_effect=lambda *_a, **_k: order.append("rate") or False,
                ):
                    response = module.handler(self.event(body), None)
                self.assertEqual(response["statusCode"], 429)
                self.assertEqual(order, ["captcha", "rate"])

    def test_cold_cache_misses_still_require_captcha_before_database_work(self):
        for module, _action, _limit, _window, body in CASES:
            with self.subTest(handler=module.__name__), patch.object(module, "verify_turnstile", return_value=False) as captcha, patch.object(
                module, "check_rate_limit",
            ) as rate:
                self.assertEqual(module.handler(self.event(body), None)["statusCode"], 403)
                captcha.assert_called_once()
                rate.assert_not_called()
        self.get_table.assert_not_called()

    def test_username_blocks_do_not_create_an_unauthenticated_account_probe(self):
        self.block("login_user", 8, 600, identifier="user@example.com")
        with patch.object(login, "verify_turnstile", return_value=False) as captcha:
            self.assertEqual(login.handler(self.event(CASES[0][4]), None)["statusCode"], 403)
        captcha.assert_called_once()

    def test_peek_is_scoped_to_identifier_action_policy_table_and_secret(self):
        self.block("contact", 3, 600)
        lookups = self.get_table.call_count
        self.assertTrue(security_helpers.is_rate_limit_denied(IP, "contact", 3, 600))
        for args in (("other", "contact", 3, 600), (IP, "login_ip", 3, 600), (IP, "contact", 4, 600), (IP, "contact", 3, 300)):
            self.assertFalse(security_helpers.is_rate_limit_denied(*args))
        for env in ({"RATE_LIMIT_TABLE": "other"}, {"RATE_LIMIT_HASH_SECRET": "other"}):
            with patch.dict(os.environ, env):
                self.assertFalse(security_helpers.is_rate_limit_denied(IP, "contact", 3, 600))
        self.assertEqual(self.get_table.call_count, lookups)

    def test_empty_cache_errors_and_invalid_policies_never_create_a_block_or_allowance(self):
        with patch.object(security_helpers, "resolve_secret") as secret:
            self.assertFalse(security_helpers.is_rate_limit_denied(IP, "contact", 3, 600))
        secret.assert_not_called()
        self.block("contact", 3, 600)
        for action, limit, window in ((None, 3, 600), ("", 3, 600), ("x" * 65, 3, 600), ("contact", "bad", 600), ("contact", 0, 600), ("contact", 3, 0)):
            self.assertFalse(security_helpers.is_rate_limit_denied(IP, action, limit, window))
        with patch.object(security_helpers, "_identifier_hash", side_effect=RuntimeError("unavailable")), patch.object(
            contact, "verify_turnstile", return_value=False,
        ) as captcha:
            self.assertEqual(contact.handler(self.event(CASES[2][4]), None)["statusCode"], 403)
        captcha.assert_called_once()

    def test_duplicate_fields_fail_as_client_errors_before_captcha_or_quota(self):
        for module, _action, _limit, _window, body in CASES[:3]:
            event = self.event(body)
            event["body"] = event["body"][:-1] + ',"turnstileToken":"different"}'
            with self.subTest(handler=module.__name__), patch.object(module, "verify_turnstile") as captcha, patch.object(
                module, "check_rate_limit",
            ) as rate:
                self.assertEqual(module.handler(event, None)["statusCode"], 400)
                captcha.assert_not_called()
                rate.assert_not_called()
