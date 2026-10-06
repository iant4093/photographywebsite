#!/usr/bin/env python3
"""Activate feature billing labels and query bounded, application-only costs.

Resource ownership is declared in feature_costs.json and the SAM template.
This tool only tags explicitly named frontend resources; application
resources are tagged through CloudFormation. Shared resources stay shared.
"""
import argparse
import datetime as dt
import json
from pathlib import Path

REGISTRY = Path(__file__).with_suffix(".json")


def frontend_tag_plan(existing, registry, stage=None):
    labels = {tag["Key"]: tag["Value"] for tag in existing}
    target = {"Application": registry["application"], "Feature": registry["frontendDistributionFeature"]}
    if stage is not None:
        target["Stage"] = stage
    if labels.get("Application") not in (None, target["Application"]):
        raise ValueError("Frontend distribution belongs to another application")
    return [{"Key": key, "Value": value} for key, value in target.items() if labels.get(key) != value]


def report_request(start, end, registry):
    first, last = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    if not 1 <= (last - first).days <= 31:
        raise ValueError("Choose between one and 31 complete days; end is exclusive")
    return {
        "TimePeriod": {"Start": start, "End": end}, "Granularity": "DAILY",
        "Metrics": ["UnblendedCost"],
        "Filter": {"Tags": {"Key": "Application", "Values": [registry["application"]]}},
        "GroupBy": [{"Type": "TAG", "Key": registry["tagKey"]}, {"Type": "DIMENSION", "Key": "SERVICE"}],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["tag-frontend", "tag-frontend-storage", "activate", "status", "report"])
    parser.add_argument("--expected-account-id", required=True)
    parser.add_argument("--distribution-id")
    parser.add_argument("--bucket-name")
    parser.add_argument("--stage")
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    import boto3
    identity = boto3.client("sts").get_caller_identity()
    if identity["Account"] != args.expected_account_id:
        raise ValueError("AWS account does not match the reviewed account")
    registry = json.loads(REGISTRY.read_text())
    billing = boto3.client("ce", region_name="us-east-1")
    if args.command == "tag-frontend":
        if not args.distribution_id:
            raise ValueError("An exact reviewed frontend distribution ID is required")
        arn = f"arn:{identity['Arn'].split(':')[1]}:cloudfront::{identity['Account']}:distribution/{args.distribution_id}"
        cloudfront = boto3.client("cloudfront")
        tags = frontend_tag_plan(cloudfront.list_tags_for_resource(Resource=arn)["Tags"]["Items"], registry, args.stage)
        if args.apply and tags:
            cloudfront.tag_resource(Resource=arn, Tags={"Items": tags})
        print(json.dumps({"applied": args.apply, "tagChanges": tags}))
    elif args.command == "tag-frontend-storage":
        if not args.bucket_name:
            raise ValueError("An exact reviewed frontend bucket is required")
        storage = boto3.client("s3")
        try:
            existing = storage.get_bucket_tagging(Bucket=args.bucket_name, ExpectedBucketOwner=args.expected_account_id)["TagSet"]
        except storage.exceptions.ClientError as error:
            if error.response["Error"]["Code"] != "NoSuchTagSet":
                raise
            existing = []
        tags = frontend_tag_plan(existing, registry, args.stage)
        merged = {tag["Key"]: tag["Value"] for tag in existing + tags}
        if len(merged) > 50:
            raise ValueError("Frontend bucket exceeds its tag limit")
        if args.apply and tags:
            storage.put_bucket_tagging(Bucket=args.bucket_name, ExpectedBucketOwner=args.expected_account_id,
                Tagging={"TagSet": [{"Key": key, "Value": value} for key, value in sorted(merged.items())]})
        print(json.dumps({"applied": args.apply, "tagChanges": tags}))
    elif args.command in {"activate", "status"}:
        keys = ["Application", "Stage", registry["tagKey"]]
        tags = billing.list_cost_allocation_tags(TagKeys=keys, Type="UserDefined")["CostAllocationTags"]
        if args.command == "activate":
            pending = sorted(set(keys) - {tag["TagKey"] for tag in tags})
            updates = [{"TagKey": t["TagKey"], "Status": "Active"} for t in tags if t["Status"] != "Active"]
            if args.apply and updates:
                result = billing.update_cost_allocation_tags_status(CostAllocationTagsStatus=updates)
                if result.get("Errors"):
                    raise ValueError("AWS did not activate every requested key")
            print(json.dumps({"applied": args.apply, "updates": updates, "pendingRegistration": pending}))
        else:
            print(json.dumps({"tags": [{"key": t["TagKey"], "status": t["Status"]} for t in tags]}))
    else:
        if not args.start or not args.end:
            raise ValueError("A bounded start/end date is required")
        request = report_request(args.start, args.end, registry)
        if not args.apply:
            print(json.dumps({"request": request, "executed": False}))
            return
        result = billing.get_cost_and_usage(**request)
        if result.get("NextPageToken"):
            raise ValueError("Report exceeded the single-request bound; shorten the date window")
        print(json.dumps({"results": result["ResultsByTime"], "sharedResourceRule": registry["sharedResourceRule"]}))


if __name__ == "__main__":
    main()
