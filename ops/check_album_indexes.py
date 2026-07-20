#!/usr/bin/env python3
"""Report the album-table GSI migration state without printing album data."""

from __future__ import annotations

import argparse
import json
from typing import Any

from aws_stack import aws_json, stack_resource

EXPECTED_INDEXES = {
    "ShareCodeIndex": ("shareCode", None),
    "VisibilityCreatedAtIndex": ("visibility", "createdAt"),
    "OwnerSubCreatedAtIndex": ("ownerSub", "createdAt"),
}


def key_names(index: dict[str, Any]) -> tuple[str | None, str | None]:
    schema = {item["KeyType"]: item["AttributeName"] for item in index.get("KeySchema", [])}
    return schema.get("HASH"), schema.get("RANGE")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    args = parser.parse_args()

    account = aws_json(["sts", "get-caller-identity"], args.profile, args.region)["Account"]
    table_name = stack_resource(args.stack_name, "AlbumsTable", args.profile, args.region)
    table = aws_json(["dynamodb", "describe-table", "--table-name", table_name], args.profile, args.region)[
        "Table"
    ]
    indexes = {item["IndexName"]: item for item in table.get("GlobalSecondaryIndexes", [])}
    status: dict[str, Any] = {}
    invalid = False
    for name, expected_schema in EXPECTED_INDEXES.items():
        index = indexes.get(name)
        if not index:
            status[name] = {"present": False}
            continue
        actual_schema = key_names(index)
        schema_matches = actual_schema == expected_schema
        ready = index.get("IndexStatus") == "ACTIVE" and not index.get("Backfilling", False)
        status[name] = {
            "present": True,
            "status": index.get("IndexStatus"),
            "backfilling": bool(index.get("Backfilling", False)),
            "schemaMatches": schema_matches,
            "ready": ready and schema_matches,
        }
        invalid = invalid or not schema_matches

    visibility_ready = status["VisibilityCreatedAtIndex"].get("ready", False)
    owner_ready = status["OwnerSubCreatedAtIndex"].get("ready", False)
    if owner_ready:
        suggested_phase = "both"
    elif visibility_ready:
        suggested_phase = "visibility"
    else:
        suggested_phase = "none"

    print(
        json.dumps(
            {
                "account": account,
                "stack": args.stack_name,
                "table": table_name,
                "tableStatus": table.get("TableStatus"),
                "itemCountEstimate": table.get("ItemCount"),
                "indexes": status,
                "suggestedTemplatePhase": suggested_phase,
                "note": "ItemCount is an approximate DynamoDB control-plane value.",
            },
            indent=2,
        )
    )
    return 1 if invalid else 0


if __name__ == "__main__":
    raise SystemExit(main())
