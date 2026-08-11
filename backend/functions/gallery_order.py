"""Read and apply the administrator-defined public photo gallery order."""

from botocore.exceptions import ClientError


SETTING_ID = "public-photo-gallery-order"


def load_gallery_order(settings_table, logger=None):
    """Return album-id positions, failing open to the alphabetical UI default."""
    try:
        item = settings_table.get_item(
            Key={"settingId": SETTING_ID},
            ConsistentRead=False,
            ProjectionExpression="albumIds",
        ).get("Item", {})
    except ClientError:
        if logger:
            logger.warning("gallery_order_unavailable")
        return {}

    album_ids = item.get("albumIds", [])
    if not isinstance(album_ids, list):
        if logger:
            logger.warning("gallery_order_invalid")
        return {}

    positions = {}
    for album_id in album_ids:
        if isinstance(album_id, str) and album_id and album_id not in positions:
            positions[album_id] = len(positions)
    return positions


def apply_gallery_order(summary, positions):
    """Attach an order only to public photo summaries present in the setting."""
    album_id = summary.get("albumId")
    if summary.get("type", "photo") == "photo" and album_id in positions:
        summary["galleryOrder"] = positions[album_id]
    return summary
