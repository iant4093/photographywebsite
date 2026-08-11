"""Read and apply administrator-defined public photo gallery presentation order."""

from botocore.exceptions import ClientError


SETTING_ID = "public-photo-gallery-order"


def _positions(values):
    if not isinstance(values, list):
        return None
    positions = {}
    for value in values:
        if isinstance(value, str) and value and value not in positions:
            positions[value] = len(positions)
    return positions


def load_gallery_settings(settings_table, logger=None):
    """Return album/category positions, failing open to client-side defaults."""
    try:
        item = settings_table.get_item(
            Key={"settingId": SETTING_ID},
            ConsistentRead=False,
            ProjectionExpression="albumIds, categoryNames",
        ).get("Item", {})
    except ClientError:
        if logger:
            logger.warning("gallery_order_unavailable")
        return {}, {}

    album_positions = _positions(item.get("albumIds", []))
    category_positions = _positions(item.get("categoryNames", []))
    if album_positions is None or category_positions is None:
        if logger:
            logger.warning("gallery_order_invalid")
        return album_positions or {}, category_positions or {}
    return album_positions, category_positions


def apply_gallery_order(summary, album_positions, category_positions):
    """Attach configured presentation positions to a public photo summary."""
    album_id = summary.get("albumId")
    if summary.get("type", "photo") != "photo":
        return summary
    if album_id in album_positions:
        summary["galleryOrder"] = album_positions[album_id]
    category = summary.get("category") or "Uncategorized"
    if category in category_positions:
        summary["galleryCategoryOrder"] = category_positions[category]
    return summary
