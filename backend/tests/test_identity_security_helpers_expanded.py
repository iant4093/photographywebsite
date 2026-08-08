import base64
from decimal import Decimal
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from test_support import claims, gateway_event, response_body

import audit_helpers
import auth_helpers
import dynamodb_helpers
import email_helpers
import owner_helpers
import response_helpers
import secret_helpers
import security_helpers
import validation_helpers


class AuthHelperBranchTests(unittest.TestCase):
    def tearDown(self):
        auth_helpers._jwks_client = None

    def test_configuration_fails_closed_and_accepts_explicit_issuer(self):
        with patch.dict(os.environ, {"COGNITO_USER_POOL_ID": "", "COGNITO_CLIENT_ID": ""}):
            with self.assertRaises(auth_helpers.AuthError) as raised:
                auth_helpers._configuration()
        self.assertEqual(raised.exception.status_code, 503)
        with patch.dict(
            os.environ,
            {
                "COGNITO_USER_POOL_ID": "pool",
                "COGNITO_CLIENT_ID": "client",
                "COGNITO_ISSUER": "https://issuer.example/",
            },
        ):
            self.assertEqual(auth_helpers._configuration(), ("https://issuer.example", "client"))

    def test_jwks_client_is_cached_only_for_the_exact_uri(self):
        clients = []

        class FakePyJWKClient:
            def __init__(self, uri, **kwargs):
                self.uri = uri
                self.kwargs = kwargs
                clients.append(self)

        fake_jwt = SimpleNamespace(PyJWKClient=FakePyJWKClient)
        with patch.dict("sys.modules", {"jwt": fake_jwt}), patch.dict(
            os.environ,
            {
                "COGNITO_USER_POOL_ID": "pool-a",
                "COGNITO_CLIENT_ID": "client",
                "COGNITO_ISSUER": "https://issuer-a.example",
            },
        ):
            first = auth_helpers._get_jwks_client()
            self.assertIs(auth_helpers._get_jwks_client(), first)
            os.environ["COGNITO_ISSUER"] = "https://issuer-b.example"
            second = auth_helpers._get_jwks_client()
        self.assertIsNot(first, second)
        self.assertEqual(len(clients), 2)
        self.assertEqual(first.kwargs["timeout"], 5)

    def test_group_parsing_covers_provider_shapes(self):
        self.assertEqual(auth_helpers.parse_groups(None), set())
        self.assertEqual(auth_helpers.parse_groups([" Admins ", "", 7]), {"Admins", "7"})
        self.assertEqual(auth_helpers.parse_groups(42), set())
        self.assertEqual(auth_helpers.parse_groups("   "), set())
        self.assertEqual(auth_helpers.parse_groups('["Admins", "Editors"]'), {"Admins", "Editors"})
        self.assertEqual(auth_helpers.parse_groups('"Admins"'), {"Admins"})
        self.assertEqual(auth_helpers.parse_groups("[Admins,'Editors']"), {"Admins", "Editors"})

    def test_claim_semantics_cover_lists_bad_types_and_missing_configuration(self):
        valid = claims()
        self.assertEqual(auth_helpers._validate_claim_semantics({**valid, "aud": ["other", "test-client-id"]}), {
            **valid,
            "aud": ["other", "test-client-id"],
        })
        for candidate in (None, [], {**valid, "exp": "not-a-number"}):
            with self.subTest(candidate=candidate), self.assertRaises(auth_helpers.AuthError):
                auth_helpers._validate_claim_semantics(candidate)

    def test_bearer_parser_rejects_every_malformed_boundary(self):
        self.assertIsNone(auth_helpers._bearer_token({"headers": None}))
        self.assertEqual(
            auth_helpers._bearer_token({"headers": {"AUTHORIZATION": "Bearer opaque"}}),
            "opaque",
        )
        for header in ("Basic token", "Bearer", "Bearer ", "Bearer " + "x" * 16385):
            with self.subTest(header=header[:20]), self.assertRaises(auth_helpers.AuthError):
                auth_helpers._bearer_token({"headers": {"authorization": header}})

    def test_bearer_decode_redacts_provider_failures_and_preserves_auth_errors(self):
        fake_jwt = SimpleNamespace(decode=Mock(side_effect=RuntimeError("token details")))
        with patch.dict("sys.modules", {"jwt": fake_jwt}), patch.object(
            auth_helpers,
            "_get_jwks_client",
            return_value=Mock(get_signing_key_from_jwt=Mock(return_value=SimpleNamespace(key="key"))),
        ):
            with self.assertRaises(auth_helpers.AuthError) as raised:
                auth_helpers.get_verified_claims({"headers": {"authorization": "Bearer opaque"}})
        self.assertEqual(str(raised.exception), "Unauthorized")

        with patch.object(auth_helpers, "_configuration", side_effect=auth_helpers.AuthError("Unavailable", 503)):
            with self.assertRaises(auth_helpers.AuthError) as propagated:
                auth_helpers.get_verified_claims({"headers": {"authorization": "Bearer opaque"}})
        self.assertEqual(propagated.exception.status_code, 503)

    def test_admin_denials_are_audited_and_caller_helpers_normalize(self):
        with patch.object(auth_helpers, "emit_audit_event") as emit:
            response = auth_helpers.require_admin({})
        self.assertEqual(response["statusCode"], 401)
        self.assertEqual(emit.call_args.kwargs["reason_code"], "authentication_required")

        with patch.object(auth_helpers, "get_verified_claims", side_effect=auth_helpers.AuthError("Unavailable", 503)), patch.object(
            auth_helpers, "emit_audit_event"
        ) as emit:
            response = auth_helpers.require_admin({})
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(emit.call_args.kwargs["reason_code"], "authentication_unavailable")

        event = gateway_event(claims(subject=" subject ", email=" USER@Example.com "))
        self.assertEqual(auth_helpers.get_caller_claims(event)["sub"], " subject ")
        self.assertEqual(auth_helpers.get_caller_email(event), "user@example.com")
        self.assertEqual(auth_helpers.get_caller_sub(event), "subject")

    def test_auth_error_response_uses_safe_defaults(self):
        body = response_body(auth_helpers.auth_error_response(RuntimeError("provider detail")))
        self.assertEqual(body, {"error": "Unauthorized"})
        self.assertEqual(auth_helpers.auth_error_response(auth_helpers.AuthError("No", 403))["statusCode"], 403)


