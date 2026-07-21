#!/usr/bin/env python3
"""Plan or set retention on existing Lambda log groups owned by a stack.

Output is aggregate-only so operational function names never enter shared
evidence.
"""

from __future__ import annotations

import argparse
import json

from aws_stack import aws_json


VALID_RETENTION = {1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--profile")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--confirm-stack-name")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.days not in VALID_RETENTION:
        raise SystemExit("Unsupported CloudWatch Logs retention value.")

    account = aws_json(["sts", "get-caller-identity"], args.profile, args.region)["Account"]
    resources = aws_json(
        ["cloudformation", "list-stack-resources", "--stack-name", args.stack_name],
        args.profile,
        args.region,
    ).get("StackResourceSummaries", [])
    functions = sorted(
        item["PhysicalResourceId"]
        for item in resources
        if item.get("ResourceType") == "AWS::Lambda::Function" and item.get("PhysicalResourceId")
    )
    existing: list[tuple[str, int | None]] = []
    missing = 0
    for function_name in functions:
        log_name = f"/aws/lambda/{function_name}"
        groups = aws_json(
            ["logs", "describe-log-groups", "--log-group-name-prefix", log_name],
            args.profile,
            args.region,
        ).get("logGroups", [])
        exact = next((group for group in groups if group.get("logGroupName") == log_name), None)
        if exact:
            existing.append((log_name, exact.get("retentionInDays")))
        else:
            missing += 1

    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "account": "verified",
        "stack": args.stack_name,
        "lambdaFunctionCount": len(functions),
        "existingLogGroupCount": len(existing),
        "missingLogGroupCount": missing,
        "targetRetentionDays": args.days,
        "alreadyCompliantCount": sum(1 for _, days in existing if days == args.days),
        "changeCount": sum(1 for _, days in existing if days != args.days),
    }, indent=2))
    if not args.apply:
        return 0
    if args.expected_account_id != account:
        raise SystemExit("Refusing apply: --expected-account-id does not match.")
    if args.confirm_stack_name != args.stack_name:
        raise SystemExit("Refusing apply: --confirm-stack-name must exactly match.")
    for log_name, current_days in existing:
        if current_days != args.days:
            aws_json(
                ["logs", "put-retention-policy", "--log-group-name", log_name, "--retention-in-days", str(args.days)],
                args.profile,
                args.region,
            )
    print(json.dumps({"updatedLogGroupCount": sum(1 for _, days in existing if days != args.days)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
