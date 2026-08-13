import datetime as dt
import importlib
import json
from decimal import Decimal
import unittest
from unittest.mock import MagicMock, patch

from test_support import claims, gateway_event, response_body


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


class AnalyticsIngestTests(unittest.TestCase):
    def setUp(self):
        import analytics

        self.module = importlib.reload(analytics)
        self.module.analytics_table = MagicMock()
        self.module.albums_table = MagicMock()
        self.module.albums_table.get_item.return_value = {
            "Item": {
                "albumId": ALBUM_ID,
                "visibility": "public",
                "status": "active",
                "type": "photo",
                "category": "Hikes",
            }
        }

    def event(self, events, **headers):
        return {
            "headers": {
                "origin": "https://iantruongphotography.com",
                "cloudfront-viewer-country": "US",
                **headers,
            },
            "body": json.dumps({"events": events}),
        }

    @patch("analytics.verify_front_door_request", return_value=None)
    @patch("analytics.check_rate_limit", return_value=True)
    def test_aggregates_allowed_events_without_personal_dimensions(self, _rate, _verify):
        response = self.module.handler(self.event([
            {"name": "site_visit", "source": "search", "device": "mobile"},
            {"name": "page_view"},
            {"name": "album_view", "albumId": ALBUM_ID},
            {"name": "photo_download", "albumId": ALBUM_ID},
            {"name": "web_vital", "metric": "LCP", "value": 1234.5, "rating": "good"},
            {"name": "frontend_error", "kind": "resource"},
        ]), None)

        self.assertEqual(response["statusCode"], 202)
        self.assertEqual(response_body(response), {"accepted": 6})
        keys = [call.kwargs["Key"]["metric"] for call in self.module.analytics_table.update_item.call_args_list]
        self.assertTrue(any(key.endswith("#source#search") for key in keys))
        self.assertTrue(any(key.endswith("#device#mobile") for key in keys))
        self.assertTrue(any(key.endswith("#country#US") for key in keys))
        self.assertTrue(any(key.endswith(f"#album#photo#{ALBUM_ID}") for key in keys))
        self.assertTrue(any(key.endswith("#category#Hikes") for key in keys))
        self.assertTrue(any(key.endswith("#vital#LCP#good") for key in keys))
        self.assertFalse(any("192.0.2" in key for key in keys))
        vital = next(
            call for call in self.module.analytics_table.update_item.call_args_list
            if call.kwargs["Key"]["metric"].endswith("#vital#LCP#good")
        )
        self.assertEqual(vital.kwargs["ExpressionAttributeValues"][":sum"], Decimal("1234.500"))

    @patch("analytics.verify_front_door_request", return_value=None)
    @patch("analytics.check_rate_limit", return_value=True)
    def test_rejects_wrong_origin_and_unknown_fields(self, _rate, _verify):
        wrong_origin = self.event([{"name": "page_view"}])
        wrong_origin["headers"]["origin"] = "https://attacker.example"
        self.assertEqual(self.module.handler(wrong_origin, None)["statusCode"], 400)
        invalid = self.event([{"name": "page_view", "path": "/private"}])
        self.assertEqual(self.module.handler(invalid, None)["statusCode"], 400)
        self.module.analytics_table.update_item.assert_not_called()

    @patch("analytics.verify_front_door_request", return_value=None)
    @patch("analytics.check_rate_limit", return_value=True)
    def test_rejects_private_album_and_invalid_vital(self, _rate, _verify):
        self.module.albums_table.get_item.return_value = {
            "Item": {"albumId": ALBUM_ID, "visibility": "private", "status": "active"}
        }
        response = self.module.handler(self.event([{"name": "album_view", "albumId": ALBUM_ID}]), None)
        self.assertEqual(response["statusCode"], 400)
        response = self.module.handler(self.event([
            {"name": "web_vital", "metric": "LCP", "value": -1, "rating": "good"}
        ]), None)
        self.assertEqual(response["statusCode"], 400)

    @patch("analytics.verify_front_door_request")
    @patch("analytics.check_rate_limit", return_value=True)
    def test_honors_front_door_and_redacts_failures(self, _rate, verify):
        verify.return_value = {"statusCode": 403, "body": "denied"}
        self.assertEqual(self.module.handler({}, None)["statusCode"], 403)
        verify.return_value = None
        self.module.analytics_table.update_item.side_effect = RuntimeError("sensitive")
        response = self.module.handler(self.event([{"name": "page_view"}]), None)
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("sensitive", response["body"])


