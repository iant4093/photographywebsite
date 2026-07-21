import datetime
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch

from test_support import response_body

import complete_challenge
import contact
import create_user
import delete_user
import edit_user
import list_users
import login


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
SECOND_ALBUM_ID = "22222222-2222-4222-8222-222222222222"
CONTEXT = SimpleNamespace(aws_request_id="request-id")


def public_event(body, ip="192.0.2.10"):
    return {
        "body": json.dumps(body),
        "requestContext": {"http": {"sourceIp": ip}, "requestId": "gateway-id"},
    }


def provider_exception(client, name, operation="Operation"):
    exception_type = getattr(client.exceptions, name)
    return exception_type({"Error": {"Code": name, "Message": "private provider detail"}}, operation)


class LoginExpandedTests(unittest.TestCase):
    def event(self):
        return public_event(
            {
                "email": "USER@example.com",
                "password": "Password123!",
                "turnstileToken": "token",
            }
        )

    def common(self, *, limits=True):
        return (
            patch.object(login, "verify_turnstile", return_value=True),
            patch.object(login, "check_rate_limit", return_value=limits),
            patch.object(login, "emit_audit_event"),
        )

    def test_ip_and_user_rate_limits_stop_before_cognito(self):
        for side_effect, reason in (([False], "rate_limited_ip"), ([True, False], "rate_limited_user")):
            with self.subTest(reason=reason), patch.object(login, "verify_turnstile", return_value=True), patch.object(
                login, "check_rate_limit", side_effect=side_effect
            ), patch.object(login.cognito, "admin_initiate_auth") as provider, patch.object(
                login, "emit_audit_event"
            ) as audit:
                response = login.handler(self.event(), CONTEXT)
            self.assertEqual(response["statusCode"], 429)
            provider.assert_not_called()
            self.assertEqual(audit.call_args.kwargs["reason_code"], reason)

    def test_authentication_result_and_missing_result(self):
        with patch.object(login, "verify_turnstile", return_value=True), patch.object(
            login, "check_rate_limit", return_value=True
        ), patch.object(
            login.cognito,
            "admin_initiate_auth",
            return_value={"AuthenticationResult": {"IdToken": "id"}},
        ), patch.object(login, "emit_audit_event") as audit:
            response = login.handler(self.event(), CONTEXT)
        self.assertEqual(response_body(response), {"AuthenticationResult": {"IdToken": "id"}})
        self.assertEqual(audit.call_args.kwargs["reason_code"], "authenticated")

        with patch.object(login, "verify_turnstile", return_value=True), patch.object(
            login, "check_rate_limit", return_value=True
        ), patch.object(login.cognito, "admin_initiate_auth", return_value={}), patch.object(
            login, "emit_audit_event"
        ) as audit:
            response = login.handler(self.event(), CONTEXT)
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(audit.call_args.kwargs["reason_code"], "missing_authentication_result")

    def test_other_challenge_is_minimal_and_classified(self):
        with patch.object(login, "verify_turnstile", return_value=True), patch.object(
            login, "check_rate_limit", return_value=True
        ), patch.object(
            login.cognito,
            "admin_initiate_auth",
            return_value={"ChallengeName": "CUSTOM_CHALLENGE"},
        ), patch.object(login, "emit_audit_event") as audit:
            response = login.handler(self.event(), CONTEXT)
        self.assertEqual(response_body(response), {"ChallengeName": "CUSTOM_CHALLENGE", "Session": ""})
        self.assertEqual(audit.call_args.kwargs["details"], {"challenge_type": "other"})
        self.assertEqual(login._challenge_type("SOFTWARE_TOKEN_MFA"), "software_token_mfa")

    def test_validation_provider_and_unexpected_failures_are_redacted(self):
        self.assertEqual(login.handler(public_event({}), CONTEXT)["statusCode"], 400)
        for name in ("NotAuthorizedException", "UserNotFoundException"):
            with self.subTest(name=name), patch.object(login, "verify_turnstile", return_value=True), patch.object(
                login, "check_rate_limit", return_value=True
            ), patch.object(
                login.cognito,
                "admin_initiate_auth",
                side_effect=provider_exception(login.cognito, name),
            ):
                response = login.handler(self.event(), CONTEXT)
            self.assertEqual(response["statusCode"], 401)
            self.assertNotIn("provider detail", response["body"])
        with patch.object(login, "verify_turnstile", side_effect=RuntimeError("secret")):
            response = login.handler(self.event(), CONTEXT)
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("secret", response["body"])


