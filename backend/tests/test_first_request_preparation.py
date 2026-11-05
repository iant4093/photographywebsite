"""One-time setup for the Before comparison runs during Lambda initialization."""

import importlib
import json
import os
import unittest
from unittest.mock import MagicMock, patch

import test_support  # noqa: F401  - establishes isolated AWS test environment

import front_door
import get_download_url
import media_access
import original_comparison_access
import security_helpers


ENFORCED = {"FRONT_DOOR_ENFORCEMENT_ENABLED": "true", "FRONT_DOOR_CONFIG_PARAMETER": "/front-door"}


class FrontDoorPrefetchTests(unittest.TestCase):
    def setUp(self):
        front_door.reset_front_door_cache_for_tests()
        self.addCleanup(front_door.reset_front_door_cache_for_tests)

    def test_caches_the_secret_so_the_first_request_reads_nothing(self):
        current = "c" * 48
        client = MagicMock()
        client.get_parameter.return_value = {"Parameter": {"Value": json.dumps({"current": current})}}
        with patch.dict(os.environ, ENFORCED), patch.object(front_door, "_client", return_value=client):
            front_door.prefetch_front_door_secret()
            self.assertIsNone(front_door.verify_front_door_request({"headers": {"X-Origin-Verify": current}}))
        client.get_parameter.assert_called_once_with(Name="/front-door", WithDecryption=True)

    def test_skips_when_not_enforced_or_not_configured(self):
        unused = MagicMock(side_effect=AssertionError("secret should not be read"))
        for environment in ({"FRONT_DOOR_ENFORCEMENT_ENABLED": "false"}, {**ENFORCED, "FRONT_DOOR_CONFIG_PARAMETER": " "},
                            {**ENFORCED, "FRONT_DOOR_ENFORCEMENT_ENABLED": "maybe"}):
            with patch.dict(os.environ, environment), patch.object(front_door, "_client", unused):
                front_door.prefetch_front_door_secret()

    def test_provider_failure_is_logged_without_details_and_retried_on_demand(self):
        client = MagicMock()
        client.get_parameter.side_effect = RuntimeError("secret-value-in-error")
        with patch.dict(os.environ, ENFORCED), patch.object(front_door, "_client", return_value=client), \
                self.assertLogs("photography_api.front_door", "WARNING") as logs:
            front_door.prefetch_front_door_secret()
        self.assertEqual(logs.output, ["WARNING:photography_api.front_door:front_door_prefetch_failed"])
        self.assertEqual(front_door._CACHE["expires_at"], 0.0)


class RateLimitPreparationTests(unittest.TestCase):
    def test_creates_the_table_client_and_reads_the_hash_secret(self):
        with patch.object(security_helpers, "_get_rate_table") as table, \
                patch.object(security_helpers, "resolve_secret", return_value="secret") as secret:
            security_helpers.prepare_rate_limits()
        table.assert_called_once_with()
        secret.assert_called_once_with(direct_env="RATE_LIMIT_HASH_SECRET", parameter_env="RATE_LIMIT_HASH_PARAMETER",
                                       json_keys=("secret", "hashSecret", "RATE_LIMIT_HASH_SECRET"))

    def test_failure_is_logged_by_type_only(self):
        with patch.object(security_helpers, "_get_rate_table", side_effect=RuntimeError("table-name")), \
                self.assertLogs("photography_api.security_helpers", "WARNING") as logs:
            security_helpers.prepare_rate_limits()
        self.assertEqual(logs.output, ["WARNING:photography_api.security_helpers:rate_limit_prepare_failed error_type=RuntimeError"])


class FirstRequestPreparationTests(unittest.TestCase):
    def patches(self, s3_error=None):
        return (
            patch.object(get_download_url, "prefetch_front_door_secret"),
            patch.object(security_helpers, "prepare_rate_limits"),
            patch.object(media_access, "get_dynamodb_resource"),
            patch.object(original_comparison_access, "_get_s3_client", side_effect=s3_error),
        )

    def test_prepares_every_dependency_of_the_comparison_path(self):
        front, rate, dynamodb, s3 = self.patches()
        with front as prefetch, rate as prepare, dynamodb as resource, s3 as client:
            get_download_url._prepare_first_request()
        for step in (prefetch, prepare, resource, client):
            step.assert_called_once_with()

    def test_client_failures_never_break_initialization(self):
        front, rate, dynamodb, s3 = self.patches(s3_error=ValueError("region"))
        with front, rate, dynamodb as resource, s3, self.assertLogs("photography_api.get_download_url", "WARNING") as logs:
            get_download_url._prepare_first_request()
        resource.assert_called_once_with()
        self.assertEqual(logs.output, ["WARNING:photography_api.get_download_url:client_prepare_failed error_type=ValueError"])

    def test_runs_at_import_only_inside_lambda(self):
        self.addCleanup(importlib.reload, get_download_url)
        for name, expected in (("", 0), ("ian-website-GetDownloadUrlFunction", 1)):
            with patch.dict(os.environ, {"AWS_LAMBDA_FUNCTION_NAME": name}), \
                    patch.object(front_door, "prefetch_front_door_secret") as prefetch, \
                    patch.object(security_helpers, "prepare_rate_limits"), \
                    patch.object(media_access, "get_dynamodb_resource"), \
                    patch.object(original_comparison_access, "_get_s3_client"):
                importlib.reload(get_download_url)
            self.assertEqual(prefetch.call_count, expected)


if __name__ == "__main__":
    unittest.main()
