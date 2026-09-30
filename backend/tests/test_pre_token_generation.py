import copy
import logging
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError, ConnectTimeoutError

import test_support  # noqa: F401 - establishes the functions path and test env

import pre_token_generation


def cognito_event(groups, *, trigger="TokenGeneration_Authentication", response=None):
    return {
        "version": "1",
        "triggerSource": trigger,
        "region": "us-west-2",
        "userPoolId": "us-west-2_testpool",
        "userName": "private-username",
        "callerContext": {"awsSdkVersion": "aws-sdk-unknown", "clientId": "test-client-id"},
        "request": {
            "userAttributes": {"sub": "user-sub", "email": "person@example.com"},
            "groupConfiguration": {
                "groupsToOverride": groups,
                "iamRolesToOverride": [],
                "preferredRole": None,
            },
        },
        "response": {"claimsOverrideDetails": None} if response is None else response,
    }


def provider(mfa_settings=None, *, error=None):
    client = Mock()
    if error is not None:
        client.admin_get_user.side_effect = error
    else:
        user = {"Username": "private-username", "UserAttributes": []}
        if mfa_settings is not None:
            user["UserMFASettingList"] = mfa_settings
        client.admin_get_user.return_value = user
    return client


class PreTokenGenerationTests(unittest.TestCase):
    def run_trigger(self, event, client):
        with patch.object(pre_token_generation, "_client", return_value=client):
            return pre_token_generation.handler(event, None)

    @staticmethod
    def added_claims(event):
        return event["response"]["claimsOverrideDetails"]["claimsToAddOrOverride"]

    def test_non_admins_are_returned_untouched_without_a_cognito_call(self):
        for groups in ([], ["Editors"], ["SuperAdmins", "AdminsBackup"], None, "SuperAdmins", 7):
            with self.subTest(groups=groups):
                event = cognito_event(groups)
                original = copy.deepcopy(event)
                client = provider(["SOFTWARE_TOKEN_MFA"])
                result = self.run_trigger(event, client)
                self.assertIs(result, event)
                self.assertEqual(result, original)
                client.admin_get_user.assert_not_called()

    def test_missing_group_configuration_is_treated_as_non_admin(self):
        event = {"userPoolId": "pool", "userName": "user", "response": {}}
        client = provider(["SOFTWARE_TOKEN_MFA"])
        self.assertEqual(self.run_trigger(event, client), {"userPoolId": "pool", "userName": "user", "response": {}})
        client.admin_get_user.assert_not_called()

    def test_admin_with_totp_is_stamped_enabled(self):
        for trigger in ("TokenGeneration_Authentication", "TokenGeneration_RefreshTokens"):
            with self.subTest(trigger=trigger):
                client = provider(["SOFTWARE_TOKEN_MFA"])
                event = self.run_trigger(cognito_event(["Admins"], trigger=trigger), client)
                self.assertEqual(self.added_claims(event), {"admin_mfa": "enabled"})
                client.admin_get_user.assert_called_once_with(
                    UserPoolId="us-west-2_testpool", Username="private-username"
                )

    def test_admin_without_totp_is_stamped_missing(self):
        for settings in (None, [], ["SMS_MFA"]):
            with self.subTest(settings=settings):
                event = self.run_trigger(cognito_event(["Admins"]), provider(settings))
                self.assertEqual(self.added_claims(event), {"admin_mfa": "missing"})

    def test_provider_failure_is_unverified_does_not_raise_and_logs_privately(self):
        failures = (
            ClientError({"Error": {"Code": "TooManyRequestsException", "Message": "person@example.com"}}, "AdminGetUser"),
            ConnectTimeoutError(endpoint_url="https://cognito-idp.us-west-2.amazonaws.com"),
            RuntimeError("private-username"),
        )
        for error in failures:
            with self.subTest(error=type(error).__name__), self.assertLogs(
                "photography_api.pre_token_generation", level=logging.WARNING
            ) as captured:
                event = self.run_trigger(cognito_event(["Admins"]), provider(error=error))
                self.assertEqual(self.added_claims(event), {"admin_mfa": "unverified"})
                joined = "\n".join(captured.output)
                self.assertIn(type(error).__name__, joined)
                for private in ("private-username", "person@example.com", "us-west-2_testpool", "user-sub"):
                    self.assertNotIn(private, joined)

    def test_existing_override_details_are_merged_not_replaced(self):
        existing = {
            "claimsOverrideDetails": {
                "claimsToAddOrOverride": {"custom_claim": "kept", "admin_mfa": "enabled"},
                "claimsToSuppress": ["email_verified"],
                "groupOverrideDetails": {"groupsToOverride": ["Admins"]},
            },
            "otherResponseKey": "kept",
        }
        event = self.run_trigger(cognito_event(["Admins"], response=existing), provider([]))
        self.assertEqual(
            event["response"],
            {
                "claimsOverrideDetails": {
                    "claimsToAddOrOverride": {"custom_claim": "kept", "admin_mfa": "missing"},
                    "claimsToSuppress": ["email_verified"],
                    "groupOverrideDetails": {"groupsToOverride": ["Admins"]},
                },
                "otherResponseKey": "kept",
            },
        )

    def test_malformed_response_containers_are_replaced_safely(self):
        for response in ("not-a-dict", {"claimsOverrideDetails": "bad"}, {"claimsOverrideDetails": {"claimsToAddOrOverride": None}}):
            with self.subTest(response=response):
                event = cognito_event(["Admins"])
                event["response"] = response
                result = self.run_trigger(event, provider(["SOFTWARE_TOKEN_MFA"]))
                self.assertEqual(self.added_claims(result), {"admin_mfa": "enabled"})

    def test_group_string_formats_match_exactly(self):
        admin_formats = (["Admins"], ("Editors", " Admins "), '["Admins", "Editors"]', "[Admins,Editors]", "[Admins]", "Admins", '"Admins"', "['Admins']")
        for groups in admin_formats:
            with self.subTest(groups=groups):
                client = provider(["SOFTWARE_TOKEN_MFA"])
                event = self.run_trigger(cognito_event(groups), client)
                self.assertEqual(self.added_claims(event), {"admin_mfa": "enabled"})
        for groups in ("", "   ", "[SuperAdmins]", '["AdminsBackup"]', "Admins2,Editors"):
            with self.subTest(groups=groups):
                client = provider(["SOFTWARE_TOKEN_MFA"])
                self.run_trigger(cognito_event(groups), client)
                client.admin_get_user.assert_not_called()

    def test_client_is_created_once_with_a_budget_inside_cognitos_trigger_timeout(self):
        sentinel = Mock()
        with patch.object(pre_token_generation, "_cognito", None), patch.object(
            pre_token_generation.boto3, "client", return_value=sentinel
        ) as factory:
            self.assertIs(pre_token_generation._client(), sentinel)
            self.assertIs(pre_token_generation._client(), sentinel)
        factory.assert_called_once()
        service = factory.call_args.args[0]
        config = factory.call_args.kwargs["config"]
        self.assertEqual(service, "cognito-idp")
        self.assertEqual(config.retries, {"mode": "standard", "total_max_attempts": 1})
        self.assertLessEqual(config.connect_timeout + config.read_timeout, 3)


if __name__ == "__main__":
    unittest.main()
