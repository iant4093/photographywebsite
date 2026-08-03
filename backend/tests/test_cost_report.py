import datetime as dt
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from test_support import claims, gateway_event, response_body

import get_cost_report


CONTEXT = SimpleNamespace(aws_request_id="cost-request-id")
TODAY = dt.date(2026, 8, 3)
ADMIN_EVENT = gateway_event(claims(groups=["Admins"]))


def months():
    return [
        {
            "month": value.strftime("%Y-%m"),
            "total": 0,
            "estimated": value == dt.date(2026, 8, 1),
            "services": [],
        }
        for value in get_cost_report._month_keys(TODAY)
    ]


def cached_report(**updates):
    report = {
        "schemaVersion": 1,
        "generatedAt": "2026-08-02T12:00:00Z",
        "dataThrough": "2026-08-01",
        "currency": "USD",
        "metric": "UnblendedCost",
        "currentMonth": "2026-08",
        "forecastTotal": 4.5,
        "months": months(),
    }
    report.update(updates)
    return report


def cache_item(report=None, cache_date="2026-08-02"):
    return {
        "cacheKey": get_cost_report.CACHE_KEY,
        "schemaVersion": 1,
        "cacheDate": cache_date,
        "lastAttemptDate": cache_date,
        "payload": json.dumps(report or cached_report()),
    }


def cost_page(*, token=None, estimated=True, services=None):
    service_values = services or [("Amazon S3", "2.75"), ("AWS Lambda", "1.25")]
    result = {
        "ResultsByTime": [{
            "TimePeriod": {"Start": "2026-08-01", "End": "2026-08-03"},
            "Estimated": estimated,
            "Groups": [
                {
                    "Keys": [name],
                    "Metrics": {"UnblendedCost": {"Amount": amount, "Unit": "USD"}},
                }
                for name, amount in service_values
            ],
        }],
    }
    if token:
        result["NextPageToken"] = token
    return result


class ConditionalFailure(Exception):
    response = {"Error": {"Code": "ConditionalCheckFailedException"}}


