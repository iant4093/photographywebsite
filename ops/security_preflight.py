#!/usr/bin/env python3
"""Read-only inventory for the staged account security templates.

The script deliberately treats missing permissions and API errors as unknown,
never as proof that a singleton is absent. It prints aggregate state by default;
``--details`` additionally prints the AWS names/identifiers needed for an import
or ownership review.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from dataclasses import dataclass
from typing import Any


STAGE_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$")


@dataclass
class AwsCallError(RuntimeError):
    service: str
    operation: str
    message: str

    def __str__(self) -> str:
        return f"{self.service} {self.operation}: {self.message}"


def aws_call(
    arguments: list[str], profile: str | None, region: str
) -> dict[str, Any]:
    command = ["aws"]
    if profile:
        command.extend(["--profile", profile])
    command.extend(["--region", region, *arguments, "--output", "json"])
    result = subprocess.run(command, text=True, capture_output=True)
    if result.returncode != 0:
        message = " ".join((result.stderr or result.stdout or "AWS CLI failed").split())
        raise AwsCallError(arguments[0], arguments[1], message[:500])
    try:
        value = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as error:
        raise AwsCallError(arguments[0], arguments[1], "invalid JSON response") from error
    if not isinstance(value, dict):
        raise AwsCallError(arguments[0], arguments[1], "unexpected non-object response")
    return value


def _names(items: list[dict[str, Any]], field: str, details: bool) -> list[str]:
    if not details:
        return []
    return sorted(
        value for item in items if isinstance((value := item.get(field)), str) and value
    )


def _decision(count: int | None, create_value: str = "create-confirmed-absent") -> str:
    if count is None:
        return "skip-inventory-incomplete"
    if count:
        return "skip-and-review-existing-for-import-or-external-management"
    return create_value


def inventory(
    *,
    stage: str,
    region: str,
    profile: str | None,
    audit_log_group_name: str | None,
    details: bool,
    caller=aws_call,
) -> tuple[dict[str, Any], bool]:
    errors: list[str] = []

    def read(arguments: list[str], absent_errors: tuple[str, ...] = ()) -> dict[str, Any] | None:
        try:
            return caller(arguments, profile, region)
        except AwsCallError as error:
            lowered = error.message.lower()
            if absent_errors and any(marker.lower() in lowered for marker in absent_errors):
                return {}
            errors.append(str(error))
            return None

    identity = read(["sts", "get-caller-identity"])
    account = identity.get("Account") if identity else None

    trails_response = read(["cloudtrail", "describe-trails", "--no-include-shadow-trails"])
    trails = (trails_response or {}).get("trailList", []) if trails_response is not None else []
    target_trail_name = f"ian-photography-security-{stage}"
    target_trails = [item for item in trails if item.get("Name") == target_trail_name]
    multi_region_trails = [item for item in trails if item.get("IsMultiRegionTrail") is True]

    log_groups_response = read(
        [
            "logs",
            "describe-log-groups",
            "--log-group-name-prefix",
            f"/aws/security/ian-photography-{stage}",
        ]
    )
    log_groups = (log_groups_response or {}).get("logGroups", []) if log_groups_response is not None else []
    target_log_groups = [
        item
        for item in log_groups
        if item.get("logGroupName") == f"/aws/security/ian-photography-{stage}"
    ]

    detectors_response = read(["guardduty", "list-detectors"])
    detectors = (detectors_response or {}).get("DetectorIds", []) if detectors_response is not None else []

    recorders_response = read(["configservice", "describe-configuration-recorders"])
    channels_response = read(["configservice", "describe-delivery-channels"])
    recorders = (recorders_response or {}).get("ConfigurationRecorders", []) if recorders_response is not None else []
    channels = (channels_response or {}).get("DeliveryChannels", []) if channels_response is not None else []
    config_count = (
        None
        if recorders_response is None or channels_response is None
        else max(len(recorders), len(channels))
    )

    hub_response = read(
        ["securityhub", "describe-hub"],
        absent_errors=("InvalidAccessException", "not subscribed", "not enabled"),
    )
    hub_count = None if hub_response is None else (1 if hub_response.get("HubArn") else 0)

    analyzers_response = read(["accessanalyzer", "list-analyzers", "--type", "ACCOUNT"])
    analyzers = (analyzers_response or {}).get("analyzers", []) if analyzers_response is not None else []

    vaults_response = read(["backup", "list-backup-vaults"])
    vaults = (vaults_response or {}).get("BackupVaultList", []) if vaults_response is not None else []
    target_vaults = [
        item
        for item in vaults
        if item.get("BackupVaultName") == f"ian-photography-protected-{stage}"
    ]
    plans_response = read(["backup", "list-backup-plans"])
    plans = (plans_response or {}).get("BackupPlansList", []) if plans_response is not None else []
    target_plans = [
        item
        for item in plans
        if item.get("BackupPlanName") == f"ian-photography-protected-data-{stage}"
        and item.get("DeletionDate") is None
    ]

    topics_response = read(["sns", "list-topics"])
    topics = (topics_response or {}).get("Topics", []) if topics_response is not None else []
    target_topic_suffix = f":ian-photography-security-{stage}"
    target_topics = [item for item in topics if item.get("TopicArn", "").endswith(target_topic_suffix)]

    aliases_response = read(["kms", "list-aliases"])
    aliases = (aliases_response or {}).get("Aliases", []) if aliases_response is not None else []
    target_aliases = [
        item for item in aliases if item.get("AliasName") == f"alias/ian-photography-security-{stage}"
    ]
    target_backup_aliases = [
        item for item in aliases if item.get("AliasName") == f"alias/ian-photography-backup-{stage}"
    ]

    queues_response = read(
        ["sqs", "list-queues", "--queue-name-prefix", f"ian-photography-security-events-{stage}-dlq"]
    )
    queue_urls = (queues_response or {}).get("QueueUrls", []) if queues_response is not None else []
    target_queue_urls = [url for url in queue_urls if url.rsplit("/", 1)[-1] == f"ian-photography-security-events-{stage}-dlq"]

    rules_response = read(["events", "list-rules", "--name-prefix", "ian-photography-"])
    rules = (rules_response or {}).get("Rules", []) if rules_response is not None else []
    expected_rule_names = {
        f"ian-photography-guardduty-high-{stage}",
        f"ian-photography-securityhub-high-{stage}",
    }
    target_rules = [item for item in rules if item.get("Name") in expected_rule_names]

    alarms_response = read(["cloudwatch", "describe-alarms", "--alarm-name-prefix", "ian-photography-"])
    alarms = (alarms_response or {}).get("MetricAlarms", []) if alarms_response is not None else []
    expected_alarm_names = {
        f"ian-photography-root-activity-{stage}",
        f"ian-photography-cloudtrail-change-{stage}",
        f"ian-photography-iam-change-{stage}",
    }
    target_alarms = [item for item in alarms if item.get("AlarmName") in expected_alarm_names]

    metric_filters_response: dict[str, Any] | None = {}
    metric_filters: list[dict[str, Any]] = []
    if audit_log_group_name:
        metric_filters_response = read(
            ["logs", "describe-metric-filters", "--log-group-name", audit_log_group_name]
        )
        metric_filters = (
            (metric_filters_response or {}).get("metricFilters", [])
            if metric_filters_response is not None
            else []
        )
    expected_filter_names = {
        f"ian-photography-root-activity-{stage}",
        f"ian-photography-cloudtrail-change-{stage}",
        f"ian-photography-iam-change-{stage}",
    }
    target_filters = [item for item in metric_filters if item.get("filterName") in expected_filter_names]

    foundation_unknown = trails_response is None or log_groups_response is None
    if foundation_unknown:
        foundation_decision = "skip-inventory-incomplete"
    elif target_trails or target_log_groups:
        foundation_decision = "skip-and-review-existing-for-import-or-existing-stack"
    elif multi_region_trails:
        foundation_decision = "review-existing-multi-region-trail-before-creating-another"
    else:
        foundation_decision = "create-after-reviewed-changeset-and-enable-termination-protection"

    notification_counts = (
        None
        if any(
            response is None
            for response in (
                topics_response,
                aliases_response,
                queues_response,
                rules_response,
                alarms_response,
                metric_filters_response,
            )
        )
        else sum(
            len(values)
            for values in (
                target_topics,
                target_aliases,
                target_queue_urls,
                target_rules,
                target_alarms,
                target_filters,
            )
        )
    )
    backup_count = (
        None
        if vaults_response is None or plans_response is None or aliases_response is None
        else len(target_vaults) + len(target_plans) + len(target_backup_aliases)
    )

    report: dict[str, Any] = {
        "mode": "read-only",
        "accountId": account if details else ("verified" if account else "unknown"),
        "region": region,
        "stage": stage,
        "inventory": {
            "auditFoundation": {
                "matchingTrailCount": None if trails_response is None else len(target_trails),
                "multiRegionTrailCount": None if trails_response is None else len(multi_region_trails),
                "matchingLogGroupCount": None if log_groups_response is None else len(target_log_groups),
                "names": _names(target_trails, "Name", details)
                + _names(target_log_groups, "logGroupName", details),
            },
            "guardDuty": {
                "detectorCount": None if detectors_response is None else len(detectors),
                "identifiers": sorted(detectors) if details else [],
            },
            "config": {
                "recorderCount": None if recorders_response is None else len(recorders),
                "deliveryChannelCount": None if channels_response is None else len(channels),
                "names": _names(recorders, "name", details) + _names(channels, "name", details),
            },
            "securityHub": {"hubCount": hub_count},
            "accessAnalyzer": {
                "accountAnalyzerCount": None if analyzers_response is None else len(analyzers),
                "names": _names(analyzers, "name", details),
            },
            "notifications": {
                "matchingResourceCount": notification_counts,
                "topicArns": _names(target_topics, "TopicArn", details),
                "kmsAliases": _names(target_aliases, "AliasName", details),
                "queueUrls": sorted(target_queue_urls) if details else [],
                "ruleNames": _names(target_rules, "Name", details),
                "alarmNames": _names(target_alarms, "AlarmName", details),
                "metricFilterNames": _names(target_filters, "filterName", details),
            },
            "backup": {
                "matchingVaultCount": None if vaults_response is None else len(target_vaults),
                "matchingPlanCount": None if plans_response is None else len(target_plans),
                "matchingKmsAliasCount": None if aliases_response is None else len(target_backup_aliases),
                "names": _names(target_vaults, "BackupVaultName", details)
                + _names(target_plans, "BackupPlanName", details)
                + _names(target_backup_aliases, "AliasName", details),
            },
        },
        "recommendedParameters": {
            "auditFoundation": foundation_decision,
            "notifications": _decision(notification_counts, "create-after-audit-foundation"),
            "ConfigDeploymentMode": _decision(config_count),
            "GuardDutyDeploymentMode": _decision(
                None if detectors_response is None else len(detectors)
            ),
            "SecurityHubDeploymentMode": _decision(hub_count),
            "AccessAnalyzerDeploymentMode": _decision(
                None if analyzers_response is None else len(analyzers)
            ),
            "BackupDeploymentMode": _decision(
                backup_count, "create-confirmed-no-conflict"
            ),
            "VaultLockMode": "unlocked-until-successful-restore-test",
        },
        "manualDecisions": [
            "Deploy the audit foundation once in the home region and enable stack termination protection.",
            "Use skip for any existing singleton; decide whether to import it or manage it outside this stack.",
            "Approve and create an SNS subscription separately; this repository does not invent an endpoint.",
            "Keep the backup vault unlocked until a scheduled recovery point has been restored and verified.",
        ],
        "inventoryErrors": errors,
    }
    return report, bool(errors)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", default="prod")
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--profile")
    parser.add_argument("--audit-log-group-name")
    parser.add_argument(
        "--details",
        action="store_true",
        help="Include AWS names and identifiers needed for an import review.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not STAGE_PATTERN.fullmatch(args.stage):
        raise SystemExit("--stage must be 1-20 lowercase letters, digits, or internal hyphens")
    report, incomplete = inventory(
        stage=args.stage,
        region=args.region,
        profile=args.profile,
        audit_log_group_name=args.audit_log_group_name,
        details=args.details,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 2 if incomplete else 0


if __name__ == "__main__":
    raise SystemExit(main())