class AnalyticsReportTests(unittest.TestCase):
    def setUp(self):
        import get_analytics_report

        self.module = importlib.reload(get_analytics_report)
        self.module.analytics_table = MagicMock()
        self.module.dynamodb = MagicMock()
        self.module.dynamodb.batch_get_item.return_value = {
            "Responses": {
                "albums-test": [{
                    "albumId": ALBUM_ID,
                    "title": "Mountain Day",
                    "category": "Hikes",
                    "visibility": "public",
                    "status": "active",
                }]
            }
        }

    def test_aggregate_builds_requested_report_sections(self):
        rows = [
            {"metric": "2026-08-13#event#site_visit", "count": Decimal("4")},
            {"metric": "2026-08-13#event#page_view", "count": Decimal("9")},
            {"metric": "2026-08-13#event#album_view", "count": Decimal("3")},
            {"metric": f"2026-08-13#album#photo#{ALBUM_ID}", "count": Decimal("3")},
            {"metric": "2026-08-13#category#Hikes", "count": Decimal("3")},
            {"metric": "2026-08-13#source#instagram", "count": Decimal("4")},
            {"metric": "2026-08-13#device#mobile", "count": Decimal("4")},
            {"metric": "2026-08-13#country#US", "count": Decimal("4")},
            {"metric": "2026-08-13#event#photo_download", "count": Decimal("2")},
            {"metric": "2026-08-13#event#zip_request", "count": Decimal("1")},
            {"metric": "2026-08-13#vital#LCP#good", "count": Decimal("2"), "sum": Decimal("3000")},
            {"metric": "2026-08-13#error#resource", "count": Decimal("1")},
        ]
        report = self.module._aggregate(rows, dt.date(2026, 8, 7), dt.date(2026, 8, 13))
        self.assertEqual(report["visits"]["today"], 4)
        self.assertEqual(report["totals"]["pageViews"], 9)
        self.assertEqual(report["totals"]["photoDownloads"], 2)
        self.assertEqual(report["albums"]["photo"][0]["title"], "Mountain Day")
        self.assertEqual(report["categories"], [{"category": "Hikes", "views": 3}])
        self.assertEqual(report["sources"], [{"name": "instagram", "count": 4}])
        self.assertEqual(report["webVitals"][0]["average"], 1500.0)
        self.assertEqual(report["totals"]["frontendErrors"], 1)

    @patch("get_analytics_report.emit_audit_event")
    @patch("get_analytics_report.require_admin", return_value=None)
    @patch("get_analytics_report.verify_front_door_request", return_value=None)
    def test_handler_requires_valid_range_and_returns_report(self, _front, _admin, _audit):
        self.module.analytics_table.query.return_value = {"Items": []}
        event = gateway_event(claims(groups=["Admins"]), queryStringParameters={"range": "7"})
        with patch.object(self.module, "_today", return_value=dt.date(2026, 8, 13)):
            response = self.module.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["range"]["days"], 7)
        event["queryStringParameters"] = {"range": "8"}
        self.assertEqual(self.module.handler(event, None)["statusCode"], 400)

    @patch("get_analytics_report.require_admin")
    @patch("get_analytics_report.verify_front_door_request", return_value=None)
    def test_handler_honors_admin_denial(self, _front, admin):
        admin.return_value = {"statusCode": 403, "body": "denied"}
        self.assertEqual(self.module.handler({}, None)["statusCode"], 403)


if __name__ == "__main__":
    unittest.main()
