"""Photo-only, best-effort dispatch; scheduled reconciliation repairs missed sends."""
from concurrent.futures import ThreadPoolExecutor

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
    if not keys:
        return 0
    # Create low-level clients before starting threads. Boto3 resources and
    # sessions are not thread-safe; clients can share their connection pools.
    client = boto3.client("sqs")
    table_name = os.environ.get("ORIGINAL_COMPARISON_TABLE", "").strip()
    marker_client = boto3.client("dynamodb") if table_name else None
    queued_until = str(int(time.time()) + 86400)

    def dispatch(batch):
        response = client.send_message_batch(QueueUrl=queue, Entries=[
            {"Id": str(index), "MessageBody": json.dumps({"albumId": album_id, "rawKey": key})}
            for index, key in enumerate(batch)
        ])
        if response.get("Failed"):
            raise RuntimeError("Original comparison dispatch was incomplete")
        # Preserve the conditional marker: a fast worker's completed record
        # must never be replaced by this enqueue operation.
        if marker_client is not None:
            from media_access import media_id_for_key
            for success in response.get("Successful", []):
                raw_key = batch[int(success["Id"])]
                try:
                    marker_client.update_item(
                        TableName=table_name,
                        Key={"albumId": {"S": album_id}, "mediaId": {"S": media_id_for_key(raw_key)}},
                        UpdateExpression=("SET queuedUntil = :until, rawKey = :raw, "
                                          "#status = if_not_exists(#status, :pending)"),
                        ConditionExpression="attribute_not_exists(#status) OR #status = :pending",
                        ExpressionAttributeNames={"#status": "status"},
                        ExpressionAttributeValues={":until": {"N": queued_until},
                                                   ":raw": {"S": raw_key}, ":pending": {"S": "pending"}},
                    )
                except ClientError as error:
                    if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                        logger.error("original_queue_marker_failed error_type=%s", type(error).__name__)
        return len(response.get("Successful", []))

    batches = [keys[offset:offset + 10] for offset in range(0, len(keys), 10)]
    # Same SQS/DynamoDB operations, at most eight outstanding requests. Join
    # before returning: Lambda may freeze threads as soon as a handler returns.
    with ThreadPoolExecutor(max_workers=min(8, len(batches))) as executor:
        return sum(executor.map(dispatch, batches))


def request_original_comparisons(album_id, images):
    try:
        return enqueue_original_comparisons(album_id, images)
    except Exception as error:
        # Provider exception text can contain object names. Scheduled inventory
        # reconciliation will discover these committed images even if dispatch fails.
        logger.error("original_comparison_dispatch_failed error_type=%s", type(error).__name__)
        return 0
