"""Scheduled publishing: hidden albums that move to the main gallery at a set time.

An album waiting to be published stays link-only with sharing off and carries
``publishAt``. A small index record in the gallery settings table maps album
IDs to their times, so the frequent publish check reads one item instead of
scanning albums. The album attribute is authoritative: an index entry is
written before the album and an entry that no longer matches its album is
simply dropped by the publisher.
"""

import datetime
import os

import boto3
from botocore.exceptions import ClientError

from validation_helpers import ValidationError


INDEX_KEY = {"settingId": "scheduled-publishing"}
MAX_AHEAD = datetime.timedelta(days=366)

_table = None


def _settings():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["GALLERY_SETTINGS_TABLE"])
    return _table


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def format_time(moment):
    return moment.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValidationError("publishAt must be an ISO-8601 timestamp")
    try:
        moment = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValidationError("publishAt must be an ISO-8601 timestamp") from None
    if moment.tzinfo is None:
        raise ValidationError("publishAt must include a time zone")
    return moment.astimezone(datetime.timezone.utc).replace(microsecond=0)


def validate_publish_at(value, now=None):
    """Return the normalized UTC time. A time that has already passed is kept:
    an upload can finish after its time, and the album then publishes on the
    next check."""
    moment = parse_time(value)
    if moment > (now or _now()) + MAX_AHEAD:
        raise ValidationError("publishAt must be within a year")
    return format_time(moment)


def record(album_id, publish_at, *, index=INDEX_KEY):
    """Set an album's time in a time-keyed index item (also used by the bin)."""
    table = _settings()
    table.update_item(
        Key=index,
        UpdateExpression="SET albums = if_not_exists(albums, :empty)",
        ExpressionAttributeValues={":empty": {}},
    )
    table.update_item(
        Key=index,
        UpdateExpression="SET albums.#album = :at",
        ExpressionAttributeNames={"#album": album_id},
        ExpressionAttributeValues={":at": publish_at},
    )


def forget(album_id, publish_at=None, *, index=INDEX_KEY):
    """Drop an entry; with ``publish_at``, only while it still holds that time."""
    request = {
        "Key": index,
        "UpdateExpression": "REMOVE albums.#album",
        "ExpressionAttributeNames": {"#album": album_id},
        "ConditionExpression": "attribute_exists(albums.#album)",
    }
    if publish_at is not None:
        request["ConditionExpression"] = "albums.#album = :at"
        request["ExpressionAttributeValues"] = {":at": publish_at}
    try:
        _settings().update_item(**request)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise


def due(now=None, *, index=INDEX_KEY):
    """Entries whose time has come, earliest first."""
    item = _settings().get_item(Key=index, ConsistentRead=True).get("Item") or {}
    limit = format_time(now or _now())
    entries = [
        (at, album_id) for album_id, at in (item.get("albums") or {}).items()
        if isinstance(at, str) and at <= limit
    ]
    return [(album_id, at) for at, album_id in sorted(entries)]
