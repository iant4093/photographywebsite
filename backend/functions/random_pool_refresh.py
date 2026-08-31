"""Cheap, coalescible refresh requests for materialized random-photo decks."""

import json
import logging
import os

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


logger = logging.getLogger("photography_api.random_pool_refresh")
_sqs = None


def _client():
    global _sqs
    if _sqs is None:
        _sqs = boto3.client(
            "sqs",
            config=Config(
                connect_timeout=2,
                read_timeout=4,
                retries={"mode": "standard", "max_attempts": 2},
            ),
        )
    return _sqs


def request_random_photo_pool_refresh():
    queue_url = os.environ.get("RANDOM_PHOTO_REFRESH_QUEUE_URL", "").strip()
    if not queue_url:
        # During a rolling deployment the existing DynamoDB stream remains the
        # compatibility trigger until CloudFormation installs the queue event.
        return False
    try:
        _client().send_message(
            QueueUrl=queue_url,
            DelaySeconds=10,
            MessageBody=json.dumps({"version": 1, "refresh": True}, separators=(",", ":")),
        )
        return True
    except (BotoCoreError, ClientError) as error:
        logger.error("random_pool_refresh_dispatch_failed error_type=%s", type(error).__name__)
        return False


def reset_random_pool_refresh_client_for_tests():
    global _sqs
    _sqs = None
