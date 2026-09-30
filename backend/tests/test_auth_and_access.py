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
        fake_jwt = SimpleNamespace(
            decode=Mock(return_value=decoded),
            get_unverified_header=Mock(return_value={"alg": "RS256", "kid": "test-key"}),
        )
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


class AdminMfaClaimTests(unittest.TestCase):
    """The pre-token trigger's admin_mfa claim gates every admin route."""

    @staticmethod
    def _bearer_event():
        return {"headers": {"authorization": "Bearer token"}, "requestContext": {"http": {"sourceIp": "192.0.2.8"}}}

    def _require_admin_via_bearer(self, decoded):
        fake_jwt = SimpleNamespace(
            decode=Mock(return_value=decoded),
            get_unverified_header=Mock(return_value={"alg": "RS256", "kid": "test-key"}),
        )
        signing = SimpleNamespace(key="public-key")
        with patch.dict("sys.modules", {"jwt": fake_jwt}), patch.object(
            auth_helpers, "_get_jwks_client", return_value=Mock(get_signing_key_from_jwt=Mock(return_value=signing))
        ), patch.object(auth_helpers, "emit_audit_event") as audit:
            response = auth_helpers.require_admin(self._bearer_event())
        return response, audit

    def test_has_admin_mfa_accepts_only_the_exact_enabled_value(self):
        self.assertTrue(auth_helpers.has_admin_mfa({"admin_mfa": "enabled"}))
        for value in (None, "", "missing", "unverified", "ENABLED", " enabled", True, ["enabled"]):
            with self.subTest(value=value):
                self.assertFalse(auth_helpers.has_admin_mfa({"admin_mfa": value}))
        self.assertFalse(auth_helpers.has_admin_mfa({}))
        self.assertFalse(auth_helpers.has_admin_mfa(None))
        self.assertEqual(auth_helpers.ADMIN_MFA_CLAIM, "admin_mfa")

    def test_gateway_admin_with_enabled_mfa_is_allowed_without_denial_audit(self):
        with patch.object(auth_helpers, "emit_audit_event") as audit:
            self.assertIsNone(
                auth_helpers.require_admin(gateway_event(claims(groups=["Admins"], admin_mfa="enabled")))
            )
        audit.assert_not_called()

    def test_gateway_admin_without_enabled_mfa_is_denied_and_audited(self):
        for status in (None, "missing", "unverified"):
            with self.subTest(status=status), patch.object(auth_helpers, "emit_audit_event") as audit:
                event = gateway_event(claims(groups=["Admins"], admin_mfa=status))
                response = auth_helpers.require_admin(event)
                self.assertEqual(response["statusCode"], 403)
                self.assertEqual(response["headers"]["Cache-Control"], "no-store")
                self.assertIn("two-factor authentication", response_body(response)["error"])
                audit.assert_called_once()
                kwargs = audit.call_args.kwargs
                self.assertEqual(kwargs["event_name"], "authorization.admin_access")
                self.assertEqual(kwargs["outcome"], "denied")
                self.assertEqual(kwargs["reason_code"], "admin_mfa_required")
                self.assertEqual((kwargs["actor_type"], kwargs["auth_method"]), ("admin", "jwt"))
                self.assertIs(kwargs["event"], event)

    def test_non_admin_is_denied_for_group_even_with_an_enabled_claim(self):
        forged = {**claims(groups=["Editors"]), "admin_mfa": "enabled"}
        for token_claims in (claims(groups="SuperAdmins"), claims(), forged):
            with self.subTest(claims=token_claims), patch.object(auth_helpers, "emit_audit_event") as audit:
                response = auth_helpers.require_admin(gateway_event(token_claims))
                self.assertEqual(response["statusCode"], 403)
                self.assertEqual(response_body(response)["error"], "Forbidden — admin access required")
                self.assertEqual(audit.call_args.kwargs["reason_code"], "admin_group_required")

    def test_self_verified_bearer_admin_requires_enabled_mfa(self):
        response, audit = self._require_admin_via_bearer(claims(groups=["Admins"], admin_mfa="enabled"))
        self.assertIsNone(response)
        audit.assert_not_called()

        for status in (None, "missing"):
            with self.subTest(status=status):
                response, audit = self._require_admin_via_bearer(claims(groups=["Admins"], admin_mfa=status))
                self.assertEqual(response["statusCode"], 403)
                self.assertEqual(audit.call_args.kwargs["reason_code"], "admin_mfa_required")

    def test_admin_classification_and_album_scoping_ignore_mfa_status(self):
        # is_admin feeds read scoping and actor classification; only the
        # admin-route gate depends on the MFA claim.
        without_mfa = claims(subject="admin", groups=["Admins"], admin_mfa=None)
        self.assertNotIn("admin_mfa", without_mfa)
        self.assertTrue(auth_helpers.is_admin(without_mfa))
        album = {"albumId": "a", "status": "active", "visibility": "private", "ownerSub": "owner"}
        self.assertEqual(album_access.authorize_album(album, claims=without_mfa), "admin")


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
