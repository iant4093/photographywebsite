"""Validated, low-noise operational notifications; embedded in the CFN template."""

import hashlib
import http.client
import json
import logging
import math
import os
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import boto3


LOG = logging.getLogger()
LOG.setLevel(logging.INFO)
SNS = boto3.client("sns")
TOPIC_ARN = os.environ["SECURITY_TOPIC_ARN"]
STAGE = os.environ["STAGE"]
CONTRACTS = {
    "backup.job.failed": ("high", "backup-job-failure"),
    "edge.alarm": ("high", "edge-health"),
}
KEYS = {"schemaVersion", "eventName", "severity", "stage", "runbook"}
GUARDDUTY_KEYS = {"schemaVersion", "eventName", "severity", "findingId", "sample", "stage"}
NAMESPACE = "IanTruongPhotography/Security"


def _validated(body):
    try:
        value = json.loads(body)
    except (TypeError, ValueError) as error:
        raise ValueError("invalid security signal json") from error
    if not isinstance(value, dict) or type(value.get("schemaVersion")) is not int:
        raise ValueError("invalid security signal shape")
    if value["schemaVersion"] != 1 or value.get("stage") != STAGE:
        raise ValueError("security signal contract mismatch")
    if value.get("eventName") == "guardduty.finding":
        if set(value) != GUARDDUTY_KEYS:
            raise ValueError("invalid security signal shape")
        severity = value["severity"]
        if (type(severity) not in (int, float) or not math.isfinite(severity)
                or not 7 <= severity <= 10):
            raise ValueError("invalid GuardDuty severity")
        if not isinstance(value["findingId"], str) or not re.fullmatch("[a-f0-9]{32}", value["findingId"]):
            raise ValueError("invalid GuardDuty finding identifier")
        if value["sample"] not in ("", "true", "false"):
            raise ValueError("invalid GuardDuty sample marker")
        return value
    if set(value) == {"schemaVersion", "alarmName", "stage"}:
        names = {
            "ian-photography-frontend-5xx-" + STAGE: "edge.alarm",
            "ian-photography-media-5xx-" + STAGE: "edge.alarm",
        }
        event_name = names.get(value["alarmName"])
        if event_name is None:
            raise ValueError("unknown edge alarm signal")
        severity, anchor = CONTRACTS[event_name]
        value = {"schemaVersion": 1, "eventName": event_name,
                 "severity": severity, "stage": STAGE,
                 "runbook": "ops/ALARM_REGISTRY.md#" + anchor}
    if set(value) != KEYS:
        raise ValueError("invalid security signal shape")
    contract = CONTRACTS.get(value.get("eventName"))
    if contract is None:
        raise ValueError("unknown security signal")
    severity, anchor = contract
    expected = {"schemaVersion": 1, "eventName": value["eventName"],
                "severity": severity, "stage": STAGE,
                "runbook": "ops/ALARM_REGISTRY.md#" + anchor}
    if value != expected:
        raise ValueError("security signal contract mismatch")
    return expected


def _guardduty(signal):
    """Lease before delivery, retry failures, and suppress later repeats."""
    severity = "critical" if signal["severity"] >= 9 else "high"
    sample = signal["sample"] == "true"
    digest = hashlib.sha256((signal["findingId"] + ":" + severity + ":" + str(sample)).encode()).hexdigest()
    key = {"notificationKey": {"S": digest}}
    database = boto3.client("dynamodb")
    table = os.environ["NOTIFICATION_STATE_TABLE"]
    now, token = int(time.time()), uuid.uuid4().hex
    try:
        database.put_item(
            TableName=table,
            Item={**key, "status": {"S": "pending"}, "token": {"S": token},
                  "leaseUntil": {"N": str(now + 120)},
                  "expiresAt": {"N": str(now + 90 * 86400)}},
            ConditionExpression="attribute_not_exists(notificationKey) OR expiresAt <= :now OR (#s = :pending AND leaseUntil <= :now)",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":now": {"N": str(now)}, ":pending": {"S": "pending"}},
        )
    except database.exceptions.ConditionalCheckFailedException:
        item = database.get_item(TableName=table, Key=key, ConsistentRead=True).get("Item", {})
        if item.get("status", {}).get("S") == "sent":
            LOG.info("guardduty_notification_suppressed count=1")
            return {"forwarded": 0, "suppressed": 1}
        raise RuntimeError("security notification delivery already in progress") from None
    message = {"schemaVersion": 1, "eventName": "guardduty.finding", "severity": severity,
               "stage": STAGE, "test": sample,
               "runbook": "ops/ALARM_REGISTRY.md#security-service-change",
               "action": "Review GuardDuty findings in the AWS console.",
               "console": "https://us-west-2.console.aws.amazon.com/guardduty/home?region=us-west-2#/findings"}
    try:
        SNS.publish(TopicArn=TOPIC_ARN,
                    Subject=("[TEST] " if sample else "") + "Ian Photography: GuardDuty " + severity.upper(),
                    Message=json.dumps(message, sort_keys=True, separators=(",", ":")))
    except Exception:
        database.delete_item(TableName=table, Key=key, ConditionExpression="#t = :token",
                             ExpressionAttributeNames={"#t": "token"},
                             ExpressionAttributeValues={":token": {"S": token}})
        raise
    database.update_item(
        TableName=table, Key=key, UpdateExpression="SET #s = :sent REMOVE leaseUntil",
        ConditionExpression="#t = :token", ExpressionAttributeNames={"#s": "status", "#t": "token"},
        ExpressionAttributeValues={":sent": {"S": "sent"}, ":token": {"S": token}})
    LOG.info("guardduty_notification_forwarded count=1")
    return {"forwarded": 1}


def _check(path):
    connection = http.client.HTTPSConnection("iantruongphotography.com", timeout=5)
    try:
        connection.request("GET", path, headers={"User-Agent": "IanPhotography-Availability/1.0"})
        response = connection.getresponse()
        body = response.read(1024 * 1024)
        if path == "/":
            return response.status == 200 and b'id="root"' in body
        value = json.loads(body)
        return response.status == 200 and isinstance(value, dict) and isinstance(value.get("items"), list)
    except Exception:
        return False
    finally:
        connection.close()


def _availability():
    with ThreadPoolExecutor(max_workers=2) as pool:
        healthy = all(list(pool.map(_check, ["/", "/api/public/albums?limit=1"])))
    boto3.client("cloudwatch").put_metric_data(
        Namespace=NAMESPACE, MetricData=[{
            "MetricName": "PublicAvailabilityFailure", "Unit": "Count", "Value": 0 if healthy else 1,
            "Dimensions": [{"Name": "Stage", "Value": STAGE}],
        }])
    LOG.info("availability_check_completed healthy=%s", healthy)
    return {"healthy": healthy}


def handler(event, context):
    if event == {"schemaVersion": 1, "eventName": "availability.check", "stage": STAGE}:
        return _availability()
    records = event.get("Records", []) if isinstance(event, dict) else []
    if len(records) != 1 or not isinstance(records[0], dict):
        raise ValueError("invalid security signal batch")
    signal = _validated(records[0].get("body"))
    if signal["eventName"] == "guardduty.finding":
        return _guardduty(signal)
    SNS.publish(TopicArn=TOPIC_ARN, Message=json.dumps(signal, sort_keys=True, separators=(",", ":")))
    LOG.info("security_signal_forwarded count=1")
    return {"forwarded": 1}
