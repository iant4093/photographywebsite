#!/usr/bin/env python3
"""Backfill legacy album ownerSub values from Cognito; dry-run by default.

No email address, subject, album ID, title, or share code is printed. Apply is
guarded by account, table-record count, user-pool ID, and an explicit phrase.
Only unambiguous email-to-sub mappings are written, and existing ownerSub values
are never overwritten.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from typing import Any
import uuid

from aws_stack import aws_json, stack_resource

EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def scalar(item: dict[str, Any], field: str) -> str | None:
    value = item.get(field, {})
    if not isinstance(value, dict):
        return None
    text = value.get("S")
    return text if isinstance(text, str) and text else None


def user_attributes(user: dict[str, Any]) -> dict[str, str]:
    return {
        item["Name"]: item["Value"]
        for item in user.get("Attributes", [])
        if isinstance(item, dict) and isinstance(item.get("Name"), str) and isinstance(item.get("Value"), str)
    }


def valid_uuid(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return None


def scan_all(table: str, profile: str | None, region: str | None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    start_key: dict[str, Any] | None = None
    seen_tokens: set[str] = set()
    while True:
        arguments = [
            "dynamodb",
            "scan",
            "--no-paginate",
            "--table-name",
            table,
            "--projection-expression",
            "albumId, ownerEmail, ownerSub, #visibility, #status",
            "--expression-attribute-names",
            '{"#visibility":"visibility","#status":"status"}',
        ]
        if start_key:
            arguments.extend(
                ["--exclusive-start-key", json.dumps(start_key, separators=(",", ":"))]
            )
        page = aws_json(arguments, profile, region)
        page_items = page.get("Items", [])
        if not isinstance(page_items, list):
            raise RuntimeError("DynamoDB scan returned malformed Items")
        items.extend(page_items)
        start_key = page.get("LastEvaluatedKey")
        if not start_key:
            return items
        token = json.dumps(start_key, sort_keys=True, separators=(",", ":"))
        if token in seen_tokens:
            raise RuntimeError("DynamoDB pagination token repeated")
        seen_tokens.add(token)


def list_users_all(user_pool_id: str, profile: str | None, region: str | None) -> list[dict[str, Any]]:
    users: list[dict[str, Any]] = []
    pagination_token: str | None = None
    seen_tokens: set[str] = set()
    while True:
        arguments = [
            "cognito-idp",
            "list-users",
            "--no-paginate",
            "--user-pool-id",
            user_pool_id,
        ]
        if pagination_token:
            arguments.extend(["--pagination-token", pagination_token])
        page = aws_json(arguments, profile, region)
        page_users = page.get("Users", [])
        if not isinstance(page_users, list):
            raise RuntimeError("Cognito returned malformed Users")
        users.extend(page_users)
        next_token = page.get("PaginationToken")
        if not next_token:
            return users
        if not isinstance(next_token, str) or next_token in seen_tokens:
            raise RuntimeError("Cognito pagination token repeated or malformed")
        seen_tokens.add(next_token)
        pagination_token = next_token


def build_backfill_plan(
    albums: list[dict[str, Any]], users: list[dict[str, Any]]
) -> tuple[list[tuple[str, str]], dict[str, int]]:
    subjects_by_email: dict[str, set[str]] = {}
    for user in users:
        attributes = user_attributes(user)
        email = attributes.get("email", "").strip().lower()
        subject = valid_uuid(attributes.get("sub", "").strip())
        if EMAIL_PATTERN.fullmatch(email) and subject:
            subjects_by_email.setdefault(email, set()).add(subject)

    candidates: list[tuple[str, str]] = []
    counts = {
        "alreadyPopulatedCount": 0,
        "malformedExistingOwnerSubCount": 0,
        "nonPrivateSkippedCount": 0,
        "inactiveSkippedCount": 0,
        "missingOwnerEmailCount": 0,
        "malformedOwnerEmailCount": 0,
        "malformedAlbumIdCount": 0,
        "unmatchedOwnerEmailCount": 0,
        "ambiguousOwnerEmailCount": 0,
    }
    for album in albums:
        existing_subject = scalar(album, "ownerSub")
        if existing_subject:
            key = (
                "alreadyPopulatedCount"
                if valid_uuid(existing_subject)
                else "malformedExistingOwnerSubCount"
            )
            counts[key] += 1
            continue
        if scalar(album, "visibility") != "private":
            counts["nonPrivateSkippedCount"] += 1
            continue
        if scalar(album, "status") not in (None, "active"):
            counts["inactiveSkippedCount"] += 1
            continue
        album_id = valid_uuid(scalar(album, "albumId"))
        email = (scalar(album, "ownerEmail") or "").strip().lower()
        if not album_id:
            counts["malformedAlbumIdCount"] += 1
            continue
        if not email:
            counts["missingOwnerEmailCount"] += 1
            continue
        if not EMAIL_PATTERN.fullmatch(email) or len(email) > 254:
            counts["malformedOwnerEmailCount"] += 1
            continue
        subjects = subjects_by_email.get(email, set())
        if not subjects:
            counts["unmatchedOwnerEmailCount"] += 1
        elif len(subjects) > 1:
            counts["ambiguousOwnerEmailCount"] += 1
        else:
            candidates.append((album_id, next(iter(subjects))))
    return candidates, counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--expected-record-count", type=int)
    parser.add_argument("--confirm-stack-name")
    parser.add_argument("--confirm")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    account = aws_json(["sts", "get-caller-identity"], args.profile, args.region)["Account"]
    table = stack_resource(args.stack_name, "AlbumsTable", args.profile, args.region)
    user_pool_id = stack_resource(args.stack_name, "UserPool", args.profile, args.region)
    albums = scan_all(table, args.profile, args.region)
    users = list_users_all(user_pool_id, args.profile, args.region)

    candidates, counts = build_backfill_plan(albums, users)

    print(
        json.dumps(
            {
                "mode": "apply" if args.apply else "dry-run",
                "account": account,
                "stack": args.stack_name,
                "table": table,
                "userPoolId": user_pool_id,
                "albumRecordCount": len(albums),
                "cognitoUserCount": len(users),
                "safeBackfillCount": len(candidates),
                **counts,
            },
            indent=2,
        )
    )
    if not args.apply:
        print("Dry run only. No album record was changed.")
        return 0
    if args.expected_account_id != account:
        raise SystemExit("Refusing apply: --expected-account-id does not match.")
    if args.expected_record_count != len(albums):
        raise SystemExit("Refusing apply: --expected-record-count does not match the current table.")
    if args.confirm_stack_name != args.stack_name:
        raise SystemExit("Refusing apply: --confirm-stack-name must exactly match.")
    if args.confirm != "backfill-album-owner-sub":
        raise SystemExit("Refusing apply: --confirm must be exactly backfill-album-owner-sub.")
    if counts["ambiguousOwnerEmailCount"]:
        raise SystemExit("Refusing apply while ambiguous Cognito email mappings exist.")

    updated = 0
    condition_conflicts = 0
    for album_id, subject in candidates:
        try:
            aws_json(
                [
                    "dynamodb",
                    "update-item",
                    "--table-name",
                    table,
                    "--key",
                    json.dumps({"albumId": {"S": album_id}}, separators=(",", ":")),
                    "--update-expression",
                    "SET ownerSub = :subject",
                    "--condition-expression",
                    "attribute_not_exists(ownerSub) OR ownerSub = :empty",
                    "--expression-attribute-values",
                    json.dumps(
                        {":subject": {"S": subject}, ":empty": {"S": ""}}, separators=(",", ":")
                    ),
                ],
                args.profile,
                args.region,
            )
            updated += 1
        except subprocess.CalledProcessError as error:
            if "ConditionalCheckFailedException" in (error.stderr or ""):
                condition_conflicts += 1
            else:
                raise
    print(json.dumps({"updatedCount": updated, "conditionConflictCount": condition_conflicts}, indent=2))
    return 1 if condition_conflicts else 0


if __name__ == "__main__":
    raise SystemExit(main())