class CompleteChallengeExpandedTests(unittest.TestCase):
    def event(self, **updates):
        body = {
            "email": "user@example.com",
            "challengeName": "NEW_PASSWORD_REQUIRED",
            "newPassword": "StrongPassword123!",
            "session": "opaque-session",
            "turnstileToken": "token",
        }
        body.update(updates)
        return public_event(body)

    def test_password_policy_number_symbol_and_whitespace(self):
        for value in ("StrongPassword!!", "Strong Password1!", "StrongPassword12"):
            with self.subTest(value=value), self.assertRaises(complete_challenge.ValidationError):
                complete_challenge._validate_new_password(value)

    def test_captcha_and_both_rate_limit_paths(self):
        cases = (
            (False, [], 403, "captcha_failed"),
            (True, [False], 429, "rate_limited_ip"),
            (True, [True, False], 429, "rate_limited_user"),
        )
        for captcha, limits, status, reason in cases:
            with self.subTest(reason=reason), patch.object(
                complete_challenge, "verify_turnstile", return_value=captcha
            ), patch.object(
                complete_challenge, "check_rate_limit", side_effect=limits
            ), patch.object(
                complete_challenge.cognito, "admin_respond_to_auth_challenge"
            ) as provider, patch.object(
                complete_challenge, "emit_audit_event"
            ) as audit:
                response = complete_challenge.handler(self.event(), CONTEXT)
            self.assertEqual(response["statusCode"], status)
            provider.assert_not_called()
            self.assertEqual(audit.call_args.kwargs["reason_code"], reason)

    def test_additional_challenge_and_missing_result(self):
        with patch.object(complete_challenge, "verify_turnstile", return_value=True), patch.object(
            complete_challenge, "check_rate_limit", return_value=True
        ), patch.object(
            complete_challenge.cognito,
            "admin_respond_to_auth_challenge",
            return_value={"ChallengeName": "SOFTWARE_TOKEN_MFA", "Session": "next"},
        ), patch.object(complete_challenge, "emit_audit_event") as audit:
            response = complete_challenge.handler(self.event(), CONTEXT)
        self.assertEqual(response_body(response)["Session"], "next")
        self.assertEqual(audit.call_args.kwargs["reason_code"], "additional_challenge_required")

        with patch.object(complete_challenge, "verify_turnstile", return_value=True), patch.object(
            complete_challenge, "check_rate_limit", return_value=True
        ), patch.object(
            complete_challenge.cognito, "admin_respond_to_auth_challenge", return_value={}
        ), patch.object(complete_challenge, "emit_audit_event") as audit:
            response = complete_challenge.handler(self.event(), CONTEXT)
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(audit.call_args.kwargs["reason_code"], "missing_authentication_result")

    def test_unsupported_provider_and_unexpected_errors(self):
        self.assertEqual(
            complete_challenge.handler(self.event(challengeName="CUSTOM_CHALLENGE"), CONTEXT)["statusCode"],
            400,
        )
        for name in ("NotAuthorizedException", "UserNotFoundException"):
            with self.subTest(name=name), patch.object(
                complete_challenge, "verify_turnstile", return_value=True
            ), patch.object(
                complete_challenge, "check_rate_limit", return_value=True
            ), patch.object(
                complete_challenge.cognito,
                "admin_respond_to_auth_challenge",
                side_effect=provider_exception(complete_challenge.cognito, name),
            ):
                response = complete_challenge.handler(self.event(), CONTEXT)
            self.assertEqual(response["statusCode"], 401)
            self.assertNotIn("provider detail", response["body"])
        with patch.object(complete_challenge, "verify_turnstile", side_effect=RuntimeError("secret")):
            response = complete_challenge.handler(self.event(), CONTEXT)
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("secret", response["body"])


