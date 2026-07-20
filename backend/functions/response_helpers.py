"""Consistent JSON responses and redacted error logging for Lambda handlers."""

import json
import logging
from decimal import Decimal


logger = logging.getLogger("photography_api")
logger.setLevel(logging.INFO)


class DynamoJsonEncoder(json.JSONEncoder):
    """Serialize DynamoDB numbers without exposing its Decimal implementation."""

    def default(self, value):
        if isinstance(value, Decimal):
            return int(value) if value == value.to_integral_value() else float(value)
        return super().default(value)


def json_response(status_code, body, *, cache_control="no-store", headers=None, encoder=None):
    response_headers = {"Content-Type": "application/json", "Cache-Control": cache_control}
    if headers:
        response_headers.update(headers)
    return {
        "statusCode": status_code,
        "headers": response_headers,
        "body": json.dumps(body, cls=encoder or DynamoJsonEncoder),
    }


def error_response(status_code, message, *, code=None):
    body = {"error": message}
    if code:
        body["code"] = code
    return json_response(status_code, body)


def internal_error(context=None, error=None, operation="request"):
    request_id = getattr(context, "aws_request_id", "unknown") if context else "unknown"
    error_type = type(error).__name__ if error else "UnknownError"
    # Intentionally exclude exception text, event data, object keys, and PII.
    logger.error("operation_failed operation=%s request_id=%s error_type=%s", operation, request_id, error_type)
    return error_response(500, "Internal server error", code="internal_error")
