#!/usr/bin/env python3
"""Plan or set retention on existing Lambda log groups owned by a stack.

Synthetics creates a backing Lambda with a service-generated suffix that
CloudFormation does not expose. ``--include-synthetics`` resolves its exact
current function through the stack-owned canary's ``EngineArn``. Output is
aggregate-only so operational function names never enter shared evidence.
"""

from __future__ import annotations

import argparse
import json
import re

from aws_stack import aws_json


VALID_RETENTION = {1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653}
LAMBDA_ARN = re.compile(
    r"^arn:(?:aws|aws-us-gov):lambda:(?P<region>[a-z0-9-]+):"
    r"(?P<account>[0-9]{12}):function:(?P<name>[A-Za-z0-9-_]{1,64})(?::[^:]+)?$"
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--profile")
    parser.add_argument("--expected-account-id")
    parser.add_argument("--confirm-stack-name")
    parser.add_argument(
        "--include-synthetics",
        action="store_true",
        help="Also reconcile backing Lambda groups for stack-owned Synthetics canaries.",
    )
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
    canaries = sorted(
        item["PhysicalResourceId"]
        for item in resources
        if args.include_synthetics
        and item.get("ResourceType") == "AWS::Synthetics::Canary"
        and item.get("PhysicalResourceId")
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

    synthetics_group_count = 0
    for canary_name in canaries:
        canary = aws_json(
            ["synthetics", "get-canary", "--name", canary_name],
            args.profile,
            args.region,
        ).get("Canary", {})
        engine_arn = canary.get("EngineArn") if isinstance(canary, dict) else None
        match = LAMBDA_ARN.fullmatch(engine_arn or "")
        if (
            not match
            or match.group("region") != args.region
            or match.group("account") != account
            or not match.group("name").startswith(f"cwsyn-{canary_name}-")
        ):
            raise SystemExit("Refusing: Synthetics returned an invalid backing Lambda ARN.")
        log_name = f"/aws/lambda/{match.group('name')}"
        groups = aws_json(
            ["logs", "describe-log-groups", "--log-group-name-prefix", log_name],
            args.profile,
            args.region,
        ).get("logGroups", [])
        exact = next(
            (group for group in groups if group.get("logGroupName") == log_name), None
        )
        if exact is None:
            missing += 1
        else:
            existing.append((log_name, exact.get("retentionInDays")))
            synthetics_group_count += 1

    # A function could be represented twice only if AWS changes its Synthetics
    # provider shape. Fail closed instead of mutating the same group ambiguously.
    if len({name for name, _ in existing}) != len(existing):
        raise SystemExit("Refusing: duplicate log-group ownership was discovered.")

    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "account": "verified",
        "stack": args.stack_name,
        "lambdaFunctionCount": len(functions),
        "syntheticsCanaryCount": len(canaries),
        "syntheticsLogGroupCount": synthetics_group_count,
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
