"""Lightweight album metadata/owner validation shared by write handlers."""

import datetime
import os

import boto3

from validation_helpers import ValidationError, require_string, validate_email, validate_uuid


cognito = boto3.client("cognito-idp")


def validate_created_at(value):
    text = require_string(value, "createdAt", maximum=40)
    try:
        datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ValidationError("createdAt must be an ISO-8601 timestamp") from None
    return text


def resolve_owner(body):
    owner_email = validate_email(body.get("ownerEmail"), "ownerEmail")
    owner_sub = body.get("ownerSub")
    if owner_sub:
        return owner_email, validate_uuid(owner_sub, "ownerSub")

    escaped = owner_email.replace("\\", "\\\\").replace('"', '\\"')
    response = cognito.list_users(
        UserPoolId=os.environ["COGNITO_USER_POOL_ID"],
        Filter=f'email = "{escaped}"',
        Limit=2,
    )
    users = response.get("Users", [])
    if len(users) != 1:
        raise ValidationError("ownerEmail must identify exactly one user")
    attributes = {
        item.get("Name"): item.get("Value", "")
        for item in users[0].get("Attributes", [])
        if item.get("Name")
    }
    return owner_email, validate_uuid(attributes.get("sub"), "ownerSub")
