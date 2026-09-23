"""Resume committed upload work without appending or uploading media again."""
import json
import os

import boto3
import drive_backup_jobs
from album_media_store import finish_media_sync
from cache_invalidation import request_public_api_invalidation
from media_access import album_known_keys, tag_keys_visibility
from original_comparison_jobs import enqueue_original_comparisons
from preview_jobs import enqueue_preview_jobs
from random_pool_refresh import request_random_photo_pool_refresh


def complete(table, album):
    album_id = album["albumId"]
    if album.get("mediaStoreDirty"):
        if not finish_media_sync(table, album, album.get("images", []), lambda: False):
            raise RuntimeError("Media records still need synchronization")
        album.pop("mediaStoreDirty", None)
        album["mediaStoreVersion"] = 1
    pending = album.get("pendingMediaUpload")
    if not pending:
        return
    requested = set(pending["keys"])
    images = [image for image in album.get("images", []) if isinstance(image, dict)
              and (image.get("rawKey") or image.get("key")) in requested]

    def run(stage, operation):
        if stage in pending.get("done", []):
            return
        operation()
        pending.setdefault("done", []).append(stage)
        table.update_item(
            Key={"albumId": album_id},
            UpdateExpression="SET pendingMediaUpload = :pending",
            ConditionExpression="attribute_exists(albumId) AND pendingMediaUpload.id = :id",
            ExpressionAttributeValues={":pending": pending, ":id": pending["id"]},
        )

    run("tags", lambda: tag_keys_visibility(album_known_keys({**album, "images": images}), album["visibility"]))
    if album.get("type", "photo") == "photo" and images:
        run("comparisons", lambda: enqueue_original_comparisons(album_id, images))
        run("previews", lambda: enqueue_preview_jobs(album_id, images))

    if album.get("backupToGoogleDrive") is True and not drive_backup_jobs.state_table() and os.environ.get("GOOGLE_DRIVE_SYNC_FUNCTION_NAME"):
        def backup():
            response = boto3.client("lambda").invoke(
                FunctionName=os.environ["GOOGLE_DRIVE_SYNC_FUNCTION_NAME"], InvocationType="Event",
                Payload=json.dumps({"albumId": album_id, "albumType": album.get("type", "photo"),
                                    "albumTitle": album.get("title", "Album"), "bucket": os.environ["IMAGES_BUCKET"],
                                    "keys": [image["rawKey"] for image in images]}),
            )
            if response.get("StatusCode") != 202:
                raise RuntimeError("Drive dispatch was not accepted")
        run("drive", backup)
    if album.get("visibility") == "public":
        def invalidate():
            if not request_public_api_invalidation(album_id=album_id, catalog=True, reason="album-media-added"):
                raise RuntimeError("Catalog refresh was not accepted")
        run("catalog", invalidate)
        if album.get("type", "photo") == "photo" and os.environ.get("RANDOM_PHOTO_REFRESH_QUEUE_URL"):
            def refresh():
                if not request_random_photo_pool_refresh():
                    raise RuntimeError("Photo refresh was not accepted")
            run("random", refresh)
    table.update_item(
        Key={"albumId": album_id}, UpdateExpression="REMOVE pendingMediaUpload",
        ConditionExpression="attribute_exists(albumId) AND pendingMediaUpload.id = :id",
        ExpressionAttributeValues={":id": pending["id"]},
    )
    album.pop("pendingMediaUpload", None)
