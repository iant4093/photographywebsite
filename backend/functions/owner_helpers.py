"""Paginated owner lookup helpers for user lifecycle operations."""

import os

import boto3
from boto3.dynamodb.conditions import Attr, Key

from auth_helpers import AuthError, get_caller_claims


table = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])


def _pages(method, **kwargs):
    start_key = None
    while True:
        request = dict(kwargs)
        if start_key:
            request["ExclusiveStartKey"] = start_key
        response = method(**request)
        yield from response.get("Items", [])
        start_key = response.get("LastEvaluatedKey")
        if not start_key:
            break


def albums_owned_by(subject, email):
    """Return deduplicated albums, supporting records awaiting ownerSub migration."""
    subject = str(subject or "").strip()
    email = str(email or "").strip().lower()
    records = {}
    phase = os.environ.get("ALBUM_INDEX_DEPLOYMENT_PHASE", "none").strip().lower()
    if subject and phase == "both":
        for album in _pages(
            table.query,
            IndexName=os.environ.get("OWNER_SUB_CREATED_AT_INDEX", "OwnerSubCreatedAtIndex"),
            KeyConditionExpression=Key("ownerSub").eq(subject),
        ):
            if album.get("albumId"):
                records[album["albumId"]] = album
        legacy_filter = Attr("ownerSub").not_exists() & Attr("ownerEmail").eq(email)
        for album in _pages(table.scan, FilterExpression=legacy_filter):
            if album.get("albumId"):
                records[album["albumId"]] = album
        return list(records.values())

    owner_filter = Attr("ownerEmail").eq(email)
    if subject:
        owner_filter = Attr("ownerSub").eq(subject) | (Attr("ownerSub").not_exists() & owner_filter)
    for album in _pages(table.scan, FilterExpression=owner_filter):
        if album.get("albumId"):
            records[album["albumId"]] = album
    return list(records.values())


def cognito_identity(cognito, user_pool_id, email):
    response = cognito.admin_get_user(UserPoolId=user_pool_id, Username=email)
    attributes = {
        item.get("Name"): item.get("Value", "")
        for item in response.get("UserAttributes", [])
        if item.get("Name")
    }
    return response.get("Username", email), attributes.get("sub", ""), attributes


def groups_for_user(cognito, user_pool_id, username, max_pages=10):
    groups = set()
    token = None
    seen = set()
    for _ in range(max_pages):
        request = {"UserPoolId": user_pool_id, "Username": username, "Limit": 60}
        if token:
            request["NextToken"] = token
        response = cognito.admin_list_groups_for_user(**request)
        groups.update(
            str(item.get("GroupName", "")).strip()
            for item in response.get("Groups", [])
            if isinstance(item, dict) and str(item.get("GroupName", "")).strip()
        )
        next_token = response.get("NextToken")
        if not next_token:
            return groups
        if not isinstance(next_token, str) or next_token in seen:
            raise RuntimeError("Cognito group pagination token repeated or malformed")
        seen.add(next_token)
        token = next_token
    raise RuntimeError("Cognito group lookup exceeded its page limit")


def assert_admin_target_mutable(event, cognito, user_pool_id, username, target_sub):
    caller = get_caller_claims(event)
    if target_sub and str(caller.get("sub", "")) == str(target_sub):
        raise AuthError("Administrators cannot modify their own account", 403)
    if "Admins" in groups_for_user(cognito, user_pool_id, username):
        raise AuthError("Administrator accounts cannot be modified here", 403)
