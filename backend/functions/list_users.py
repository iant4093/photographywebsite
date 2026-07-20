"""Minimal, paginated admin user directory."""

import os

import boto3

from auth_helpers import require_admin
from response_helpers import error_response, internal_error, json_response
from validation_helpers import ValidationError, require_string, validate_limit


cognito = boto3.client("cognito-idp")
USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]


def handler(event, context):
    denied = require_admin(event)
    if denied:
        return denied
    try:
        query = (event or {}).get("queryStringParameters") or {}
        limit = validate_limit(query.get("limit"), default=60, maximum=60)
        token = query.get("paginationToken")
        params = {"UserPoolId": USER_POOL_ID, "Limit": limit}
        if token:
            params["PaginationToken"] = require_string(token, "paginationToken", maximum=4096)
        response = cognito.list_users(**params)
        users = []
        for user in response.get("Users", []):
            attrs = {
                item.get("Name"): item.get("Value", "")
                for item in user.get("Attributes", [])
                if item.get("Name")
            }
            created = user.get("UserCreateDate")
            users.append(
                {
                    "email": attrs.get("email", ""),
                    "status": user.get("UserStatus", "UNKNOWN"),
                    "createdAt": created.isoformat() if created else "",
                    "enabled": bool(user.get("Enabled", False)),
                }
            )
        body = {"users": users}
        if response.get("PaginationToken"):
            body["paginationToken"] = response["PaginationToken"]
        return json_response(200, body)
    except ValidationError as error:
        return error_response(400, str(error), code="invalid_request")
    except Exception as error:
        return internal_error(context, error, "list_users")
