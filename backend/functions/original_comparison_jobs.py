"""Photo-only, best-effort dispatch; scheduled reconciliation repairs missed sends."""
import json
import logging
import os
import time

import boto3
from botocore.exceptions import ClientError

from validation_helpers import validate_uuid

logger = logging.getLogger("photography_api.original_comparison")


def enqueue_original_comparisons(album_id, images):
    queue = os.environ.get("ORIGINAL_COMPARISON_QUEUE_URL", "").strip()
    if not queue:
        return 0
    album_id = validate_uuid(album_id)
    keys = sorted({image.get("rawKey") or image.get("key") for image in images or []
                   if isinstance(image, dict) and (image.get("rawKey") or image.get("key"))})
    client = boto3.client("sqs")
    sent = 0
    for offset in range(0, len(keys), 10):
        response = client.send_message_batch(QueueUrl=queue, Entries=[
            {"Id": str(index), "MessageBody": json.dumps({"albumId": album_id, "rawKey": key})}
            for index, key in enumerate(keys[offset:offset + 10])
        ])
        if response.get("Failed"):
            raise RuntimeError("Original comparison dispatch was incomplete")
        sent += len(response.get("Successful", []))
        # A long initial backfill can span many reconciliation intervals. Mark
        # accepted jobs without overwriting a worker's completed record; a failed
        # marker write is harmless and the worker remains idempotent.
        table_name = os.environ.get("ORIGINAL_COMPARISON_TABLE", "").strip()
        if table_name:
            from media_access import media_id_for_key
            table = boto3.resource("dynamodb").Table(table_name)
            for success in response.get("Successful", []):
                raw_key = keys[offset + int(success["Id"])]
                try:
                    table.update_item(
                        Key={"albumId": album_id, "mediaId": media_id_for_key(raw_key)},
                        UpdateExpression=("SET queuedUntil = :until, rawKey = :raw, "
                                          "#status = if_not_exists(#status, :pending)"),
                        ConditionExpression="attribute_not_exists(#status) OR #status = :pending",
                        ExpressionAttributeNames={"#status": "status"},
                        ExpressionAttributeValues={":until": int(time.time()) + 86400,
                                                   ":raw": raw_key, ":pending": "pending"},
                    )
                except ClientError as error:
                    if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                        logger.error("original_queue_marker_failed error_type=%s", type(error).__name__)
    return sent


def request_original_comparisons(album_id, images):
    try:
        return enqueue_original_comparisons(album_id, images)
    except Exception as error:
        # Provider exception text can contain object names. Scheduled inventory
        # reconciliation will discover these committed images even if dispatch fails.
        logger.error("original_comparison_dispatch_failed error_type=%s", type(error).__name__)
        return 0
