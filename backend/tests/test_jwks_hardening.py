"""Exercise real JWT signatures and the packaged client's network/cache behavior."""

import io
import json
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from test_support import claims, gateway_event
import auth_helpers


class JwksHardeningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.new_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def public_key(self, key, kid):
        return {**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())),
                "kid": kid, "alg": "RS256", "use": "sig"}

    def setUp(self):
        self.now = 1000.0
        self.jwks = {"keys": [self.public_key(self.old_key, "old")]}
        self.enterContext(patch.object(auth_helpers, "_jwks_client", None))
        self.enterContext(patch("jwt.jwks_client.time.monotonic", side_effect=lambda: self.now))
        opener = Mock()
        self.fetch = opener.open
        self.fetch.side_effect = lambda *_args, **_kwargs: io.BytesIO(json.dumps(self.jwks).encode())
        self.enterContext(patch("jwt.jwks_client.urllib.request.build_opener", return_value=opener))

    def token(self, *, kid="old", key=None, updates=None):
        return jwt.encode({**claims(), **(updates or {})}, key or self.old_key, algorithm="RS256", headers={"kid": kid})

    def verify(self, token):
        return auth_helpers.get_verified_claims({"headers": {"authorization": "Bearer " + token}})

    def test_unknown_key_burst_fetches_once_and_does_not_break_valid_login(self):
        for index in range(40):
            with self.assertRaises(auth_helpers.AuthError):
                self.verify(self.token(kid=f"unknown-{index}"))
        self.assertEqual(self.fetch.call_count, 1)
        self.assertEqual(self.verify(self.token())["sub"], "user-sub")
        self.assertEqual(self.fetch.call_count, 1)
        self.fetch.assert_called_with(unittest.mock.ANY, timeout=5)

    def test_rotation_is_picked_up_after_bounded_cooldown_and_retired_key_is_denied(self):
        self.verify(self.token())
        self.jwks = {"keys": [self.public_key(self.new_key, "new")]}
        self.now += 29
        with self.assertRaises(auth_helpers.AuthError):
            self.verify(self.token(kid="new", key=self.new_key))
        self.assertEqual(self.fetch.call_count, 1)
        self.now += 1
        self.assertEqual(self.verify(self.token(kid="new", key=self.new_key))["sub"], "user-sub")
        with self.assertRaises(auth_helpers.AuthError):
            self.verify(self.token())
        self.assertEqual(self.fetch.call_count, 2)

    def test_known_key_cache_expires_and_cannot_keep_retired_key_forever(self):
        self.verify(self.token())
        self.jwks = {"keys": [self.public_key(self.new_key, "new")]}
        self.now += 601
        with self.assertRaises(auth_helpers.AuthError):
            self.verify(self.token())
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(self.verify(self.token(kid="new", key=self.new_key))["sub"], "user-sub")
        self.assertEqual(self.fetch.call_count, 2)

    def test_refresh_outage_does_not_erase_still_valid_cached_keys(self):
        self.verify(self.token())
        self.now += 31
        self.fetch.side_effect = URLError("unavailable")
        with self.assertRaisesRegex(auth_helpers.AuthError, "Unauthorized"):
            self.verify(self.token(kid="unknown"))
        self.assertEqual(self.verify(self.token())["sub"], "user-sub")
        self.assertEqual(self.fetch.call_count, 2)

    def test_unsupported_algorithm_or_invalid_key_id_never_fetches_keys(self):
        tokens = [
            jwt.encode(claims(), "x" * 32, algorithm="HS256", headers={"kid": "old"}),
            jwt.encode(claims(), "", algorithm="none"),
            self.token(kid=""), self.token(kid="x" * 257), "malformed",
            jwt.encode(claims(), self.old_key, algorithm="RS256"),
        ]
        for token in tokens:
            with self.subTest(token=token[:20]), self.assertRaises(auth_helpers.AuthError):
                self.verify(token)
        self.fetch.assert_not_called()

    def test_signatures_and_claims_are_still_verified(self):
        invalid = [self.token(key=self.new_key)]
        invalid.extend(self.token(updates=update) for update in (
            {"exp": 1}, {"aud": "other"}, {"iss": "https://other.invalid"},
            {"token_use": "access"}, {"sub": ""},
        ))
        for token in invalid:
            with self.assertRaises(auth_helpers.AuthError):
                self.verify(token)
        self.assertEqual(self.verify(self.token())["sub"], "user-sub")
        self.assertEqual(self.fetch.call_count, 1)

    def test_gateway_and_anonymous_routes_need_no_manual_jwks_fetch(self):
        self.assertIsNone(auth_helpers.get_verified_claims({}, required=False))
        self.assertEqual(auth_helpers.get_verified_claims(gateway_event(claims()))["sub"], "user-sub")
        self.fetch.assert_not_called()
