"""Recently Deleted: albums hidden for a while before permanent deletion.

Moving an album to the bin is an ordinary visibility change to link-only with
sharing off, which revokes public, client and shared-link access through the
durable privacy transition. The album keeps ``trashedAt`` and ``trashedFrom``
(its previous visibility, owner and share link) so it can be restored. A
time-keyed index item in the gallery settings table lets the daily purge find
albums whose time is up without scanning; the album row stays authoritative.
"""

import datetime

import scheduled_publish
from validation_helpers import ALLOWED_VISIBILITIES


INDEX = {"settingId": "recently-deleted"}
RETENTION = datetime.timedelta(days=30)
SNAPSHOT_FIELDS = ("visibility", "ownerEmail", "ownerSub", "isShared", "shareCode")


def record(album_id, trashed_at):
    scheduled_publish.record(album_id, trashed_at, index=INDEX)


def forget(album_id, trashed_at=None):
    scheduled_publish.forget(album_id, trashed_at, index=INDEX)


def expired(now=None):
    """Albums binned at least the retention period ago, oldest first."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return scheduled_publish.due(now - RETENTION, index=INDEX)


def purge_after(trashed_at):
    return scheduled_publish.format_time(scheduled_publish.parse_time(trashed_at) + RETENTION)


def trashed(album, now=None):
    """The album as moved to the bin (unchanged if it is already there)."""
    if album.get("trashedAt"):
        return dict(album)
    updated = dict(album)
    updated["trashedFrom"] = {
        field: album[field] for field in SNAPSHOT_FIELDS if album.get(field) not in (None, "")
    }
    updated["trashedAt"] = scheduled_publish.format_time(now or datetime.datetime.now(datetime.timezone.utc))
    updated["visibility"] = "unlisted"
    updated["isShared"] = False
    if "ownerEmail" in album:
        updated["ownerEmail"] = ""
    for field in ("ownerSub", "shareCode", "publishAt"):
        updated.pop(field, None)
    return updated


def restored(album, new_share_code):
    """The album with its previous access (unchanged if it is not in the bin)."""
    snapshot = album.get("trashedFrom")
    if not album.get("trashedAt"):
        return dict(album)
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    updated = dict(album)
    updated.pop("trashedAt", None)
    updated.pop("trashedFrom", None)
    visibility = snapshot.get("visibility")
    if visibility not in ALLOWED_VISIBILITIES:
        visibility = "unlisted"
    if visibility == "private" and not (snapshot.get("ownerSub") and snapshot.get("ownerEmail")):
        # Without a complete owner the safest restore keeps the album hidden.
        visibility = "unlisted"
    updated["visibility"] = visibility
    if visibility == "private":
        updated["ownerEmail"] = snapshot["ownerEmail"]
        updated["ownerSub"] = snapshot["ownerSub"]
    if visibility == "unlisted" and snapshot.get("isShared") is True:
        updated["isShared"] = True
        updated["shareCode"] = snapshot.get("shareCode") or new_share_code()
    else:
        updated["isShared"] = False
        updated.pop("shareCode", None)
    return updated
