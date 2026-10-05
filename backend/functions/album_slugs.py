"""Readable public album URLs: /album/prague-2026 instead of /album/<uuid>.

Each slug is claimed once, forever, by one album: an item
``album-slug#<slug>`` in GallerySettingsTable holds its albumId, written
with a condition so two albums can never share one. Albums with the same
title get ``prague``, ``prague-2``, ``prague-3`` (the oldest album keeps the
plain name, since the sweep runs oldest first). The album record carries its
``slug`` for every API response, and ``album-slugs`` maps albumId -> slug so
the five-minute sweep can tell which public albums still need one without
reading full album records.

A slug never changes once given, so shared links keep working if the album
is renamed, and an album that leaves the public gallery and comes back keeps
its URL. Old /album/<uuid> links keep working too; the site redirects them.
"""

from __future__ import annotations

import logging
import os
import re
import unicodedata

import boto3
from botocore.exceptions import ClientError


logger = logging.getLogger("photography_api.album_slugs")

SLUG_PREFIX = "album-slug#"
MAP_KEY = {"settingId": "album-slugs"}
MAX_LENGTH = 60
MAX_SUFFIX = 50
SWEEP_LIMIT = 10
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

_settings_table = None


def _settings():
    global _settings_table
    if _settings_table is None:
        _settings_table = boto3.resource("dynamodb").Table(os.environ["GALLERY_SETTINGS_TABLE"])
    return _settings_table


def is_slug(value):
    return isinstance(value, str) and 0 < len(value) <= MAX_LENGTH + 8 and bool(SLUG_RE.match(value)) and not UUID_RE.match(value)


def slugify(title):
    """'Day 2 - Prague Castle, Walkaround, & Sunset' -> 'day-2-prague-castle-walkaround-sunset'."""
    text = unicodedata.normalize("NFKD", str(title or "")).encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"['’]", "", text)
    slug = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    if len(slug) > MAX_LENGTH:
        cut = slug[:MAX_LENGTH + 1]
        slug = cut.rsplit("-", 1)[0] if "-" in cut[:MAX_LENGTH] else slug[:MAX_LENGTH]
        slug = slug.strip("-")
    if not slug:
        slug = "album"
    # Never look like an album id, which the routes read as one.
    return f"{slug}-album" if UUID_RE.match(slug) else slug


def candidates(title, album_id):
    base = slugify(title)
    yield base
    for number in range(2, MAX_SUFFIX + 1):
        yield f"{base}-{number}"
    yield f"{base}-{str(album_id).replace('-', '')[:8].lower()}"


def _claim(slug, album_id):
    """True when this album now holds the slug (or already did)."""
    try:
        _settings().update_item(
            Key={"settingId": f"{SLUG_PREFIX}{slug}"},
            UpdateExpression="SET albumId = :album",
            ConditionExpression="attribute_not_exists(settingId) OR albumId = :album",
            ExpressionAttributeValues={":album": album_id},
        )
        return True
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise


def _remember(album_id, slug):
    table = _settings()
    table.update_item(
        Key=MAP_KEY,
        UpdateExpression="SET albums = if_not_exists(albums, :empty)",
        ExpressionAttributeValues={":empty": {}},
    )
    table.update_item(
        Key=MAP_KEY,
        UpdateExpression="SET albums.#album = :slug",
        ExpressionAttributeNames={"#album": album_id},
        ExpressionAttributeValues={":slug": slug},
    )


def assign(albums_table, album):
    """Give a public album its slug if it has none; returns the slug (or None).

    The claim is written before the album record, and the album record stays
    authoritative: a claim whose album later took a different slug in a race
    still resolves to the right album, which redirects to its own slug.
    """
    album_id = album.get("albumId")
    if not isinstance(album_id, str) or not album_id:
        return None
    if is_slug(album.get("slug")):
        return album["slug"]
    for slug in candidates(album.get("title"), album_id):
        if not _claim(slug, album_id):
            continue
        try:
            albums_table.update_item(
                Key={"albumId": album_id},
                UpdateExpression="SET slug = :slug",
                ConditionExpression="attribute_exists(albumId) AND attribute_not_exists(slug)",
                ExpressionAttributeValues={":slug": slug},
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            # Another writer gave it a slug first (or it was deleted); keep theirs.
            current = albums_table.get_item(Key={"albumId": album_id}).get("Item") or {}
            slug = current.get("slug") if is_slug(current.get("slug")) else None
        if slug:
            _remember(album_id, slug)
        return slug
    return None


def assign_quietly(albums_table, album):
    """Best effort after an album edit: a missing slug never fails the edit."""
    if not isinstance(album, dict) or album.get("visibility") != "public" or album.get("status", "active") != "active":
        return None
    try:
        return assign(albums_table, album)
    except Exception as error:
        logger.warning("album_slug_assign_failed error_type=%s", type(error).__name__)
        return None


def resolve(slug):
    """The albumId a slug was claimed by, or None."""
    if not is_slug(slug):
        return None
    item = _settings().get_item(Key={"settingId": f"{SLUG_PREFIX}{slug}"}).get("Item")
    album_id = item.get("albumId") if isinstance(item, dict) else None
    return album_id if isinstance(album_id, str) and UUID_RE.match(album_id) else None


def sweep(albums_table, *, limit=SWEEP_LIMIT):
    """Assign slugs to public albums that lack one, oldest first.

    Reads only the public summary index and the small albumId -> slug map,
    so it is cheap to run every five minutes. Returns how many it assigned.
    """
    index = os.environ.get("PUBLIC_SUMMARY_INDEX", "")
    if not index:
        return 0
    mapping = (_settings().get_item(Key=MAP_KEY).get("Item") or {}).get("albums") or {}
    assigned = 0
    start_key = None
    while assigned < limit:
        arguments = {
            "IndexName": index,
            "KeyConditionExpression": "visibility = :public",
            "ExpressionAttributeValues": {":public": "public"},
            "ProjectionExpression": "albumId, title, #status",
            "ExpressionAttributeNames": {"#status": "status"},
            "ScanIndexForward": True,
        }
        if start_key:
            arguments["ExclusiveStartKey"] = start_key
        page = albums_table.query(**arguments)
        for summary in page.get("Items", []):
            album_id = summary.get("albumId")
            if not isinstance(album_id, str) or album_id in mapping or summary.get("status", "active") != "active":
                continue
            # The summary index lacks the slug; read the record before naming it.
            album = albums_table.get_item(Key={"albumId": album_id}).get("Item")
            if not album or album.get("visibility") != "public":
                continue
            slug = album.get("slug") if is_slug(album.get("slug")) else assign(albums_table, album)
            if is_slug(album.get("slug")):
                _remember(album_id, slug)
            if slug:
                mapping[album_id] = slug
                assigned += 1
            if assigned >= limit:
                break
        start_key = page.get("LastEvaluatedKey")
        if not start_key:
            break
    return assigned
