import datetime as dt
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from test_support import claims, gateway_event, response_body

import get_google_drive_usage


CONTEXT = SimpleNamespace(aws_request_id="drive-usage-request-id")
TODAY = dt.date(2026, 8, 3)
ADMIN_EVENT = gateway_event(claims(groups=["Admins"]))


def report(**updates):
    value = {
        "schemaVersion": 1,
        "generatedAt": "2026-08-02T12:00:00Z",
        "quotaAvailable": True,
        "limitBytes": 1000,
        "usageBytes": 400,
        "driveBytes": 300,
        "trashBytes": 20,
        "otherGoogleBytes": 100,
        "remainingBytes": 600,
        "percentUsed": 40.0,
        "maxUploadBytes": 500,
        "websiteBackup": {
            "totalBytes": 75,
            "fileCount": 3,
            "folderCount": 2,
            "categories": {
                "photos": {"bytes": 50, "fileCount": 2},
                "videos": {"bytes": 25, "fileCount": 1},
                "other": {"bytes": 0, "fileCount": 0},
            },
        },
    }
    value.update(updates)
    return value


def cache_item(value=None, cache_date="2026-08-02"):
    return {
        "cacheKey": get_google_drive_usage.CACHE_KEY,
        "schemaVersion": 1,
        "cacheDate": cache_date,
        "lastAttemptDate": cache_date,
        "payload": json.dumps(value or report()),
    }


class ConditionalFailure(Exception):
    response = {"Error": {"Code": "ConditionalCheckFailedException"}}


class DriveUsageHandlerTests(unittest.TestCase):
    def common(self):
        return (
            patch.object(get_google_drive_usage, "verify_front_door_request", return_value=None),
            patch.object(get_google_drive_usage, "require_admin", return_value=None),
            patch.object(get_google_drive_usage, "_utc_today", return_value=TODAY),
        )

    def test_front_door_and_admin_authorization_stop_before_cache(self):
        denied = {"statusCode": 403, "body": "denied"}
        with patch.object(get_google_drive_usage, "verify_front_door_request", return_value=denied), patch.object(
            get_google_drive_usage.cache_table, "get_item"
        ) as cache:
            self.assertIs(get_google_drive_usage.handler({}, CONTEXT), denied)
            cache.assert_not_called()

        with patch.object(get_google_drive_usage, "verify_front_door_request", return_value=None), patch.object(
            get_google_drive_usage, "require_admin", return_value=denied
        ), patch.object(get_google_drive_usage.cache_table, "get_item") as cache:
            self.assertIs(get_google_drive_usage.handler({}, CONTEXT), denied)
            cache.assert_not_called()

    def test_fresh_daily_cache_avoids_provider_and_emits_safe_audit(self):
        item = cache_item(cache_date=TODAY.isoformat())
        with self.common()[0], self.common()[1], self.common()[2], patch.object(
            get_google_drive_usage.cache_table, "get_item", return_value={"Item": item}
        ), patch.object(get_google_drive_usage.cache_table, "update_item") as claim, patch.object(
            get_google_drive_usage, "_build_report"
        ) as provider, patch.object(get_google_drive_usage, "emit_audit_event") as audit:
            response = get_google_drive_usage.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response["statusCode"], 200)
        body = response_body(response)
        self.assertEqual(body["cacheStatus"], "fresh")
        self.assertEqual(body["nextRefreshAt"], "2026-08-04T00:00:00Z")
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        claim.assert_not_called()
        provider.assert_not_called()
        self.assertEqual(audit.call_args.kwargs["reason_code"], "fresh_report")
        self.assertNotIn("details", audit.call_args.kwargs)

    def test_daily_refresh_builds_and_stores_aggregate_report(self):
        fresh = report(generatedAt="2026-08-03T12:00:00Z")
        with self.common()[0], self.common()[1], self.common()[2], patch.object(
            get_google_drive_usage.cache_table, "get_item", return_value={}
        ), patch.object(get_google_drive_usage.cache_table, "update_item", return_value={}) as claim, patch.object(
            get_google_drive_usage.cache_table, "put_item", return_value={}
        ) as store, patch.object(get_google_drive_usage, "_build_report", return_value=fresh), patch.object(
            get_google_drive_usage, "emit_audit_event"
        ):
            response = get_google_drive_usage.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["cacheStatus"], "fresh")
        claim.assert_called_once()
        stored = store.call_args.kwargs["Item"]
        self.assertEqual(stored["cacheDate"], TODAY.isoformat())
        self.assertNotIn("cacheStatus", json.loads(stored["payload"]))

    def test_provider_failure_serves_stale_cache_without_leaking_error(self):
        stale = cache_item()
        with self.common()[0], self.common()[1], self.common()[2], patch.object(
            get_google_drive_usage.cache_table, "get_item", return_value={"Item": stale}
        ), patch.object(get_google_drive_usage.cache_table, "update_item", return_value={}), patch.object(
            get_google_drive_usage, "_build_report", side_effect=RuntimeError("provider secret")
        ), patch.object(get_google_drive_usage, "emit_audit_event") as audit, self.assertLogs(
            "photography_api.google_drive_usage", level="ERROR"
        ) as logs:
            response = get_google_drive_usage.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["cacheStatus"], "stale")
        self.assertNotIn("provider secret", " ".join(logs.output))
        self.assertEqual(audit.call_args.kwargs["severity"], "warning")

    def test_first_provider_failure_and_cache_failure_are_safe(self):
        with self.common()[0], self.common()[1], self.common()[2], patch.object(
            get_google_drive_usage.cache_table, "get_item", return_value={}
        ), patch.object(get_google_drive_usage.cache_table, "update_item", return_value={}), patch.object(
            get_google_drive_usage, "_build_report", side_effect=RuntimeError("provider secret")
        ), self.assertLogs("photography_api.google_drive_usage", level="ERROR"):
            response = get_google_drive_usage.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(response_body(response)["code"], "drive_usage_unavailable")
        self.assertNotIn("provider secret", response["body"])

        with self.common()[0], self.common()[1], self.common()[2], patch.object(
            get_google_drive_usage.cache_table, "get_item", side_effect=RuntimeError("table secret")
        ), patch.object(get_google_drive_usage, "_build_report") as provider, self.assertLogs(
            "photography_api.google_drive_usage", level="ERROR"
        ) as logs:
            response = get_google_drive_usage.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response["statusCode"], 503)
        provider.assert_not_called()
        self.assertNotIn("table secret", response["body"] + " ".join(logs.output))

    def test_another_invocation_claimed_refresh_serves_cache_or_preparing(self):
        stale = cache_item()
        for responses, expected_status, expected_code in (
            ([{"Item": stale}, {"Item": stale}], 200, None),
            ([{}, {}], 503, "drive_usage_preparing"),
        ):
            with self.subTest(status=expected_status), self.common()[0], self.common()[1], self.common()[2], patch.object(
                get_google_drive_usage.cache_table, "get_item", side_effect=responses
            ), patch.object(
                get_google_drive_usage.cache_table, "update_item", side_effect=ConditionalFailure()
            ), patch.object(get_google_drive_usage, "emit_audit_event"):
                response = get_google_drive_usage.handler(ADMIN_EVENT, CONTEXT)
            self.assertEqual(response["statusCode"], expected_status)
            if expected_code:
                self.assertEqual(response_body(response)["code"], expected_code)


