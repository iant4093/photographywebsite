"""Read and apply administrator-defined public gallery presentation order."""

from botocore.exceptions import ClientError


SETTING_ID = "public-photo-gallery-order"
ORDER_FIELDS = {
    "photo": ("albumIds", "categoryNames"),
    "video": ("videoAlbumIds", "videoCategoryNames"),
}


def _positions(values):
    if not isinstance(values, list):
        return None
    positions = {}
    for value in values:
        if isinstance(value, str) and value and value not in positions:
            positions[value] = len(positions)
    return positions


def load_gallery_settings(settings_table, logger=None):
    """Return photo/video positions with one eventually consistent table read."""
    try:
        item = settings_table.get_item(
            Key={"settingId": SETTING_ID},
            ConsistentRead=False,
            ProjectionExpression=(
                "albumIds, categoryNames, videoAlbumIds, videoCategoryNames"
            ),
        ).get("Item", {})
    except ClientError:
        if logger:
            logger.warning("gallery_order_unavailable")
        return {}

    settings = {}
    invalid = False
    for album_type, (album_field, category_field) in ORDER_FIELDS.items():
        album_positions = _positions(item.get(album_field, []))
        category_positions = _positions(item.get(category_field, []))
        if album_positions is None or category_positions is None:
            invalid = True
        settings[album_type] = {
            "albums": album_positions or {},
            "categories": category_positions or {},
        }
    if invalid and logger:
        logger.warning("gallery_order_invalid")
    return settings


def apply_gallery_order(summary, settings):
    """Attach configured positions for the summary's own photo/video gallery."""
    album_type = summary.get("type", "photo")
    positions = settings.get(album_type, {}) if isinstance(settings, dict) else {}
    album_positions = positions.get("albums", {})
    category_positions = positions.get("categories", {})
    if not isinstance(album_positions, dict) or not isinstance(category_positions, dict):
        return summary
    album_id = summary.get("albumId")
    if album_id in album_positions:
        summary["galleryOrder"] = album_positions[album_id]
    category = summary.get("category") or "Uncategorized"
    if category in category_positions:
        summary["galleryCategoryOrder"] = category_positions[category]
    return summary