class ContactExpandedTests(unittest.TestCase):
    def event(self):
        return public_event(
            {
                "name": "Name",
                "email": "user@example.com",
                "message": "Message",
                "turnstileToken": "token",
            }
        )

    def test_captcha_and_rate_limits_precede_email(self):
        for captcha, rate, status, reason in (
            (False, True, 403, "captcha_failed"),
            (True, False, 429, "rate_limited"),
        ):
            with self.subTest(reason=reason), patch.object(
                contact, "verify_turnstile", return_value=captcha
            ), patch.object(contact, "check_rate_limit", return_value=rate), patch.object(
                contact, "send_email"
            ) as send, patch.object(contact, "emit_audit_event") as audit:
                response = contact.handler(self.event(), CONTEXT)
            self.assertEqual(response["statusCode"], status)
            send.assert_not_called()
            self.assertEqual(audit.call_args.kwargs["reason_code"], reason)

    def test_validation_and_delivery_failures_are_safe(self):
        self.assertEqual(contact.handler(public_event({}), CONTEXT)["statusCode"], 400)
        with patch.object(contact, "verify_turnstile", return_value=True), patch.object(
            contact, "check_rate_limit", return_value=True
        ), patch.object(contact, "send_email", side_effect=RuntimeError("provider secret")):
            response = contact.handler(self.event(), CONTEXT)
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("provider secret", response["body"])


class CreateUserExpandedTests(unittest.TestCase):
    def event(self, email="new@example.com"):
        return {"body": json.dumps({"email": email})}

    def test_admin_denial_short_circuits(self):
        denied = {"statusCode": 403, "body": "denied"}
        with patch.object(create_user, "require_admin", return_value=denied), patch.object(
            create_user.cognito, "admin_create_user"
        ) as provider:
            self.assertIs(create_user.handler(self.event(), CONTEXT), denied)
        provider.assert_not_called()

    def test_validation_conflict_and_provider_error(self):
        with patch.object(create_user, "require_admin", return_value=None):
            self.assertEqual(create_user.handler(self.event("bad"), CONTEXT)["statusCode"], 400)
        with patch.object(create_user, "require_admin", return_value=None), patch.object(
            create_user.cognito,
            "admin_create_user",
            side_effect=provider_exception(create_user.cognito, "UsernameExistsException"),
        ):
            self.assertEqual(create_user.handler(self.event(), CONTEXT)["statusCode"], 409)
        with patch.object(create_user, "require_admin", return_value=None), patch.object(
            create_user.cognito, "admin_create_user", side_effect=RuntimeError("provider secret")
        ):
            response = create_user.handler(self.event(), CONTEXT)
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("provider secret", response["body"])


class ListUsersExpandedTests(unittest.TestCase):
    def test_admin_denial_and_paginated_minimal_directory(self):
        denied = {"statusCode": 403, "body": "denied"}
        with patch.object(list_users, "require_admin", return_value=denied), patch.object(
            list_users.cognito, "list_users"
        ) as provider:
            self.assertIs(list_users.handler({}, CONTEXT), denied)
        provider.assert_not_called()

        created = datetime.datetime(2026, 1, 2, tzinfo=datetime.timezone.utc)
        provider_response = {
            "Users": [
                {
                    "Attributes": [{"Name": "email", "Value": "user@example.com"}, {"Value": "ignored"}],
                    "UserStatus": "CONFIRMED",
                    "UserCreateDate": created,
                    "Enabled": True,
                },
                {"Attributes": [], "Enabled": 0},
            ],
            "PaginationToken": "next",
        }
        event = {"queryStringParameters": {"limit": "2", "paginationToken": " current "}}
        with patch.object(list_users, "require_admin", return_value=None), patch.object(
            list_users.cognito, "list_users", return_value=provider_response
        ) as provider:
            response = list_users.handler(event, CONTEXT)
        body = response_body(response)
        self.assertEqual(body["paginationToken"], "next")
        self.assertEqual(body["users"][0]["createdAt"], created.isoformat())
        self.assertEqual(body["users"][1]["status"], "UNKNOWN")
        self.assertEqual(provider.call_args.kwargs["PaginationToken"], "current")

    def test_validation_and_provider_failure(self):
        with patch.object(list_users, "require_admin", return_value=None), patch.object(
            list_users.cognito, "list_users", return_value={"Users": []}
        ):
            self.assertEqual(response_body(list_users.handler({}, CONTEXT)), {"users": []})
        with patch.object(list_users, "require_admin", return_value=None):
            self.assertEqual(
                list_users.handler({"queryStringParameters": {"limit": "100"}}, CONTEXT)["statusCode"],
                400,
            )
        with patch.object(list_users, "require_admin", return_value=None), patch.object(
            list_users.cognito, "list_users", side_effect=RuntimeError("provider secret")
        ):
            response = list_users.handler({}, CONTEXT)
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("provider secret", response["body"])