class DriveUsageProviderTests(unittest.TestCase):
    def setUp(self):
        get_google_drive_usage._credential_payload_cache = None
        get_google_drive_usage._credentials_cache = None

    def tearDown(self):
        get_google_drive_usage._credential_payload_cache = None
        get_google_drive_usage._credentials_cache = None

    def test_build_report_aggregates_quota_and_recursive_backup(self):
        pages = [
            {
                "files": [
                    {"id": "photos", "name": "Photos", "mimeType": get_google_drive_usage.FOLDER_MIME_TYPE},
                    {"id": "videos", "name": "Videos", "mimeType": get_google_drive_usage.FOLDER_MIME_TYPE},
                    {"id": "readme", "name": "note.txt", "mimeType": "text/plain", "size": "3"},
                ]
            },
            {"files": [{"id": "video-file", "name": "v.mp4", "mimeType": "video/mp4", "quotaBytesUsed": "40"}]},
            {
                "files": [{"id": "photo-one", "name": "a.jpg", "mimeType": "image/jpeg", "size": "10"}],
                "nextPageToken": "next-page",
            },
            {"files": [{"id": "photo-two", "name": "b.jpg", "mimeType": "image/jpeg", "quotaBytesUsed": "20"}]},
        ]

        def provider(resource, parameters):
            if resource == "about":
                self.assertEqual(
                    parameters["fields"],
                    "storageQuota(limit,usage,usageInDrive,usageInDriveTrash),maxUploadSize",
                )
                return {
                    "storageQuota": {"limit": "1000", "usage": "400", "usageInDrive": "300", "usageInDriveTrash": "20"},
                    "maxUploadSize": "500",
                }
            return pages.pop(0)

        with patch.object(get_google_drive_usage, "_authorized_json", side_effect=provider), patch.dict(
            get_google_drive_usage.os.environ, {"GOOGLE_DRIVE_FOLDER_ID": "root"}
        ):
            value = get_google_drive_usage._build_report(TODAY)
        self.assertFalse(pages)
        self.assertEqual(value["remainingBytes"], 600)
        self.assertEqual(value["percentUsed"], 40.0)
        self.assertEqual(value["otherGoogleBytes"], 100)
        self.assertEqual(value["websiteBackup"]["totalBytes"], 73)
        self.assertEqual(value["websiteBackup"]["fileCount"], 4)
        self.assertEqual(value["websiteBackup"]["folderCount"], 2)
        self.assertEqual(value["websiteBackup"]["categories"]["photos"], {"bytes": 30, "fileCount": 2})
        self.assertEqual(value["websiteBackup"]["categories"]["videos"], {"bytes": 40, "fileCount": 1})

    def test_missing_quota_is_supported_for_service_accounts(self):
        with patch.object(get_google_drive_usage, "_authorized_json", side_effect=[{"storageQuota": {}}, {"files": []}]), patch.dict(
            get_google_drive_usage.os.environ, {"GOOGLE_DRIVE_FOLDER_ID": "root"}
        ):
            value = get_google_drive_usage._build_report(TODAY)
        self.assertFalse(value["quotaAvailable"])
        self.assertIsNone(value["limitBytes"])
        self.assertIsNone(value["percentUsed"])
        self.assertEqual(value["websiteBackup"]["totalBytes"], 0)

    def test_credentials_support_nested_oauth_service_account_and_binary_secret(self):
        credential = Mock(valid=False, token="token")
        with patch.object(
            get_google_drive_usage.secrets_client, "get_secret_value",
            return_value={"SecretBinary": json.dumps({"oauth": {"refresh_token": "x"}}).encode()},
        ) as secret, patch.object(
            get_google_drive_usage.Credentials, "from_authorized_user_info", return_value=credential
        ) as oauth:
            self.assertIs(get_google_drive_usage._credentials(), credential)
            credential.refresh.assert_called_once()
            oauth.assert_called_once_with({"refresh_token": "x"}, scopes=get_google_drive_usage.DRIVE_SCOPE)
            secret.assert_called_once()

        get_google_drive_usage._credential_payload_cache = None
        get_google_drive_usage._credentials_cache = None
        service_credentials = Mock(valid=True, token="service-token")
        payload = {"service_account": {"type": "service_account", "client_email": "test@example.test"}}
        with patch.object(
            get_google_drive_usage.secrets_client, "get_secret_value", return_value={"SecretString": json.dumps(payload)}
        ), patch.object(
            get_google_drive_usage.service_account.Credentials, "from_service_account_info", return_value=service_credentials
        ) as service:
            self.assertIs(get_google_drive_usage._credentials(), service_credentials)
            service.assert_called_once_with(payload["service_account"], scopes=get_google_drive_usage.DRIVE_SCOPE)

    def test_credential_contract_rejects_missing_invalid_and_unsupported_secrets(self):
        cases = [
            ({}, {"GOOGLE_OAUTH_SECRET_ARN": ""}),
            ({"SecretString": "not-json"}, None),
            ({"SecretString": "[]"}, None),
            ({"SecretString": "{}"}, None),
        ]
        for response, environment in cases:
            with self.subTest(response=response), patch.object(
                get_google_drive_usage.secrets_client, "get_secret_value", return_value=response
            ), patch.dict(get_google_drive_usage.os.environ, environment or {}, clear=False), self.assertRaises(
                get_google_drive_usage.ProviderContractError
            ):
                get_google_drive_usage._credential_payload_cache = None
                get_google_drive_usage._credentials_cache = None
                get_google_drive_usage._credentials()

    def test_authorized_json_limits_resources_response_size_and_json(self):
        credentials = Mock(token="access-token")
        good_response = Mock()
        good_response.__enter__ = Mock(return_value=good_response)
        good_response.__exit__ = Mock(return_value=False)
        good_response.status = 200
        good_response.read.return_value = b'{"storageQuota":{}}'
        with patch.object(get_google_drive_usage, "_credentials", return_value=credentials), patch.object(
            get_google_drive_usage._provider_opener, "open", return_value=good_response
        ) as opener:
            self.assertEqual(get_google_drive_usage._authorized_json("about", {"fields": "storageQuota"}), {"storageQuota": {}})
        request = opener.call_args.args[0]
        self.assertTrue(request.full_url.startswith("https://www.googleapis.com/drive/v3/about?"))
        self.assertEqual(request.get_header("Authorization"), "Bearer access-token")
        self.assertEqual(opener.call_args.kwargs["timeout"], 10)

        with self.assertRaises(get_google_drive_usage.ProviderContractError):
            get_google_drive_usage._authorized_json("permissions", {})
        for payload in (b"", b"not-json", b"x" * (get_google_drive_usage.MAX_PROVIDER_RESPONSE_BYTES + 1)):
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            response.status = 200
            response.read.return_value = payload
            with self.subTest(size=len(payload)), patch.object(get_google_drive_usage, "_credentials", return_value=credentials), patch.object(
                get_google_drive_usage._provider_opener, "open", return_value=response
            ), self.assertRaises(get_google_drive_usage.ProviderContractError):
                get_google_drive_usage._authorized_json("about", {})
        self.assertIsNone(get_google_drive_usage._NoRedirectHandler().redirect_request(None, None, 302, "", {}, "https://example.test"))

    def test_provider_contract_rejects_bad_values_ids_pagination_and_repetition(self):
        for value in (True, -1, get_google_drive_usage.MAX_BYTE_VALUE + 1, "bad"):
            with self.subTest(value=value), self.assertRaises(get_google_drive_usage.ProviderContractError):
                get_google_drive_usage._optional_bytes(value)
        self.assertEqual(get_google_drive_usage._optional_bytes(None), None)
        self.assertEqual(get_google_drive_usage._category_for_root_folder("PHOTOS"), "photos")
        self.assertEqual(get_google_drive_usage._category_for_root_folder("Videos"), "videos")

        invalid_pages = [
            {},
            {"files": "bad"},
            {"files": ["bad"]},
            {"files": [{"id": "bad id", "mimeType": "image/jpeg"}]},
            {"files": [{"id": "ok", "mimeType": ""}]},
            {"files": [], "nextPageToken": 12},
        ]
        for page in invalid_pages:
            with self.subTest(page=page), patch.object(get_google_drive_usage, "_authorized_json", return_value=page), self.assertRaises(
                get_google_drive_usage.ProviderContractError
            ):
                get_google_drive_usage._scan_website_backup("root")
        with patch.object(
            get_google_drive_usage, "_authorized_json",
            side_effect=[{"files": [], "nextPageToken": "same"}, {"files": [], "nextPageToken": "same"}],
        ), self.assertRaises(get_google_drive_usage.ProviderContractError):
            get_google_drive_usage._scan_website_backup("root")
        with self.assertRaises(get_google_drive_usage.ProviderContractError):
            get_google_drive_usage._scan_website_backup("bad id")


