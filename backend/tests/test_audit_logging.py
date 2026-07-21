import json
import logging
import os
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from test_support import claims, gateway_event

import audit_helpers
import auth_helpers
import login


class AuditContractTests(unittest.TestCase):
    def _record(self, **overrides):
        values = {
            "event_name": "auth.login",
            "outcome": "success",
            "action": "authentication.login",
            "resource_type": "authentication",
            "reason_code": "authenticated",
            "event": {"requestContext": {"requestId": "gateway-request"}},
            "context": SimpleNamespace(aws_request_id="lambda-request"),
        }
        values.update(overrides)
        return audit_helpers.build_audit_event(**values)

    def test_schema_is_stable_correlated_and_identifier_free(self):
        with patch.dict(
            os.environ,
            {
                "APPLICATION_STAGE": "prod",
                "RELEASE_SHA": "0123456789abcdef",
                "_X_AMZN_TRACE_ID": "Root=1-abcdef12-0123456789abcdef01234567;Parent=0123456789abcdef",
            },
        ):
            record = self._record(details={"challenge_type": "software_token_mfa"})
        self.assertEqual(record["schema_version"], 1)
        self.assertEqual(record["record_type"], "security_audit")
        self.assertEqual(record["request_id"], "lambda-request")
        self.assertEqual(record["environment"], "prod")
        self.assertEqual(record["release_sha"], "0123456789abcdef")
        self.assertEqual(record["details"], {"challenge_type": "software_token_mfa"})
        serialized = json.dumps(record).lower()
        for forbidden in (
            "person@example.com",
            "plain-text-password",
            "cognito-session-value",
            "turnstile-secret-value",
            "albums/private/image.jpg",
            "share-code-value",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_arbitrary_or_sensitive_details_are_rejected(self):
        malicious_values = (
            {"email": "person@example.com"},
            {"token": "secret"},
            {"object_key": "albums/private/image.jpg"},
            {"media_count": -1},
            {"visibility": "surprise"},
        )
        for details in malicious_values:
            with self.subTest(details=details), self.assertRaises(ValueError):
                self._record(details=details)

    def test_invalid_schema_never_breaks_the_business_operation_or_logs_input(self):
        with self.assertLogs("photography_api.audit", level=logging.INFO) as captured:
            self.assertTrue(audit_helpers.emit_audit_event(**{
                "event_name": "auth.login",
                "outcome": "denied",
                "action": "authentication.login",
                "resource_type": "authentication",
                "reason_code": "invalid_credentials",
            }))
        line = captured.output[0]
        self.assertIn('"record_type":"security_audit"', line)
        self.assertNotIn("person@example.com", line)
        self.assertFalse(audit_helpers.emit_audit_event(**{
            "event_name": "auth.login",
            "outcome": "denied",
            "action": "authentication.login",
            "resource_type": "authentication",
            "reason_code": "invalid_credentials",
            "details": {"email": "person@example.com"},
        }))

    def test_actor_classification_does_not_treat_substring_group_as_admin(self):
        self.assertEqual(audit_helpers.actor_context({}), ("anonymous", "none"))
        self.assertEqual(audit_helpers.actor_context(gateway_event(claims(groups=["Admins"]))), ("admin", "jwt"))
        self.assertEqual(audit_helpers.actor_context(gateway_event(claims(groups="SuperAdmins"))), ("user", "jwt"))


class AuditIntegrationTests(unittest.TestCase):
    def test_security_sensitive_handlers_use_the_shared_audit_contract(self):
        functions = Path(__file__).resolve().parents[1] / "functions"
        handlers = (
            "login.py",
            "complete_challenge.py",
            "contact.py",
            "create_user.py",
            "edit_user.py",
            "delete_user.py",
            "create_album.py",
            "update_album.py",
            "delete_album.py",
            "add_images.py",
            "delete_images.py",
            "update_image.py",
            "get_upload_url.py",
            "get_download_url.py",
            "get_shared_album.py",
            "get_album.py",
            "create_zip.py",
        )
        for filename in handlers:
            with self.subTest(filename=filename):
                source = (functions / filename).read_text(encoding="utf-8")
                self.assertIn("from audit_helpers import", source)
                self.assertIn("emit_audit_event(", source)

    def test_login_denial_logs_outcome_without_request_secrets(self):
        event = {
            "body": json.dumps({
                "email": "sensitive@example.com",
                "password": "plain-text-password",
                "turnstileToken": "turnstile-secret-value",
            }),
            "requestContext": {"requestId": "request-123", "http": {"sourceIp": "192.0.2.8"}},
        }
        with patch.object(login, "verify_turnstile", return_value=False), self.assertLogs(
            "photography_api.audit", level=logging.INFO
        ) as captured:
            response = login.handler(event, SimpleNamespace(aws_request_id="lambda-123"))
        self.assertEqual(response["statusCode"], 403)
        joined = "\n".join(captured.output)
        self.assertIn('"event_name":"auth.login"', joined)
        self.assertIn('"reason_code":"captcha_failed"', joined)
        for sensitive in (
            "sensitive@example.com",
            "plain-text-password",
            "turnstile-secret-value",
            "192.0.2.8",
        ):
            self.assertNotIn(sensitive, joined)

    def test_admin_denial_is_audited_without_claim_identifiers(self):
        event = gateway_event(
            claims(subject="private-subject", email="private@example.com", groups=["Users"])
        )
        event["requestContext"]["requestId"] = "request-456"
        with self.assertLogs("photography_api.audit", level=logging.INFO) as captured:
            response = auth_helpers.require_admin(event)
        self.assertEqual(response["statusCode"], 403)
        joined = "\n".join(captured.output)
        self.assertIn('"event_name":"authorization.admin_access"', joined)
        self.assertIn('"actor_type":"user"', joined)
        self.assertNotIn("private-subject", joined)
        self.assertNotIn("private@example.com", joined)


if __name__ == "__main__":
    unittest.main()