class CostReportHandlerTests(unittest.TestCase):
    def common(self):
        return (
            patch.object(get_cost_report, "verify_front_door_request", return_value=None),
            patch.object(get_cost_report, "require_admin", return_value=None),
            patch.object(get_cost_report, "_utc_today", return_value=TODAY),
        )

    def test_front_door_and_admin_authorization_stop_before_cache_access(self):
        denied = {"statusCode": 403, "body": "denied"}
        with patch.object(get_cost_report, "verify_front_door_request", return_value=denied), patch.object(
            get_cost_report.cache_table, "get_item"
        ) as cache:
            self.assertIs(get_cost_report.handler({}, CONTEXT), denied)
            cache.assert_not_called()

        with patch.object(get_cost_report, "verify_front_door_request", return_value=None), patch.object(
            get_cost_report, "require_admin", return_value=denied
        ), patch.object(get_cost_report.cache_table, "get_item") as cache:
            self.assertIs(get_cost_report.handler({}, CONTEXT), denied)
            cache.assert_not_called()

    def test_fresh_daily_cache_avoids_cost_explorer_and_emits_safe_audit(self):
        item = cache_item(cache_date=TODAY.isoformat())
        with self.common()[0], self.common()[1], self.common()[2], patch.object(
            get_cost_report.cache_table, "get_item", return_value={"Item": item}
        ), patch.object(get_cost_report.cache_table, "update_item") as claim, patch.object(
            get_cost_report.cost_explorer, "get_cost_and_usage"
        ) as provider, patch.object(get_cost_report, "emit_audit_event") as audit:
            response = get_cost_report.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response["statusCode"], 200)
        body = response_body(response)
        self.assertEqual(body["cacheStatus"], "fresh")
        self.assertEqual(body["nextRefreshAt"], "2026-08-04T00:00:00Z")
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        claim.assert_not_called()
        provider.assert_not_called()
        self.assertEqual(audit.call_args.kwargs["reason_code"], "fresh_report")
        self.assertNotIn("details", audit.call_args.kwargs)

    def test_daily_refresh_paginates_aggregates_forecasts_and_caches(self):
        page_one = cost_page(token="next", services=[(f"Service {index}", str(index)) for index in range(1, 7)])
        page_two = cost_page(services=[(f"Service {index}", str(index)) for index in range(7, 11)])
        with self.common()[0], self.common()[1], self.common()[2], patch.object(
            get_cost_report.cache_table, "get_item", return_value={}
        ), patch.object(get_cost_report.cache_table, "update_item", return_value={}) as claim, patch.object(
            get_cost_report.cache_table, "put_item", return_value={}
        ) as store, patch.object(
            get_cost_report.cost_explorer, "get_cost_and_usage", side_effect=[page_one, page_two]
        ) as usage, patch.object(
            get_cost_report.cost_explorer,
            "get_cost_forecast",
            return_value={"Total": {"Amount": "6.50", "Unit": "USD"}},
        ) as forecast, patch.object(get_cost_report, "emit_audit_event"):
            response = get_cost_report.handler(ADMIN_EVENT, CONTEXT)

        self.assertEqual(response["statusCode"], 200)
        body = response_body(response)
        self.assertEqual(body["cacheStatus"], "fresh")
        self.assertEqual(body["dataThrough"], "2026-08-02")
        self.assertEqual(len(body["months"]), 13)
        current = body["months"][-1]
        self.assertEqual(current["total"], 55.0)
        self.assertEqual(len(current["services"]), 9)
        self.assertEqual(current["services"][0]["name"], "Service 10")
        self.assertEqual(current["services"][-1], {"name": "Other", "amount": 3.0, "share": 5.45})
        self.assertEqual(body["forecastTotal"], 61.5)
        self.assertEqual(usage.call_count, 2)
        self.assertNotIn("NextPageToken", usage.call_args_list[0].kwargs)
        self.assertEqual(usage.call_args_list[1].kwargs["NextPageToken"], "next")
        self.assertEqual(usage.call_args_list[0].kwargs["GroupBy"][0]["Key"], "SERVICE")
        forecast.assert_called_once_with(
            TimePeriod={"Start": "2026-08-03", "End": "2026-09-01"},
            Metric="UNBLENDED_COST",
            Granularity="MONTHLY",
            PredictionIntervalLevel=80,
        )
        claim.assert_called_once()
        stored = store.call_args.kwargs["Item"]
        self.assertEqual(stored["cacheDate"], TODAY.isoformat())
        self.assertNotIn("cacheStatus", json.loads(stored["payload"]))

    def test_unavailable_forecast_does_not_hide_actual_costs(self):
        with patch.object(get_cost_report.cost_explorer, "get_cost_and_usage", return_value=cost_page()), patch.object(
            get_cost_report.cost_explorer, "get_cost_forecast", side_effect=RuntimeError("private")
        ):
            report = get_cost_report._build_report(TODAY)
        self.assertEqual(report["months"][-1]["total"], 4.0)
        self.assertIsNone(report["forecastTotal"])

    def test_provider_failure_serves_stale_cache_without_leaking_error(self):
        stale = cache_item()
        with self.common()[0], self.common()[1], self.common()[2], patch.object(
            get_cost_report.cache_table, "get_item", return_value={"Item": stale}
        ), patch.object(get_cost_report.cache_table, "update_item", return_value={}), patch.object(
            get_cost_report.cost_explorer, "get_cost_and_usage", side_effect=RuntimeError("provider secret")
        ), patch.object(get_cost_report, "emit_audit_event") as audit, self.assertLogs(
            "photography_api.cost_report", level="ERROR"
        ) as logs:
            response = get_cost_report.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response_body(response)["cacheStatus"], "stale")
        self.assertNotIn("provider secret", " ".join(logs.output))
        self.assertEqual(audit.call_args.kwargs["reason_code"], "stale_report")
        self.assertEqual(audit.call_args.kwargs["severity"], "warning")

    def test_first_report_provider_failure_is_a_safe_503(self):
        with self.common()[0], self.common()[1], self.common()[2], patch.object(
            get_cost_report.cache_table, "get_item", return_value={}
        ), patch.object(get_cost_report.cache_table, "update_item", return_value={}), patch.object(
            get_cost_report.cost_explorer, "get_cost_and_usage", side_effect=RuntimeError("provider secret")
        ), self.assertLogs("photography_api.cost_report", level="ERROR"):
            response = get_cost_report.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(response_body(response)["code"], "cost_report_unavailable")
        self.assertNotIn("provider secret", response["body"])

    def test_another_invocation_claimed_refresh_serves_cache_or_preparing(self):
        stale = cache_item()
        for responses, expected_status, expected_code in (
            ([{"Item": stale}, {"Item": stale}], 200, None),
            ([{}, {}], 503, "cost_report_preparing"),
        ):
            with self.subTest(expected=expected_status), self.common()[0], self.common()[1], self.common()[2], patch.object(
                get_cost_report.cache_table, "get_item", side_effect=responses
            ), patch.object(
                get_cost_report.cache_table, "update_item", side_effect=ConditionalFailure()
            ), patch.object(get_cost_report, "emit_audit_event"):
                response = get_cost_report.handler(ADMIN_EVENT, CONTEXT)
            self.assertEqual(response["statusCode"], expected_status)
            if expected_code:
                self.assertEqual(response_body(response)["code"], expected_code)

    def test_cache_provider_failure_is_safe_and_does_not_call_cost_explorer(self):
        with self.common()[0], self.common()[1], self.common()[2], patch.object(
            get_cost_report.cache_table, "get_item", side_effect=RuntimeError("table secret")
        ), patch.object(get_cost_report.cost_explorer, "get_cost_and_usage") as provider, self.assertLogs(
            "photography_api.cost_report", level="ERROR"
        ) as logs:
            response = get_cost_report.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response["statusCode"], 503)
        provider.assert_not_called()
        self.assertNotIn("table secret", response["body"] + " ".join(logs.output))


