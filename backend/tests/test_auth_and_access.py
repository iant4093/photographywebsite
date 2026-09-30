import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_support import claims, gateway_event, response_body

import album_access
import auth_helpers
import get_album
import get_albums


class AuthenticationTests(unittest.TestCase):
    def test_exact_admin_group_parsing(self):
        self.assertTrue(auth_helpers.is_admin_group({"cognito:groups": "[Admins,Editors]"}))
        self.assertTrue(auth_helpers.is_admin_group({"cognito:groups": '["Admins"]'}))
        self.assertFalse(auth_helpers.is_admin_group({"cognito:groups": "SuperAdmins"}))
        self.assertFalse(auth_helpers.is_admin_group({"cognito:groups": "AdminsBackup"}))
        # Admin privilege uses the same exact parsing plus the MFA claim.
        enabled = {"admin_mfa": "enabled"}
        self.assertTrue(auth_helpers.is_admin({"cognito:groups": "[Admins,Editors]", **enabled}))
        self.assertTrue(auth_helpers.is_admin({"cognito:groups": '["Admins"]', **enabled}))
        self.assertFalse(auth_helpers.is_admin({"cognito:groups": "SuperAdmins", **enabled}))
        self.assertFalse(auth_helpers.is_admin({"cognito:groups": "AdminsBackup", **enabled}))

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

    def test_admin_privilege_requires_group_and_enabled_mfa(self):
        for status in (None, "missing", "unverified"):
            with self.subTest(status=status):
                token_claims = claims(groups=["Admins"], admin_mfa=status)
                self.assertTrue(auth_helpers.is_admin_group(token_claims))
                self.assertFalse(auth_helpers.is_admin(token_claims))
        self.assertTrue(auth_helpers.is_admin(claims(groups=["Admins"])))
        self.assertFalse(auth_helpers.is_admin({**claims(groups=["Editors"]), "admin_mfa": "enabled"}))
        self.assertFalse(auth_helpers.is_admin(None))


class UnenrolledAdminFallbackTests(unittest.TestCase):
    """An Admins member without admin_mfa=enabled is only an ordinary user."""

    ALBUM_ID = "11111111-1111-4111-8111-111111111111"

    def _album(self, visibility, **overrides):
        record = {
            "albumId": self.ALBUM_ID,
            "status": "active",
            "visibility": visibility,
            "type": "photo",
            "title": "Portfolio",
            "createdAt": "2026-01-01T00:00:00Z",
            "ownerEmail": "owner@example.com",
            "ownerSub": "owner-sub",
            "shareCode": "code-123456",
            "isShared": True,
            "s3Prefix": f"albums/{self.ALBUM_ID}/",
            "images": [{"rawKey": f"albums/{self.ALBUM_ID}/original/photo.jpg"}],
        }
        record.update(overrides)
        return record

    def test_private_album_read_matches_a_non_owner_user(self):
        private = self._album("private")
        unlisted = self._album("unlisted")
        ordinary = claims(subject="admin-sub", email="admin@example.com")
        for status in (None, "missing", "unverified"):
            unenrolled = claims(
                subject="admin-sub", email="admin@example.com", groups=["Admins"], admin_mfa=status
            )
            with self.subTest(status=status):
                for album, share_code in ((private, None), (unlisted, None), (unlisted, "wrong-code-1")):
                    with self.assertRaises(album_access.AuthError) as admin_denial:
                        album_access.authorize_album(album, claims=unenrolled, share_code=share_code)
                    with self.assertRaises(album_access.AuthError) as user_denial:
                        album_access.authorize_album(album, claims=ordinary, share_code=share_code)
                    self.assertEqual(
                        (admin_denial.exception.status_code, admin_denial.exception.public_message),
                        (user_denial.exception.status_code, user_denial.exception.public_message),
                    )
                # Owner and share grants still work exactly as for anyone else.
                own = self._album("private", ownerSub="admin-sub")
                self.assertEqual(album_access.authorize_album(own, claims=unenrolled), "owner")
                self.assertEqual(
                    album_access.authorize_album(unlisted, claims=unenrolled, share_code="code-123456"),
                    "share",
                )
        enrolled = claims(subject="admin-sub", groups=["Admins"])
        self.assertEqual(album_access.authorize_album(private, claims=enrolled), "admin")

    def test_album_detail_denies_private_and_omits_management_keys(self):
        unenrolled = claims(subject="admin-sub", groups=["Admins"], admin_mfa="missing")
        event = {"pathParameters": {"albumId": self.ALBUM_ID}}
        with patch.object(get_album.table, "get_item", return_value={"Item": self._album("private")}), patch.object(
            get_album, "get_verified_claims", return_value=unenrolled
        ):
            self.assertEqual(get_album.handler(event, None)["statusCode"], 403)
        with patch.object(get_album.table, "get_item", return_value={"Item": self._album("public")}), patch.object(
            get_album, "get_verified_claims", return_value=unenrolled
        ):
            response = get_album.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        self.assertNotIn("rawKey", response_body(response)["images"][0])
        self.assertNotIn("ownerEmail", response_body(response)["album"])

    def test_catalog_all_scope_and_owner_filters_fall_back_for_unenrolled_admin(self):
        unenrolled = claims(subject="admin-sub", email="admin@example.com", groups=["Admins"], admin_mfa=None)
        for params in (
            {"visibility": "all", "limit": "10"},
            {"visibility": "unlisted", "limit": "10"},
            {"ownerEmail": "owner@example.com", "limit": "10"},
            {"visibility": "private", "ownerSub": self.ALBUM_ID, "limit": "10"},
        ):
            with self.subTest(params=params), patch.object(
                get_albums, "get_verified_claims", return_value=unenrolled
            ), patch.object(get_albums, "_fetch_page") as fetch:
                response = get_albums.handler({"queryStringParameters": params}, None)
                self.assertEqual(response["statusCode"], 403)
                fetch.assert_not_called()

        # A private listing falls back to the caller's own albums, never all.
        captured = {}

        def fetch_page(**kwargs):
            captured.update(kwargs)
            return [], None

        with patch.object(get_albums, "get_verified_claims", return_value=unenrolled), patch.object(
            get_albums, "_fetch_page", side_effect=fetch_page
        ):
            response = get_albums.handler(
                {"queryStringParameters": {"visibility": "private", "limit": "10"}}, None
            )
        self.assertEqual(response["statusCode"], 200)
        self.assertFalse(captured["admin_all"])
        self.assertEqual(captured["owner_sub"], "admin-sub")
        self.assertEqual(captured["owner_email"], "admin@example.com")
        self.assertIsNone(captured["admin_owner_email"])


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
        self.assertEqual(
            album_access.authorize_album(
                album, claims={"sub": "admin", "cognito:groups": ["Admins"], "admin_mfa": "enabled"}
            ),
            "admin",
        )

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
