"""Shared create/append media preparation, without HTTP or album-table clients."""
import concurrent.futures
import decimal
import os
import re

from media_access import validate_album_media_key
from media_helpers import extract_exif_data, hls_destination_prefix, hls_master_playlist_key, start_mediaconvert_job
from hls_ladder import SCRUB_FRAMES, scrub_frames_prefix
from validation_helpers import ValidationError, validate_list, require_string


def normalize_images(value, album_id, album_type, *, album=None):
    maximum = 50 if album_type == "video" else 500
    images = validate_list(value, "images", maximum=maximum, required=True)
    normalized = []
    for index, image in enumerate(images):
        if not isinstance(image, dict):
            raise ValidationError(f"images[{index}] must be an object")
        key_scope = {"album": album} if album is not None else {"album_id": album_id}
        raw_key = validate_album_media_key(image.get("rawKey") or image.get("key"), **key_scope)
        thumb_key = image.get("thumbKey")
        if thumb_key:
            thumb_key = validate_album_media_key(thumb_key, **key_scope)
        item = {"rawKey": raw_key}
        if album_type == "photo" and image.get("originalFilename") is not None:
            filename = image["originalFilename"]
            if not isinstance(filename, str) or len(filename) > 4096:
                raise ValidationError(f"images[{index}].originalFilename must be a filename")
            # Keep the camera/export filename separately; storage keys stay random.
            filename = filename.replace("\\", "/").rsplit("/", 1)[-1]
            filename = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", filename).strip()[:255]
            if filename and filename not in {".", ".."}:
                item["originalFilename"] = filename
        if thumb_key:
            item["thumbKey"] = thumb_key
        for dimension in ("width", "height"):
            if image.get(dimension) is not None:
                try:
                    number = int(image[dimension])
                except (TypeError, ValueError):
                    raise ValidationError(f"images[{index}].{dimension} must be an integer") from None
                if number < 1 or number > 100000:
                    raise ValidationError(f"images[{index}].{dimension} is out of range")
                item[dimension] = number
        if image.get("blurhash"):
            item["blurhash"] = require_string(image["blurhash"], f"images[{index}].blurhash", maximum=200)
        if album_type == "video":
            item["hlsUrl"] = hls_master_playlist_key(raw_key)
            if image.get("thumbnailTime") is not None:
                try:
                    numeric_time = max(0, min(float(image["thumbnailTime"]), 86400))
                    item["thumbnailTime"] = decimal.Decimal(str(numeric_time))
                except (TypeError, ValueError):
                    raise ValidationError(f"images[{index}].thumbnailTime must be numeric") from None
        normalized.append(item)
    return normalized


def extract_exif(images, extractor=extract_exif_data):
    bucket = os.environ["IMAGES_BUCKET"]

    def extract(image):
        try:
            result = extractor(bucket, image["rawKey"])
            if result:
                image["exif"] = result
        except Exception:
            # EXIF is optional; never log the client object key.
            return

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(images))) as executor:
        list(executor.map(extract, images))


def start_video_jobs(images, submit=start_mediaconvert_job):
    bucket = os.environ["IMAGES_BUCKET"]
    for image in images:
        raw_key = image["rawKey"]
        try:
            image["mediaConvertJobId"] = submit(
                f"s3://{bucket}/{raw_key}",
                f"s3://{bucket}/{hls_destination_prefix(raw_key)}",
                width=image.get("width"),
                height=image.get("height"),
                frames_s3_prefix=f"s3://{bucket}/{scrub_frames_prefix(raw_key)}",
            )
            # A retried upload may have an old rendition URL or no URL after a
            # failed submission. Only newly submitted jobs switch to the master.
            image["hlsUrl"] = hls_master_playlist_key(raw_key)
            image["scrubFrames"] = dict(SCRUB_FRAMES)
        except Exception:
            # Keep the raw protected video usable if transcoding is unavailable.
            image.pop("hlsUrl", None)