class DriveUsageCacheContractTests(unittest.TestCase):
    def test_cache_contract_rejects_missing_oversized_and_malformed_payloads(self):
        candidates = [
            {},
            {"Item": {"payload": ""}},
            {"Item": {"payload": "x" * (get_google_drive_usage.MAX_CACHE_PAYLOAD_BYTES + 1)}},
            {"Item": {"payload": "{"}},
            {"Item": {"payload": json.dumps(report(schemaVersion=2))}},
            {"Item": {"payload": json.dumps(report(websiteBackup={}))}},
        ]
        for response in candidates:
            with self.subTest(response=list(response)), patch.object(
                get_google_drive_usage.cache_table, "get_item", return_value=response
            ):
                value, _item = get_google_drive_usage._cached_item()
            self.assertIsNone(value)

    def test_cache_write_size_and_daily_claim_are_bounded(self):
        with patch.object(get_google_drive_usage.cache_table, "put_item") as put:
            get_google_drive_usage._store_report(TODAY, report())
        put.assert_called_once()
        with patch.object(get_google_drive_usage, "MAX_CACHE_PAYLOAD_BYTES", 10), self.assertRaises(ValueError), patch.object(
            get_google_drive_usage.cache_table, "put_item"
        ) as put:
            get_google_drive_usage._store_report(TODAY, report())
        put.assert_not_called()

        with patch.object(get_google_drive_usage.cache_table, "update_item", side_effect=ConditionalFailure()):
            self.assertFalse(get_google_drive_usage._claim_daily_refresh(TODAY))
        with patch.object(get_google_drive_usage.cache_table, "update_item", side_effect=RuntimeError("provider")), self.assertRaises(RuntimeError):
            get_google_drive_usage._claim_daily_refresh(TODAY)


if __name__ == "__main__":
    unittest.main()
