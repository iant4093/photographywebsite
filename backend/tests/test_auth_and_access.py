import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_support import claims, gateway_event, response_body

import album_access
import auth_helpers


class AuthenticationTests(unittest.TestCase):
    def test_exact_admin_group_parsing(self):
        self.assertTrue(auth_helpers.is_admin({"cognito:groups": "[Admins,Editors]"}))
        self.assertTrue(auth_helpers.is_admin({"cognito:groups": '["Admins"]'}))
        self.assertFalse(auth_helpers.is_admin({"cognito:groups": "SuperAdmins"}))
        self.assertFalse(auth_helpers.is_admin({"cognito:groups": "AdminsBackup"}))

    def test_valid_gateway_claims(self):
        self.assertEqual(auth_helpers.get_verified_claims(gateway_event(claims()))["sub"], "user-sub")

    def test_wrong_issuer_audience_and_token_use_are_denied(self):
        mutations = [
            {"iss": "https://attacker.invalid"},
            {"aud": "wrong-client"},
            {"token_use": "access"},
            {"sub": ""},
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                candidate = {**claims(), **mutation}
                with self.assertRaises(auth_helpers.AuthError):
                    auth_helpers.get_verified_claims(gateway_event(candidate))

    def test_expired_claims_are_denied(self):
        with self.assertRaisesRegex(auth_helpers.AuthError, "expired"):
            auth_helpers.get_verified_claims(gateway_event(claims(expires=int(time.time()) - 1)))

    def test_anonymous_optional_auth(self):
        self.assertIsNone(auth_helpers.get_verified_claims({}, required=False))
        with self.assertRaises(auth_helpers.AuthError):
            auth_helpers.get_verified_claims({}, required=True)

    def test_malformed_authorization_header_is_denied(self):
        with self.assertRaises(auth_helpers.AuthError):
            auth_helpers.get_verified_claims({"headers": {"Authorization": "Basic value"}}, required=False)

    def test_manual_bearer_decode_is_restricted_to_rs256(self):
        decoded = claims()
        fake_jwt = SimpleNamespace(decode=Mock(return_value=decoded))
        signing = SimpleNamespace(key="public-key")
        with patch.dict("sys.modules", {"jwt": fake_jwt}), patch.object(
            auth_helpers, "_get_jwks_client", return_value=Mock(get_signing_key_from_jwt=Mock(return_value=signing))
        ):
            result = auth_helpers.get_verified_claims({"headers": {"authorization": "Bearer token"}})
        self.assertEqual(result["sub"], "user-sub")
        _, kwargs = fake_jwt.decode.call_args
        self.assertEqual(kwargs["algorithms"], ["RS256"])
        self.assertEqual(kwargs["audience"], "test-client-id")

    def test_require_admin_never_substring_matches(self):
        response = auth_helpers.require_admin(gateway_event(claims(groups="SuperAdmins")))
        self.assertEqual(response["statusCode"], 403)
        self.assertIsNone(auth_helpers.require_admin(gateway_event(claims(groups=["Admins"]))))


class AlbumAccessTests(unittest.TestCase):
    def setUp(self):
        self.base = {"albumId": "a", "status": "active", "visibility": "public"}

    def test_public_is_anonymous(self):
        self.assertEqual(album_access.authorize_album(self.base), "public")

    def test_private_requires_exact_subject(self):
        album = {**self.base, "visibility": "private", "ownerSub": "owner"}
        self.assertEqual(album_access.authorize_album(album, claims={"sub": "owner"}), "owner")
        with self.assertRaises(album_access.AuthError):
            album_access.authorize_album(album, claims={"sub": "other", "email": "owner@example.com"})

    def test_private_legacy_email_only_when_subject_missing(self):
        legacy = {**self.base, "visibility": "private", "ownerEmail": "owner@example.com"}
        self.assertEqual(
            album_access.authorize_album(legacy, claims={"sub": "new", "email": "OWNER@example.com"}),
            "owner",
        )

    def test_unlisted_requires_active_exact_share(self):
        album = {**self.base, "visibility": "unlisted", "isShared": True, "shareCode": "code-123456"}
        self.assertEqual(album_access.authorize_album(album, share_code="code-123456"), "share")
        for code in (None, "code-12345", "code-1234567"):
            with self.assertRaises(album_access.AuthError):
                album_access.authorize_album(album, share_code=code)

    def test_admin_can_manage_protected_album(self):
        album = {**self.base, "visibility": "private", "ownerSub": "owner"}
        self.assertEqual(album_access.authorize_album(album, claims={"sub": "admin", "cognito:groups": ["Admins"]}), "admin")

    def test_pending_and_unknown_visibility_fail_closed(self):
        for candidate in ({**self.base, "status": "pending"}, {**self.base, "visibility": "mystery"}):
            with self.assertRaises(album_access.AuthError):
                album_access.authorize_album(candidate, claims={"sub": "owner"})

    def test_cursor_is_scope_bound_and_tamper_evident_enough_for_queries(self):
        cursor = album_access.encode_cursor({"albumId": "one"}, "public:photo")
        self.assertEqual(album_access.decode_cursor(cursor, "public:photo"), {"albumId": "one"})
        with self.assertRaises(album_access.ValidationError):
            album_access.decode_cursor(cursor, "owner:user")
        with self.assertRaises(album_access.ValidationError):
            album_access.decode_cursor("not-base64", "public:photo")


if __name__ == "__main__":
    unittest.main()
