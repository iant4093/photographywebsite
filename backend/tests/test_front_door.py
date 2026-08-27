"""Single-front-door verification and source-level coverage contracts."""

from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import re
import secrets
import unittest
from unittest.mock import MagicMock, patch

import test_support  # noqa: F401  - establishes isolated AWS test environment

import front_door
import get_public_albums


BACKEND_ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS_ROOT = BACKEND_ROOT / "functions"
TEMPLATE_TEXT = (BACKEND_ROOT / "template.yaml").read_text(encoding="utf-8")


def _resource_blocks() -> dict[str, str]:
    return {
        match.group("name"): match.group("body")
        for match in re.finditer(
            r"(?ms)^  (?P<name>[A-Za-z][A-Za-z0-9]+):\n"
            r"(?P<body>.*?)(?=^  [A-Za-z][A-Za-z0-9]+:\n|^Outputs:)",
            TEMPLATE_TEXT,
        )
    }


def _http_handlers() -> dict[str, str]:
    handlers = {}
    for logical_id, block in _resource_blocks().items():
        match = re.search(r"(?m)^      Handler: ([A-Za-z0-9_]+)\.handler$", block)
        if match and "          Type: HttpApi" in block:
            handlers[logical_id] = match.group(1)
    return handlers


class FrontDoorVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        front_door.reset_front_door_cache_for_tests()

    def tearDown(self) -> None:
        front_door.reset_front_door_cache_for_tests()

    def _contract(self) -> tuple[str, str, MagicMock]:
        current = secrets.token_urlsafe(48)
        previous = secrets.token_urlsafe(48)
        client = MagicMock()
        client.get_parameter.return_value = {
            "Parameter": {"Value": json.dumps({"current": current, "previous": previous})}
        }
        return current, previous, client

    def test_enforcement_off_is_backward_compatible_and_never_reads_secret(self) -> None:
        with patch.dict(os.environ, {"FRONT_DOOR_ENFORCEMENT_ENABLED": "false"}), patch.object(
            front_door, "_client", side_effect=AssertionError("secret provider should not be called")
        ):
            self.assertIsNone(front_door.verify_front_door_request({}, None))

    def test_current_and_previous_values_are_accepted_from_one_cached_read(self) -> None:
        current, previous, client = self._contract()
        environment = {
            "FRONT_DOOR_ENFORCEMENT_ENABLED": "true",
            "FRONT_DOOR_CONFIG_PARAMETER": "/ian-website/prod/front-door-config",
            "FRONT_DOOR_SECRET_CACHE_TTL_SECONDS": "300",
        }
        with patch.dict(os.environ, environment), patch.object(front_door, "_ssm_client", client):
            self.assertIsNone(
                front_door.verify_front_door_request(
                    {"headers": {"X-Origin-Verify": current}}, None
                )
            )
            self.assertIsNone(
                front_door.verify_front_door_request(
                    {"headers": {"x-origin-verify": previous}}, None
                )
            )
        client.get_parameter.assert_called_once_with(
            Name=environment["FRONT_DOOR_CONFIG_PARAMETER"], WithDecryption=True
        )

    def test_missing_and_invalid_values_are_fixed_privacy_safe_denials(self) -> None:
        current, previous, client = self._contract()
        environment = {
            "FRONT_DOOR_ENFORCEMENT_ENABLED": "true",
            "FRONT_DOOR_CONFIG_PARAMETER": "/ian-website/prod/front-door-config",
        }
        supplied = secrets.token_urlsafe(48)
        with patch.dict(os.environ, environment), patch.object(
            front_door, "_ssm_client", client
        ), self.assertLogs("photography_api.front_door", level="WARNING") as captured:
            missing = front_door.verify_front_door_request({"headers": {}}, None)
            invalid = front_door.verify_front_door_request(
                {"headers": {"X-Origin-Verify": supplied}}, None
            )
            non_ascii = front_door.verify_front_door_request(
                {"headers": {"X-Origin-Verify": "\N{SNOWMAN}" * 32}}, None
            )
        for response in (missing, invalid, non_ascii):
            self.assertEqual(response["statusCode"], 403)
            self.assertEqual(response["headers"]["Cache-Control"], "private, no-store")
            self.assertEqual(
                json.loads(response["body"]),
                {"error": "Forbidden", "code": "front_door_required"},
            )
        observable = "\n".join(captured.output) + missing["body"] + invalid["body"]
        for sensitive in (current, previous, supplied, environment["FRONT_DOOR_CONFIG_PARAMETER"]):
            self.assertNotIn(sensitive, observable)

    def test_invalid_configuration_and_provider_failure_fail_closed(self) -> None:
        with patch.dict(os.environ, {"FRONT_DOOR_ENFORCEMENT_ENABLED": "typo"}), patch.object(
            front_door, "_client", side_effect=AssertionError("provider should not be called")
        ):
            self.assertEqual(front_door.verify_front_door_request({}, None)["statusCode"], 403)

        client = MagicMock()
        client.get_parameter.side_effect = RuntimeError("provider details must be redacted")
        environment = {
            "FRONT_DOOR_ENFORCEMENT_ENABLED": "true",
            "FRONT_DOOR_CONFIG_PARAMETER": "/ian-website/prod/front-door-config",
        }
        with patch.dict(os.environ, environment), patch.object(
            front_door, "_ssm_client", client
        ), self.assertLogs("photography_api.front_door", level="WARNING") as captured:
            response = front_door.verify_front_door_request(
                {"headers": {"X-Origin-Verify": secrets.token_urlsafe(48)}}, None
            )
        self.assertEqual(response["statusCode"], 403)
        self.assertNotIn("provider details", "\n".join(captured.output) + response["body"])

    def test_handler_denies_before_business_logic_only_when_enforced(self) -> None:
        with patch.dict(
            os.environ,
            {
                "FRONT_DOOR_ENFORCEMENT_ENABLED": "true",
                "FRONT_DOOR_CONFIG_PARAMETER": "/ian-website/prod/front-door-config",
            },
        ), patch.object(get_public_albums, "_fetch_page") as fetch:
            denied = get_public_albums.handler({"queryStringParameters": {}}, None)
        self.assertEqual(denied["statusCode"], 403)
        fetch.assert_not_called()

        with patch.dict(os.environ, {"FRONT_DOOR_ENFORCEMENT_ENABLED": "false"}), patch.object(
            get_public_albums, "_fetch_page", return_value=([], None)
        ) as fetch:
            allowed = get_public_albums.handler({"queryStringParameters": {}}, None)
        self.assertEqual(allowed["statusCode"], 200)
        fetch.assert_called_once()


