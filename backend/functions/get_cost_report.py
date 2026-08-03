"""Admin-only, once-daily aggregate AWS Cost Explorer report."""

from __future__ import annotations

import copy
import datetime as dt
from decimal import Decimal, InvalidOperation
import json
import logging
import os

import boto3

from audit_helpers import actor_context, emit_audit_event
from auth_helpers import require_admin
from front_door import verify_front_door_request
from response_helpers import error_response, json_response


logger = logging.getLogger("photography_api.cost_report")
logger.setLevel(logging.INFO)

CACHE_KEY = "account-cost-report-v1"
CACHE_SCHEMA_VERSION = 1
MONTH_COUNT = 13
MAX_COST_EXPLORER_PAGES = 10
MAX_CACHE_PAYLOAD_BYTES = 300_000
TOP_SERVICE_COUNT = 8

cost_explorer = boto3.client("ce", region_name="us-east-1")
cache_table = boto3.resource("dynamodb").Table(os.environ["COST_REPORT_CACHE_TABLE"])


def _utc_today():
    return dt.datetime.now(dt.timezone.utc).date()


def _month_start(value):
    return value.replace(day=1)


def _shift_month(value, offset):
    month_index = value.year * 12 + value.month - 1 + offset
    return dt.date(month_index // 12, month_index % 12 + 1, 1)


def _month_keys(today):
    current = _month_start(today)
    return [_shift_month(current, offset) for offset in range(-(MONTH_COUNT - 1), 1)]


def _amount(value):
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError("invalid Cost Explorer amount") from None
    if not result.is_finite() or abs(result) > Decimal("1000000000000"):
        raise ValueError("invalid Cost Explorer amount")
    return result


def _json_amount(value):
    return float(value.quantize(Decimal("0.0001")))


def _service_summary(service_amounts, total):
    ordered = sorted(service_amounts.items(), key=lambda item: (-item[1], item[0].lower()))
    selected = ordered[:TOP_SERVICE_COUNT]
    remainder = ordered[TOP_SERVICE_COUNT:]
    if remainder:
        selected.append(("Other", sum((amount for _, amount in remainder), Decimal("0"))))

    denominator = total if total > 0 else Decimal("0")
    return [
        {
            "name": name,
            "amount": _json_amount(amount),
            "share": round(float(max(amount, Decimal("0")) / denominator * 100), 2)
            if denominator
            else 0,
        }
        for name, amount in selected
    ]


def _cost_and_usage(today):
    keys = _month_keys(today)
    allowed_months = {value.isoformat(): value for value in keys}
    aggregates = {
        value.isoformat(): {"services": {}, "estimated": value == keys[-1]}
        for value in keys
    }
    start = keys[0].isoformat()
    end = today.isoformat()
    seen_tokens = set()
    next_token = None
    currency = None

    for _page_number in range(MAX_COST_EXPLORER_PAGES):
        request = {
            "TimePeriod": {"Start": start, "End": end},
            "Granularity": "MONTHLY",
            "Metrics": ["UnblendedCost"],
            "GroupBy": [{"Type": "DIMENSION", "Key": "SERVICE"}],
        }
        if next_token:
            request["NextPageToken"] = next_token
        response = cost_explorer.get_cost_and_usage(**request)
        results = response.get("ResultsByTime")
        if not isinstance(results, list):
            raise ValueError("invalid Cost Explorer result contract")

        for result in results:
            if not isinstance(result, dict):
                raise ValueError("invalid Cost Explorer result contract")
            period = result.get("TimePeriod") or {}
            period_start = str(period.get("Start", ""))
            try:
                parsed_start = dt.date.fromisoformat(period_start).replace(day=1).isoformat()
            except ValueError:
                raise ValueError("invalid Cost Explorer period") from None
            if parsed_start not in allowed_months:
                raise ValueError("Cost Explorer period outside requested range")
            month = aggregates[parsed_start]
            month["estimated"] = bool(month["estimated"] or result.get("Estimated"))
            groups = result.get("Groups") or []
            if not isinstance(groups, list):
                raise ValueError("invalid Cost Explorer group contract")
            for group in groups:
                group_keys = group.get("Keys") if isinstance(group, dict) else None
                metrics = group.get("Metrics") if isinstance(group, dict) else None
                metric = metrics.get("UnblendedCost") if isinstance(metrics, dict) else None
                if not isinstance(group_keys, list) or len(group_keys) != 1 or not isinstance(metric, dict):
                    raise ValueError("invalid Cost Explorer group contract")
                service = str(group_keys[0]).strip()
                if not service or len(service) > 200:
                    raise ValueError("invalid Cost Explorer service name")
                unit = str(metric.get("Unit", "")).strip()
                if not unit or len(unit) > 12:
                    raise ValueError("invalid Cost Explorer currency")
                if currency is None:
                    currency = unit
                elif currency != unit:
                    raise ValueError("mixed Cost Explorer currencies")
                service_amount = _amount(metric.get("Amount"))
                month["services"][service] = month["services"].get(service, Decimal("0")) + service_amount

        next_token = response.get("NextPageToken")
        if not next_token:
            break
        if not isinstance(next_token, str) or len(next_token) > 8192 or next_token in seen_tokens:
            raise ValueError("invalid Cost Explorer pagination")
        seen_tokens.add(next_token)
    else:
        raise ValueError("Cost Explorer pagination exceeded safe limit")

    months = []
    for key in keys:
        month = aggregates[key.isoformat()]
        total = sum(month["services"].values(), Decimal("0"))
        months.append(
            {
                "month": key.strftime("%Y-%m"),
                "total": _json_amount(total),
                "estimated": bool(month["estimated"]),
                "services": _service_summary(month["services"], total),
            }
        )
    return months, currency or "USD"


def _forecast(today, current_total):
    next_month = _shift_month(_month_start(today), 1)
    try:
        response = cost_explorer.get_cost_forecast(
            TimePeriod={"Start": today.isoformat(), "End": next_month.isoformat()},
            Metric="UNBLENDED_COST",
            Granularity="MONTHLY",
            PredictionIntervalLevel=80,
        )
        metric = response.get("Total") or {}
        if str(metric.get("Unit", "USD")) != "USD":
            return None
        remaining = _amount(metric.get("Amount"))
        return _json_amount(_amount(current_total) + remaining)
    except Exception:
        # Forecasting can be unavailable for accounts without enough history.
        # Actual monthly/service costs remain useful and must still be returned.
        return None


def _build_report(today):
    months, currency = _cost_and_usage(today)
    current_total = months[-1]["total"]
    return {
        "schemaVersion": CACHE_SCHEMA_VERSION,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "dataThrough": (today - dt.timedelta(days=1)).isoformat(),
        "currency": currency,
        "metric": "UnblendedCost",
        "currentMonth": months[-1]["month"],
        "forecastTotal": _forecast(today, current_total),
        "months": months,
    }


def _cached_item():
    response = cache_table.get_item(Key={"cacheKey": CACHE_KEY}, ConsistentRead=True)
    item = response.get("Item")
    if not isinstance(item, dict):
        return None, None
    payload = item.get("payload")
    if not isinstance(payload, str) or not 1 <= len(payload.encode("utf-8")) <= MAX_CACHE_PAYLOAD_BYTES:
        return None, item
    try:
        report = json.loads(payload)
    except (TypeError, ValueError):
        return None, item
    if (
        not isinstance(report, dict)
        or report.get("schemaVersion") != CACHE_SCHEMA_VERSION
        or not isinstance(report.get("months"), list)
        or len(report["months"]) != MONTH_COUNT
    ):
        return None, item
    return report, item


def _claim_daily_refresh(today):
    try:
        cache_table.update_item(
            Key={"cacheKey": CACHE_KEY},
            UpdateExpression="SET lastAttemptDate = :today",
            ConditionExpression="attribute_not_exists(lastAttemptDate) OR lastAttemptDate <> :today",
            ExpressionAttributeValues={":today": today.isoformat()},
        )
        return True
    except Exception as error:
        code = str(getattr(error, "response", {}).get("Error", {}).get("Code", ""))
        if code == "ConditionalCheckFailedException":
            return False
        raise


def _store_report(today, report):
    payload = json.dumps(report, separators=(",", ":"), sort_keys=True)
    if len(payload.encode("utf-8")) > MAX_CACHE_PAYLOAD_BYTES:
        raise ValueError("cost report cache payload exceeded safe limit")
    cache_table.put_item(
        Item={
            "cacheKey": CACHE_KEY,
            "schemaVersion": CACHE_SCHEMA_VERSION,
            "cacheDate": today.isoformat(),
            "lastAttemptDate": today.isoformat(),
            "payload": payload,
        }
    )


def _with_cache_status(report, status, today):
    result = copy.deepcopy(report)
    result["cacheStatus"] = status
    result["nextRefreshAt"] = dt.datetime.combine(
        today + dt.timedelta(days=1), dt.time.min, tzinfo=dt.timezone.utc
    ).isoformat().replace("+00:00", "Z")
    return result


def _audit_view(event, context, status):
    actor_type, auth_method = actor_context(event)
    emit_audit_event(
        event_name="billing.cost_report",
        outcome="success",
        action="billing.cost_report.view",
        resource_type="provider",
        reason_code=f"{status}_report",
        event=event,
        context=context,
        actor_type=actor_type,
        auth_method=auth_method,
        severity="warning" if status == "stale" else "info",
    )


def handler(event, context):
    front_door_denied = verify_front_door_request(event, context)
    if front_door_denied:
        return front_door_denied
    denied = require_admin(event)
    if denied:
        return denied

    today = _utc_today()
    try:
        cached, item = _cached_item()
        if cached is not None and item.get("cacheDate") == today.isoformat():
            _audit_view(event, context, "fresh")
            return json_response(200, _with_cache_status(cached, "fresh", today))

        if not _claim_daily_refresh(today):
            cached, item = _cached_item()
            if cached is not None:
                status = "fresh" if item.get("cacheDate") == today.isoformat() else "stale"
                _audit_view(event, context, status)
                return json_response(200, _with_cache_status(cached, status, today))
            return error_response(
                503,
                "The daily cost report is being prepared. Please try again shortly.",
                code="cost_report_preparing",
            )

        try:
            report = _build_report(today)
            _store_report(today, report)
            _audit_view(event, context, "fresh")
            return json_response(200, _with_cache_status(report, "fresh", today))
        except Exception as error:
            request_id = getattr(context, "aws_request_id", "unknown") if context else "unknown"
            logger.error(
                "cost_report_refresh_failed request_id=%s error_type=%s",
                request_id,
                type(error).__name__,
            )
            if cached is not None:
                _audit_view(event, context, "stale")
                return json_response(200, _with_cache_status(cached, "stale", today))
            return error_response(
                503,
                "The daily cost report is temporarily unavailable.",
                code="cost_report_unavailable",
            )
    except Exception as error:
        request_id = getattr(context, "aws_request_id", "unknown") if context else "unknown"
        logger.error(
            "cost_report_cache_failed request_id=%s error_type=%s",
            request_id,
            type(error).__name__,
        )
        return error_response(
            503,
            "The daily cost report is temporarily unavailable.",
            code="cost_report_unavailable",
        )
