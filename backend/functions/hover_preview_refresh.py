"""Cheap, coalescible requests to rebuild one album hover-preview manifest."""

import json
import logging
import os

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from validation_helpers import validate_uuid


logger = logging.getLogger("photography_api.hover_preview_refresh")
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


def request_hover_preview_refresh(album_id):
    album_id = validate_uuid(album_id)
    queue_url = os.environ.get("HOVER_PREVIEW_REFRESH_QUEUE_URL", "").strip()
    if not queue_url:
        return False
    try:
        _client().send_message(
            QueueUrl=queue_url,
            DelaySeconds=5,
            MessageBody=json.dumps(
                {"version": 1, "albumId": album_id},
                separators=(",", ":"),
            ),
        )
        return True
    except (BotoCoreError, ClientError) as error:
        # The current album-detail hover path remains the rollout fallback.
        # An auxiliary queue outage must not make an album edit look uncommitted.
        logger.error(
            "hover_preview_refresh_dispatch_failed error_type=%s",
            type(error).__name__,
        )
        return False


def reset_hover_preview_refresh_client_for_tests():
    global _sqs
    _sqs = None