class AuditHelperBranchTests(unittest.TestCase):
    def valid(self, **updates):
        values = {
            "event_name": "auth.login",
            "outcome": "success",
            "action": "authentication.login",
            "resource_type": "authentication",
            "reason_code": "authenticated",
        }
        values.update(updates)
        return values

    def test_schema_enums_and_patterns_fail_closed(self):
        mutations = (
            {"event_name": "bad"},
            {"action": "BAD.ACTION"},
            {"reason_code": "bad-code"},
            {"outcome": "maybe"},
            {"actor_type": "owner"},
            {"auth_method": "password"},
            {"resource_type": "secret"},
            {"severity": "critical"},
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                audit_helpers.build_audit_event(**self.valid(**mutation))

    def test_environment_release_correlation_and_severity_paths(self):
        context = SimpleNamespace(aws_request_id="lambda/request:1")
        with patch.dict(
            os.environ,
            {"APPLICATION_STAGE": "Prod-1", "RELEASE_SHA": "abcdef0", "_X_AMZN_TRACE_ID": "Root=1-abc"},
        ):
            record = audit_helpers.build_audit_event(
                **self.valid(outcome="denied"), context=context, severity=None
            )
        self.assertEqual(record["environment"], "prod-1")
        self.assertEqual(record["severity"], "warning")
        self.assertEqual(record["request_id"], "lambda/request:1")
        self.assertEqual(record["trace_id"], "Root=1-abc")

        event = {"requestContext": {"requestId": "gateway-id"}}
        self.assertEqual(audit_helpers.build_audit_event(**self.valid(), event=event)["request_id"], "gateway-id")
        self.assertEqual(
            audit_helpers.build_audit_event(
                **self.valid(), event={"requestContext": {"requestId": "unsafe value!"}}
            )["request_id"],
            "unknown",
        )
        with patch.dict(os.environ, {"APPLICATION_STAGE": "bad stage"}):
            with self.assertRaises(ValueError):
                audit_helpers.build_audit_event(**self.valid())
        with patch.dict(os.environ, {"RELEASE_SHA": "not-a-sha"}):
            with self.assertRaises(ValueError):
                audit_helpers.build_audit_event(**self.valid())

    def test_detail_allowlist_types_ranges_and_empty(self):
        self.assertIsNone(audit_helpers._validated_details(None))
        self.assertIsNone(audit_helpers._validated_details({}))
        valid = {"album_count": 0, "visibility": "private", "challenge_type": "other"}
        self.assertEqual(audit_helpers._validated_details(valid), valid)
        invalid = (
            [],
            {str(index): 1 for index in range(20)},
            {"email": "private@example.com"},
            {"album_count": True},
            {"album_count": -1},
            {"album_count": 10_000_001},
            {"visibility": "secret"},
            {"visibility": 1},
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                audit_helpers._validated_details(value)

    def test_emitter_swallows_logger_failure(self):
        with patch.object(audit_helpers.logger, "info", side_effect=RuntimeError("sink down")):
            self.assertFalse(audit_helpers.emit_audit_event(**self.valid()))

    def test_actor_context_provider_shapes(self):
        self.assertEqual(audit_helpers.actor_context(gateway_event(claims(groups=("Admins",)))), ("admin", "jwt"))
        self.assertEqual(audit_helpers.actor_context(gateway_event(claims(groups='["Admins"]'))), ("admin", "jwt"))
        self.assertEqual(audit_helpers.actor_context(gateway_event(claims(groups="[Editors]"))), ("user", "jwt"))
        self.assertEqual(audit_helpers.actor_context(gateway_event(claims(groups=42))), ("user", "jwt"))


class SecretHelperBranchTests(unittest.TestCase):
    def setUp(self):
        secret_helpers.clear_secret_cache()
        secret_helpers._client = None

    def tearDown(self):
        secret_helpers.clear_secret_cache()
        secret_helpers._client = None

    def test_ssm_client_is_cached(self):
        fake = Mock()
        with patch.object(secret_helpers.boto3, "client", return_value=fake) as factory:
            self.assertIs(secret_helpers._ssm_client(), fake)
            self.assertIs(secret_helpers._ssm_client(), fake)
        factory.assert_called_once_with("ssm")

    def test_raw_json_and_empty_secret_paths(self):
        fake = Mock()
        with patch.dict(os.environ, {"PARAMETER": "/test", "DIRECT": "fallback"}), patch.object(
            secret_helpers, "_ssm_client", return_value=fake
        ):
            fake.get_parameter.return_value = {"Parameter": {"Value": " raw-value "}}
            self.assertEqual(
                secret_helpers.resolve_secret(
                    direct_env="DIRECT", parameter_env="PARAMETER", json_keys=("key",)
                ),
                "raw-value",
            )
            secret_helpers.clear_secret_cache()
            fake.get_parameter.return_value = {"Parameter": {"Value": '{"wrong":"value"}'}}
            with self.assertRaises(RuntimeError):
                secret_helpers.resolve_secret(
                    direct_env="DIRECT", parameter_env="PARAMETER", json_keys=("key",)
                )
            secret_helpers.clear_secret_cache()
            fake.get_parameter.return_value = {"Parameter": {"Value": "  "}}
            with self.assertRaises(RuntimeError):
                secret_helpers.resolve_secret(direct_env="DIRECT", parameter_env="PARAMETER")

    def test_direct_secret_is_trimmed(self):
        with patch.dict(os.environ, {"DIRECT": " direct ", "PARAMETER": ""}):
            self.assertEqual(
                secret_helpers.resolve_secret(direct_env="DIRECT", parameter_env="PARAMETER"),
                "direct",
            )


class SecurityHelperBranchTests(unittest.TestCase):
    def setUp(self):
        security_helpers._rate_table = None

    def tearDown(self):
        security_helpers._rate_table = None

    def test_rate_table_configuration_and_cache(self):
        with patch.dict(os.environ, {"RATE_LIMIT_TABLE": ""}):
            with self.assertRaises(RuntimeError):
                security_helpers._get_rate_table()
        table = Mock()
        resource = Mock(Table=Mock(return_value=table))
        with patch.dict(os.environ, {"RATE_LIMIT_TABLE": "rate"}), patch.object(
            security_helpers.boto3, "resource", return_value=resource
        ) as factory:
            self.assertIs(security_helpers._get_rate_table(), table)
            self.assertIs(security_helpers._get_rate_table(), table)
        factory.assert_called_once_with("dynamodb")

    def test_rate_limit_input_and_provider_error_paths(self):
        for args in ((None, 1, 1), ("x" * 65, 1, 1), ("ok", "x", 1), ("ok", 1, 0)):
            with self.subTest(args=args):
                self.assertFalse(security_helpers.check_rate_limit("id", *args, now=1))
        conditional = ClientError(
            {"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem"
        )
        table = Mock()
        table.update_item.side_effect = [conditional, {"Attributes": {}}]
        with patch.object(security_helpers, "_get_rate_table", return_value=table):
            self.assertFalse(security_helpers.check_rate_limit("id", "action", 2, 10, now=1))
        table.update_item.side_effect = ClientError({"Error": {"Code": "AccessDenied"}}, "UpdateItem")
        with patch.object(security_helpers, "_get_rate_table", return_value=table):
            self.assertFalse(security_helpers.check_rate_limit("id", "action", 2, 10, now=1))

    def test_identifier_hash_is_normalized_and_action_scoped(self):
        with patch.object(security_helpers, "resolve_secret", return_value="secret"):
            first = security_helpers._identifier_hash(" User@Example.com ", "login")
            second = security_helpers._identifier_hash("user@example.com", "login")
            other = security_helpers._identifier_hash("user@example.com", "contact")
        self.assertEqual(first, second)
        self.assertNotEqual(first, other)
        self.assertNotIn("example.com", first)

    def _turnstile_response(self, payload):
        response = Mock()
        response.read.return_value = payload
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        return response

    def test_turnstile_rejects_invalid_input_secret_and_provider_shapes(self):
        self.assertFalse(security_helpers.verify_turnstile(None))
        self.assertFalse(security_helpers.verify_turnstile("x" * 4097))
        with patch.object(security_helpers, "resolve_secret", side_effect=RuntimeError("missing")):
            self.assertFalse(security_helpers.verify_turnstile("token"))
        with patch.object(security_helpers, "resolve_secret", return_value="secret"), patch.object(
            security_helpers.urllib.request, "urlopen", side_effect=TimeoutError()
        ):
            self.assertFalse(security_helpers.verify_turnstile("token"))
        with patch.object(security_helpers, "resolve_secret", return_value="secret"), patch.object(
            security_helpers.urllib.request,
            "urlopen",
            return_value=self._turnstile_response(b"x" * 65537),
        ):
            self.assertFalse(security_helpers.verify_turnstile("token"))
        with patch.object(security_helpers, "resolve_secret", return_value="secret"), patch.object(
            security_helpers.urllib.request,
            "urlopen",
            return_value=self._turnstile_response(b"not-json"),
        ):
            self.assertFalse(security_helpers.verify_turnstile("token"))

    def test_turnstile_success_hostname_action_and_timeout_boundaries(self):
        cases = (
            ({"success": False}, False),
            ({"success": True, "hostname": "wrong", "action": "login"}, False),
            ({"success": True, "hostname": "allowed", "action": "wrong"}, False),
            ({"success": True, "hostname": "allowed", "action": "configured"}, True),
        )
        for payload, expected in cases:
            with self.subTest(payload=payload), patch.dict(
                os.environ,
                {
                    "TURNSTILE_EXPECTED_HOSTNAMES": "allowed, other",
                    "TURNSTILE_LOGIN_ACTION": "configured",
                    "TURNSTILE_TIMEOUT_SECONDS": "99",
                },
            ), patch.object(security_helpers, "resolve_secret", return_value="secret"), patch.object(
                security_helpers.urllib.request,
                "urlopen",
                return_value=self._turnstile_response(json.dumps(payload).encode()),
            ) as opener:
                self.assertEqual(
                    security_helpers.verify_turnstile("token", "i" * 100, expected_action="login"),
                    expected,
                )
                self.assertEqual(opener.call_args.kwargs["timeout"], 10.0)
        with patch.dict(os.environ, {"TURNSTILE_EXPECTED_HOSTNAMES": ""}), patch.object(
            security_helpers, "resolve_secret", return_value="secret"
        ), patch.object(
            security_helpers.urllib.request,
            "urlopen",
            return_value=self._turnstile_response(b'{"success":true}'),
        ):
            self.assertTrue(security_helpers.verify_turnstile("token"))

    def test_text_sanitization(self):
        self.assertEqual(security_helpers.sanitize_text(None), "")
        self.assertEqual(
            security_helpers.sanitize_text(' <b>"x"</b> ', maximum=6),
            "&lt;b&gt;&quot;x&quot;",
        )


class ValidationHelperBranchTests(unittest.TestCase):
    def test_json_body_empty_type_and_base64_failures(self):
        self.assertEqual(validation_helpers.parse_json_body({}), {})
        self.assertEqual(validation_helpers.parse_json_body({"body": ""}), {})
        with self.assertRaises(validation_helpers.ValidationError):
            validation_helpers.parse_json_body({"body": {}})
        for raw in ("***", base64.b64encode(b"\xff").decode()):
            with self.subTest(raw=raw), self.assertRaises(validation_helpers.ValidationError):
                validation_helpers.parse_json_body({"body": raw, "isBase64Encoded": True})

    def test_string_optional_email_bool_list_and_limit_boundaries(self):
        self.assertEqual(validation_helpers.require_string(" x ", "field"), "x")
        self.assertEqual(validation_helpers.require_string(" x ", "field", strip=False), " x ")
        for value in (None, 7):
            with self.assertRaises(validation_helpers.ValidationError):
                validation_helpers.require_string(value, "field")
        with self.assertRaises(validation_helpers.ValidationError):
            validation_helpers.require_string("", "field")
        self.assertEqual(validation_helpers.optional_string(None, "field", default="d"), "d")
        self.assertEqual(validation_helpers.optional_string(" x ", "field"), "x")
        with self.assertRaises(validation_helpers.ValidationError):
            validation_helpers.optional_string(1, "field")
        with self.assertRaises(validation_helpers.ValidationError):
            validation_helpers.optional_string("xx", "field", maximum=1)
        self.assertEqual(validation_helpers.validate_email(None, required=False), "")
        self.assertTrue(validation_helpers.validate_bool(True, "flag"))
        self.assertFalse(validation_helpers.validate_bool(None, "flag"))
        with self.assertRaises(validation_helpers.ValidationError):
            validation_helpers.validate_bool(1, "flag")
        self.assertEqual(validation_helpers.validate_list(None, "items"), [])
        self.assertEqual(validation_helpers.validate_list([], "items"), [])
        for value, required in (("x", False), ([], True), ([1, 2], False)):
            with self.subTest(value=value), self.assertRaises(validation_helpers.ValidationError):
                validation_helpers.validate_list(value, "items", maximum=1, required=required)
        self.assertEqual(validation_helpers.validate_limit(None), 20)
        self.assertEqual(validation_helpers.validate_limit("2"), 2)
        for value in (object(), 0, 51):
            with self.subTest(value=value), self.assertRaises(validation_helpers.ValidationError):
                validation_helpers.validate_limit(value)

    def test_visibility_and_type_defaults(self):
        self.assertEqual(validation_helpers.validate_visibility(None, default="private"), "private")
        self.assertEqual(validation_helpers.validate_album_type(None), "photo")


class OwnerHelperBranchTests(unittest.TestCase):
    def setUp(self):
        self.original_table = owner_helpers.table

    def tearDown(self):
        owner_helpers.table = self.original_table

    def test_pages_passes_tokens_and_terminates(self):
        method = Mock(
            side_effect=[
                {"Items": [{"albumId": "a"}], "LastEvaluatedKey": {"albumId": "a"}},
                {"Items": [{"albumId": "b"}]},
            ]
        )
        self.assertEqual(list(owner_helpers._pages(method, Limit=2)), [{"albumId": "a"}, {"albumId": "b"}])
        self.assertEqual(method.call_args_list[1].kwargs["ExclusiveStartKey"], {"albumId": "a"})

    def test_album_lookup_uses_index_and_deduplicates_legacy(self):
        owner_helpers.table = Mock()
        owner_helpers.table.query.return_value = {
            "Items": [{"albumId": "same", "source": "query"}, {"missing": True}]
        }
        owner_helpers.table.scan.return_value = {
            "Items": [{"albumId": "same", "source": "legacy"}, {"albumId": "legacy"}, {}]
        }
        with patch.dict(os.environ, {"ALBUM_INDEX_DEPLOYMENT_PHASE": "both"}):
            result = owner_helpers.albums_owned_by("subject", "USER@example.com")
        self.assertEqual({item["albumId"] for item in result}, {"same", "legacy"})
        owner_helpers.table.query.assert_called_once()
        owner_helpers.table.scan.assert_called_once()

    def test_album_lookup_scan_paths(self):
        owner_helpers.table = Mock()
        owner_helpers.table.scan.return_value = {"Items": [{"albumId": "one"}, {}]}
        with patch.dict(os.environ, {"ALBUM_INDEX_DEPLOYMENT_PHASE": "none"}):
            self.assertEqual(owner_helpers.albums_owned_by("subject", "email@example.com"), [{"albumId": "one"}])
            self.assertEqual(owner_helpers.albums_owned_by("", "email@example.com"), [{"albumId": "one"}])
        self.assertEqual(owner_helpers.table.scan.call_count, 2)

    def test_cognito_identity_and_group_pagination(self):
        cognito = Mock()
        cognito.admin_get_user.return_value = {
            "Username": "opaque",
            "UserAttributes": [{"Name": "sub", "Value": "subject"}, {"Value": "ignored"}],
        }
        self.assertEqual(
            owner_helpers.cognito_identity(cognito, "pool", "email@example.com")[:2],
            ("opaque", "subject"),
        )
        cognito.admin_list_groups_for_user.side_effect = [
            {"Groups": [{"GroupName": "Admins"}, {}, "bad"], "NextToken": "next"},
            {"Groups": [{"GroupName": "Editors"}]},
        ]
        self.assertEqual(owner_helpers.groups_for_user(cognito, "pool", "user"), {"Admins", "Editors"})
        self.assertEqual(cognito.admin_list_groups_for_user.call_args_list[1].kwargs["NextToken"], "next")

    def test_group_pagination_repeated_malformed_and_limit(self):
        for responses in (
            [{"NextToken": 123}],
            [{"NextToken": "same"}, {"NextToken": "same"}],
            [{"NextToken": "one"}, {"NextToken": "two"}],
        ):
            cognito = Mock()
            cognito.admin_list_groups_for_user.side_effect = responses
            limit = 2 if len(responses) > 1 else 10
            with self.subTest(responses=responses), self.assertRaises(RuntimeError):
                owner_helpers.groups_for_user(cognito, "pool", "user", max_pages=limit)

    def test_mutable_target_without_admin_group(self):
        cognito = Mock()
        cognito.admin_list_groups_for_user.return_value = {"Groups": []}
        with patch.object(owner_helpers, "get_caller_claims", return_value={"sub": "caller"}):
            self.assertIsNone(
                owner_helpers.assert_admin_target_mutable({}, cognito, "pool", "user", "target")
            )


class EmailResponseAndDynamoHelperTests(unittest.TestCase):
    def test_email_resolves_secret_and_strips_header_newlines(self):
        with patch.object(email_helpers, "resolve_secret", return_value="api-key") as resolve, patch.object(
            email_helpers.resend.Emails, "send", return_value={"id": "message"}
        ) as send:
            result = email_helpers.send_email("to@example.com", "subject\r\ninjected", "<p>body</p>")
        self.assertEqual(result, {"id": "message"})
        self.assertEqual(email_helpers.resend.api_key, "api-key")
        self.assertNotIn("\n", send.call_args.args[0]["subject"])
        self.assertLessEqual(len(send.call_args.args[0]["subject"]), 200)
        self.assertEqual(resolve.call_args.kwargs["json_keys"][0], "apiKey")

    def test_response_encoder_headers_and_redacted_logging(self):
        encoded = response_helpers.json_response(
            200,
            {"whole": Decimal("2"), "fraction": Decimal("2.5")},
            cache_control="public",
            headers={"X-Test": "yes"},
        )
        self.assertEqual(response_body(encoded), {"whole": 2, "fraction": 2.5})
        self.assertEqual(encoded["headers"]["Cache-Control"], "public")
        self.assertEqual(encoded["headers"]["X-Test"], "yes")
        with self.assertRaises(TypeError):
            response_helpers.DynamoJsonEncoder().encode({"bad": object()})
        self.assertEqual(response_body(response_helpers.error_response(400, "bad")), {"error": "bad"})
        with patch.object(response_helpers.logger, "error") as log:
            response = response_helpers.internal_error(
                SimpleNamespace(aws_request_id="request"), RuntimeError("secret text"), "operation"
            )
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("secret text", str(log.call_args))

    def test_dynamodb_budget_configuration_and_estimate(self):
        with patch.dict(os.environ, {"ALBUM_ITEM_BUDGET_BYTES": "bad"}):
            self.assertEqual(dynamodb_helpers.album_item_budget_bytes(), 350 * 1024)
        with patch.dict(os.environ, {"ALBUM_ITEM_BUDGET_BYTES": "1"}):
            self.assertEqual(dynamodb_helpers.album_item_budget_bytes(), 64 * 1024)
        with patch.dict(os.environ, {"ALBUM_ITEM_BUDGET_BYTES": str(999 * 1024)}):
            self.assertEqual(dynamodb_helpers.album_item_budget_bytes(), 350 * 1024)
        self.assertGreater(dynamodb_helpers.estimated_item_bytes({"value": "é"}), 0)
        with patch.object(dynamodb_helpers, "estimated_item_bytes", return_value=1), patch.object(
            dynamodb_helpers, "album_item_budget_bytes", return_value=2
        ):
            self.assertIsNone(dynamodb_helpers.ensure_album_item_budget({}))


if __name__ == "__main__":
    unittest.main()