class FrontDoorCoverageContractTests(unittest.TestCase):
    def test_all_http_handlers_verify_before_any_business_logic(self) -> None:
        handlers = _http_handlers()
        self.assertEqual(len(handlers), 30)
        self.assertEqual(
            len(re.findall(r"(?m)^          Type: HttpApi$", TEMPLATE_TEXT)),
            37,
        )
        for logical_id, module_name in handlers.items():
            with self.subTest(function=logical_id, module=module_name):
                source = (FUNCTIONS_ROOT / f"{module_name}.py").read_text(encoding="utf-8")
                tree = ast.parse(source)
                imports_verifier = any(
                    isinstance(node, ast.ImportFrom)
                    and node.module == "front_door"
                    and any(alias.name == "verify_front_door_request" for alias in node.names)
                    for node in tree.body
                )
                self.assertTrue(imports_verifier)
                handler = next(
                    node
                    for node in tree.body
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and node.name == "handler"
                )
                first = handler.body[0]
                self.assertIsInstance(first, ast.Assign)
                self.assertIsInstance(first.value, ast.Call)
                self.assertIsInstance(first.value.func, ast.Name)
                self.assertEqual(first.value.func.id, "verify_front_door_request")
                self.assertIsInstance(handler.body[1], ast.If)

    def test_each_http_function_has_exact_secret_read_policy(self) -> None:
        handlers = _http_handlers()
        blocks = _resource_blocks()
        for logical_id in handlers:
            with self.subTest(function=logical_id):
                self.assertEqual(
                    blocks[logical_id].count("- !Ref FrontDoorOriginSecretReadPolicy"),
                    1,
                )

    def test_rollout_defaults_are_safe_and_regional_resources_are_retained(self) -> None:
        self.assertRegex(
            TEMPLATE_TEXT,
            r"(?ms)^  FrontDoorEnforcementEnabled:.*?^    Default: 'false'$",
        )
        self.assertRegex(
            TEMPLATE_TEXT,
            r"(?ms)^  DisableExecuteApiEndpoint:.*?^    Default: 'false'$",
        )
        blocks = _resource_blocks()
        for logical_id in (
            "ApiFrontDoorCertificate",
            "ApiFrontDoorDomain",
            "ApiFrontDoorMapping",
            "ApiFrontDoorAlias",
        ):
            with self.subTest(resource=logical_id):
                self.assertIn("DeletionPolicy: Retain", blocks[logical_id])
                self.assertIn("UpdateReplacePolicy: Retain", blocks[logical_id])
        self.assertIn("EndpointType: REGIONAL", blocks["ApiFrontDoorDomain"])
        self.assertIn("SecurityPolicy: TLS_1_2", blocks["ApiFrontDoorDomain"])
        self.assertIn("ApiMappingKey: api", blocks["ApiFrontDoorMapping"])

    def test_media_bucket_emits_eventbridge_events_without_lambda_notifications(self) -> None:
        bucket = _resource_blocks()["ImagesBucket"]
        self.assertIn(
            "NotificationConfiguration:\n"
            "        EventBridgeConfiguration:\n"
            "          EventBridgeEnabled: true",
            bucket,
        )
        self.assertNotIn("LambdaConfigurations:", bucket)
        self.assertNotIn("QueueConfigurations:", bucket)
        self.assertNotIn("TopicConfigurations:", bucket)

    def test_privacy_safe_denials_are_metricized_and_alarmable(self) -> None:
        blocks = _resource_blocks()
        metric_filter = blocks["FrontDoorDeniedMetricFilter"]
        alarm = blocks["FrontDoorDeniedAlarm"]
        self.assertIn("LogGroupName: !Ref ApplicationLogGroup", metric_filter)
        self.assertIn("FilterPattern: '\"front_door_request_denied\"'", metric_filter)
        self.assertIn("MetricName: FrontDoorDenied", metric_filter)
        self.assertIn("Namespace: IanTruongPhotography/Security", alarm)
        self.assertIn("MetricName: FrontDoorDenied", alarm)
        self.assertIn("Threshold: 10", alarm)
        self.assertIn("ian-photography-security-${Stage}", alarm)


if __name__ == "__main__":
    unittest.main()