class EditUserExpandedTests(unittest.TestCase):
    def event(self, body=None, old="old@example.com"):
        return {
            "pathParameters": {"email": old},
            "body": json.dumps(body if body is not None else {"email": "new@example.com"}),
        }

    def base_patches(self):
        return (
            patch.object(edit_user, "require_admin", return_value=None),
            patch.object(edit_user, "cognito_identity", return_value=("username", "subject", {})),
            patch.object(edit_user, "assert_admin_target_mutable"),
        )

    def test_admin_denial_and_password_fields_are_rejected(self):
        denied = {"statusCode": 403, "body": "denied"}
        with patch.object(edit_user, "require_admin", return_value=denied):
            self.assertIs(edit_user.handler(self.event(), CONTEXT), denied)
        for field in ("password", "newPassword"):
            with self.subTest(field=field), patch.object(edit_user, "require_admin", return_value=None), patch.object(
                edit_user, "emit_audit_event"
            ) as audit:
                response = edit_user.handler(
                    self.event({"email": "new@example.com", field: "Nope123!"}), CONTEXT
                )
            self.assertEqual(response["statusCode"], 400)
            self.assertEqual(audit.call_args.kwargs["reason_code"], "password_change_not_allowed")

    def test_success_updates_identity_and_every_owned_album(self):
        table = Mock()
        with patch.object(edit_user, "require_admin", return_value=None), patch.object(
            edit_user, "cognito_identity", return_value=("username", "subject", {})
        ), patch.object(edit_user, "assert_admin_target_mutable"), patch.object(
            edit_user, "albums_owned_by", return_value=[{"albumId": ALBUM_ID}, {"albumId": SECOND_ALBUM_ID}]
        ), patch.object(edit_user, "table", table), patch.object(
            edit_user.cognito, "admin_update_user_attributes"
        ) as update_identity:
            response = edit_user.handler(self.event(), CONTEXT)
        self.assertEqual(response_body(response)["albumsUpdated"], 2)
        update_identity.assert_called_once()
        self.assertEqual(table.update_item.call_count, 2)

        with patch.object(edit_user, "require_admin", return_value=None), patch.object(
            edit_user, "cognito_identity", return_value=("username", "subject", {})
        ), patch.object(edit_user, "assert_admin_target_mutable"), patch.object(
            edit_user, "albums_owned_by", return_value=[]
        ), patch.object(edit_user.cognito, "admin_update_user_attributes") as update_identity:
            response = edit_user.handler(self.event({"email": "old@example.com"}), CONTEXT)
        self.assertEqual(response["statusCode"], 200)
        update_identity.assert_not_called()

    def test_all_error_mappings(self):
        with patch.object(edit_user, "require_admin", return_value=None):
            self.assertEqual(edit_user.handler(self.event(old="bad"), CONTEXT)["statusCode"], 400)
        with patch.object(edit_user, "require_admin", return_value=None), patch.object(
            edit_user,
            "cognito_identity",
            return_value=("username", "subject", {}),
        ), patch.object(
            edit_user, "assert_admin_target_mutable", side_effect=edit_user.AuthError("protected", 403)
        ):
            self.assertEqual(edit_user.handler(self.event(), CONTEXT)["statusCode"], 403)
        with patch.object(edit_user, "require_admin", return_value=None), patch.object(
            edit_user, "cognito_identity", return_value=("username", "", {})
        ):
            self.assertEqual(edit_user.handler(self.event(), CONTEXT)["statusCode"], 500)

        exceptions = (
            ("UserNotFoundException", 404),
            ("AliasExistsException", 409),
            ("UsernameExistsException", 409),
        )
        for name, status in exceptions:
            with self.subTest(name=name), patch.object(edit_user, "require_admin", return_value=None), patch.object(
                edit_user,
                "cognito_identity",
                side_effect=provider_exception(edit_user.cognito, name),
            ):
                self.assertEqual(edit_user.handler(self.event(), CONTEXT)["statusCode"], status)


