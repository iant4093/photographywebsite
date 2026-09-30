"""Consistent JSON responses and redacted error logging for Lambda handlers."""

import json
import logging
import re
from decimal import Decimal


logger = logging.getLogger("photography_api")
logger.setLevel(logging.INFO)

ERROR_DETAIL_MAX_CHARS = 300
_ERROR_DETAIL_REDACTIONS = (
    # Object keys embed album ids and original filenames.
    (re.compile(r"(albums|public-previews|temp-zips|album-zips|fotomoto|site/hero)/[^\s\"']+"), r"\1/<redacted>"),
    (re.compile(r"[^\s@\"']+@[^\s@\"']+\.[^\s@\"']+"), "<email>"),
    (re.compile(r"Bearer\s+[^\s\"']+", re.IGNORECASE), "Bearer <redacted>"),
    # JWTs, presigned signatures, hashes, and other opaque credentials.
    (re.compile(r"[A-Za-z0-9_\-.=]{40,}"), "<token>"),
    (re.compile(r"X-Amz-[A-Za-z-]+=[^&\s]+"), "X-Amz-<redacted>"),
)


class DynamoJsonEncoder(json.JSONEncoder):
    """Serialize DynamoDB numbers without exposing its Decimal implementation."""

    def default(self, value):
        if isinstance(value, Decimal):
            return int(value) if value == value.to_integral_value() else float(value)
        return super().default(value)


def json_response(status_code, body, *, cache_control="no-store", headers=None, encoder=None, cookies=None):
    response_headers = {"Content-Type": "application/json", "Cache-Control": cache_control}
    if headers:
        response_headers.update(headers)
    response = {
        "statusCode": status_code,
        "headers": response_headers,
        "body": json.dumps(body, cls=encoder or DynamoJsonEncoder),
    }
    if cookies:
        # HTTP API payload 2.0 emits one Set-Cookie header per list entry; a
        # single headers-map value cannot carry several cookies.
        response["cookies"] = list(cookies)
    return response


def error_response(status_code, message, *, code=None):
    body = {"error": message}
    if code:
        body["code"] = code
    return json_response(status_code, body)


def redact_error_detail(text):
    """Return exception text with object keys, emails, and credentials removed."""
    # Collapse control characters so a message cannot forge extra log lines.
    detail = re.sub(r"[\x00-\x1f\x7f]+", " ", str(text or ""))
    for pattern, replacement in _ERROR_DETAIL_REDACTIONS:
        detail = pattern.sub(replacement, detail)
    return detail[:ERROR_DETAIL_MAX_CHARS]


def internal_error(context=None, error=None, operation="request"):
    request_id = getattr(context, "aws_request_id", "unknown") if context else "unknown"
    error_type = type(error).__name__ if error else "UnknownError"
    try:
        error_text = "" if error is None else str(error)
    except Exception:
        error_text = ""
    # Exception text is logged only after redaction; event data never is.
    logger.error(
        "operation_failed operation=%s request_id=%s error_type=%s error_detail=%s",
        operation, request_id, error_type, redact_error_detail(error_text),
    )
    return error_response(500, "Internal server error", code="internal_error")