class CostReportContractTests(unittest.TestCase):
    def test_date_and_amount_helpers_are_bounded(self):
        keys = get_cost_report._month_keys(TODAY)
        self.assertEqual(keys[0], dt.date(2025, 8, 1))
        self.assertEqual(keys[-1], dt.date(2026, 8, 1))
        self.assertEqual(get_cost_report._shift_month(dt.date(2026, 1, 1), -1), dt.date(2025, 12, 1))
        self.assertEqual(get_cost_report._json_amount(get_cost_report._amount("1.23456")), 1.2346)
        for value in ("not-a-number", "NaN", "Infinity", "1000000000001"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                get_cost_report._amount(value)

    def test_cache_contract_rejects_missing_oversized_and_malformed_payloads(self):
        candidates = [
            {},
            {"Item": {"payload": ""}},
            {"Item": {"payload": "x" * (get_cost_report.MAX_CACHE_PAYLOAD_BYTES + 1)}},
            {"Item": {"payload": "{"}},
            {"Item": {"payload": json.dumps({"schemaVersion": 2, "months": months()})}},
            {"Item": {"payload": json.dumps({"schemaVersion": 1, "months": []})}},
        ]
        for response in candidates:
            with self.subTest(response=list(response)), patch.object(
                get_cost_report.cache_table, "get_item", return_value=response
            ):
                report, _item = get_cost_report._cached_item()
            self.assertIsNone(report)

    def test_cache_write_size_is_bounded(self):
        with patch.object(get_cost_report.cache_table, "put_item") as put:
            get_cost_report._store_report(TODAY, cached_report())
        put.assert_called_once()
        with patch.object(
            get_cost_report, "MAX_CACHE_PAYLOAD_BYTES", 10
        ), self.assertRaises(ValueError), patch.object(get_cost_report.cache_table, "put_item") as put:
            get_cost_report._store_report(TODAY, cached_report())
        put.assert_not_called()

    def test_cost_contract_rejects_bad_pagination_period_group_currency_and_amount(self):
        invalid_pages = [
            {},
            {"ResultsByTime": ["bad"]},
            {"ResultsByTime": [{"TimePeriod": {"Start": "bad"}, "Groups": []}]},
            {"ResultsByTime": [{"TimePeriod": {"Start": "2024-01-01"}, "Groups": []}]},
            {"ResultsByTime": [{"TimePeriod": {"Start": "2026-08-01"}, "Groups": "bad"}]},
            {"ResultsByTime": [{"TimePeriod": {"Start": "2026-08-01"}, "Groups": [{}]}]},
            cost_page(services=[("", "1")]),
            {"ResultsByTime": [{
                "TimePeriod": {"Start": "2026-08-01"},
                "Groups": [{"Keys": ["S3"], "Metrics": {"UnblendedCost": {"Amount": "1", "Unit": ""}}}],
            }]},
            cost_page(services=[("S3", "NaN")]),
        ]
        for page in invalid_pages:
            with self.subTest(page=page), patch.object(
                get_cost_report.cost_explorer, "get_cost_and_usage", return_value=page
            ), self.assertRaises(ValueError):
                get_cost_report._cost_and_usage(TODAY)

        repeated = cost_page(token="repeat")
        with patch.object(get_cost_report.cost_explorer, "get_cost_and_usage", return_value=repeated), self.assertRaises(ValueError):
            get_cost_report._cost_and_usage(TODAY)

    def test_mixed_currency_is_rejected_and_forecast_currency_is_optional(self):
        page = cost_page(services=[("S3", "1"), ("Lambda", "2")])
        page["ResultsByTime"][0]["Groups"][1]["Metrics"]["UnblendedCost"]["Unit"] = "EUR"
        with patch.object(get_cost_report.cost_explorer, "get_cost_and_usage", return_value=page), self.assertRaises(ValueError):
            get_cost_report._cost_and_usage(TODAY)
        with patch.object(
            get_cost_report.cost_explorer, "get_cost_forecast", return_value={"Total": {"Amount": "1", "Unit": "EUR"}}
        ):
            self.assertIsNone(get_cost_report._forecast(TODAY, 2))

    def test_daily_claim_only_swallows_conditional_conflicts(self):
        with patch.object(get_cost_report.cache_table, "update_item", side_effect=ConditionalFailure()):
            self.assertFalse(get_cost_report._claim_daily_refresh(TODAY))
        with patch.object(get_cost_report.cache_table, "update_item", side_effect=RuntimeError("provider")), self.assertRaises(RuntimeError):
            get_cost_report._claim_daily_refresh(TODAY)


if __name__ == "__main__":
    unittest.main()