class DeleteUserExpandedTests(unittest.TestCase):
    def event(self, email="user@example.com"):
        return {"pathParameters": {"email": email}}

    def test_admin_denial_and_full_version_aware_cascade(self):
        denied = {"statusCode": 403, "body": "denied"}
        with patch.object(delete_user, "require_admin", return_value=denied):
            self.assertIs(delete_user.handler(self.event(), CONTEXT), denied)

        albums = [{"albumId": ALBUM_ID}, {"albumId": SECOND_ALBUM_ID}]
        table = Mock()
        with patch.object(delete_user, "require_admin", return_value=None), patch.object(
            delete_user, "cognito_identity", return_value=("username", "subject", {})
        ), patch.object(delete_user, "assert_admin_target_mutable"), patch.object(
            delete_user, "albums_owned_by", return_value=albums
        ), patch.object(
            delete_user,
            "album_media_prefixes",
            side_effect=lambda album: (f"albums/{album['albumId']}/",),
        ), patch.object(delete_user, "preflight_deletion") as preflight, patch.object(
            delete_user, "delete_prefix_all_versions", return_value=2
        ) as delete_prefix, patch.object(delete_user, "table", table), patch.object(
            delete_user.cognito, "admin_delete_user"
        ) as delete_identity:
            response = delete_user.handler(self.event(), CONTEXT)
        body = response_body(response)
        self.assertEqual(body["albumsDeleted"], 2)
        self.assertEqual(body["deletedObjectVersions"], 8)
        self.assertEqual(len(preflight.call_args.kwargs["prefixes"]), 4)
        self.assertEqual(delete_prefix.call_count, 4)
        self.assertEqual(table.delete_item.call_count, 2)
        delete_identity.assert_called_once_with(UserPoolId=delete_user.USER_POOL_ID, Username="username")

    def test_guarded_error_paths_do_not_delete_identity(self):
        with patch.object(delete_user, "require_admin", return_value=None):
            self.assertEqual(delete_user.handler(self.event("bad"), CONTEXT)["statusCode"], 400)
        with patch.object(delete_user, "require_admin", return_value=None), patch.object(
            delete_user, "cognito_identity", return_value=("username", "subject", {})
        ), patch.object(
            delete_user, "assert_admin_target_mutable", side_effect=delete_user.AuthError("protected", 403)
        ):
            self.assertEqual(delete_user.handler(self.event(), CONTEXT)["statusCode"], 403)
        with patch.object(delete_user, "require_admin", return_value=None), patch.object(
            delete_user, "cognito_identity", return_value=("username", "", {})
        ):
            self.assertEqual(delete_user.handler(self.event(), CONTEXT)["statusCode"], 500)

        with patch.object(delete_user, "require_admin", return_value=None), patch.object(
            delete_user, "cognito_identity", return_value=("username", "subject", {})
        ), patch.object(delete_user, "assert_admin_target_mutable"), patch.object(
            delete_user, "albums_owned_by", return_value=[]
        ), patch.object(
            delete_user, "preflight_deletion", side_effect=delete_user.DeletionTooLargeError()
        ), patch.object(delete_user.cognito, "admin_delete_user") as delete_identity:
            response = delete_user.handler(self.event(), CONTEXT)
        self.assertEqual(response["statusCode"], 409)
        delete_identity.assert_not_called()

    def test_provider_not_found_and_unexpected_failure(self):
        with patch.object(delete_user, "require_admin", return_value=None), patch.object(
            delete_user,
            "cognito_identity",
            side_effect=provider_exception(delete_user.cognito, "UserNotFoundException"),
        ):
            self.assertEqual(delete_user.handler(self.event(), CONTEXT)["statusCode"], 404)
        with patch.object(delete_user, "require_admin", return_value=None), patch.object(
            delete_user, "cognito_identity", side_effect=RuntimeError("provider secret")
        ):
            response = delete_user.handler(self.event(), CONTEXT)
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("provider secret", response["body"])


if __name__ == "__main__":
    unittest.main()
