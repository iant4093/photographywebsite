"""Conservative DynamoDB item-size guardrails for album manifests."""

import json
import os

from boto3.dynamodb.types import TypeSerializer

from validation_helpers import ValidationError


_serializer = TypeSerializer()


def album_item_budget_bytes():
    try:
        configured = int(os.environ.get("ALBUM_ITEM_BUDGET_BYTES", str(350 * 1024)))
    except ValueError:
        configured = 350 * 1024
    # DynamoDB's hard limit is 400 KiB. Keep a meaningful safety margin for
    # attribute names, encoding overhead, and future schema additions.
    return max(64 * 1024, min(configured, 350 * 1024))


def estimated_item_bytes(item):
    encoded = _serializer.serialize(item)
    return len(json.dumps(encoded, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def ensure_album_item_budget(item):
    if estimated_item_bytes(item) > album_item_budget_bytes():
        raise ValidationError("Album metadata is too large; split the media into multiple albums")
