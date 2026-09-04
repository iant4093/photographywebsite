"""Generate private before previews. Google Drive is only ever read, never changed."""
import io
import json
import logging
import os
import re
import time
import uuid
import warnings

import boto3
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError
from PIL import Image, ImageCms, ImageOps

from media_access import media_id_for_key, validate_album_media_key
from original_comparison_store import comparison_table, index_state, load_snapshot
from original_drive import OriginalDrive
from original_match import build_match_index, extract_evidence, match_original, project_archive
from validation_helpers import validate_uuid

logger = logging.getLogger("photography_api.original_comparison")
Image.MAX_IMAGE_PIXELS = 100_000_000
MAX_SOURCE_BYTES = 100 * 1024 * 1024
MAX_HEADER_BYTES = 1024 * 1024
WIDTHS = (640, 960, 1440, 1920)
_index_cache = {"key": None, "index": None}


def match_index(state):
    identity = (state["indexKey"], state["rootId"])
    if _index_cache["key"] != identity:
        snapshot = load_snapshot(state)
        candidates = project_archive(snapshot["files"], snapshot["rootId"])
        _index_cache.update(key=identity, index=build_match_index(candidates))
    return _index_cache["index"]


def generate_previews(data):
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data)) as opened:
            # Canon JPEGs can carry MPF records and be identified as MPO by
            # Pillow. Their primary frame is the camera JPEG being compared.
            if (not data.startswith(b"\xff\xd8\xff") or opened.format not in {"JPEG", "MPO"}
                    or opened.width * opened.height > Image.MAX_IMAGE_PIXELS):
                raise ValueError("Original must be a bounded JPEG image")
            opened.seek(0)
            opened.load()
            normalized = ImageOps.exif_transpose(opened)
            profile = normalized.info.get("icc_profile")
            if profile:
                normalized = ImageCms.profileToProfile(
                    normalized, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                    ImageCms.createProfile("sRGB"), outputMode="RGB",
                )
            else:
                normalized = normalized.convert("RGB")
            width, height = normalized.size
            widths = sorted({min(width, value) for value in WIDTHS})
            outputs = {}
            for target in widths:
                size = (target, max(1, round(height * target / width)))
                preview = normalized.resize(size, Image.Resampling.LANCZOS)
                # Explicitly clear metadata: no camera serial, GPS, thumbnails,
                # Lightroom XMP or embedded filenames enter served previews.
                preview.info.clear()
                output = io.BytesIO()
                preview.save(output, "WEBP", quality=85, method=4, exif=b"", icc_profile=b"", xmp=b"")
                payload = output.getvalue()
                if not 0 < len(payload) <= 20 * 1024 * 1024:
                    raise ValueError("Original preview exceeds size limit")
                with Image.open(io.BytesIO(payload)) as check:
                    check.load()
                    if check.format != "WEBP" or check.size != size:
                        raise ValueError("Original preview failed validation")
                outputs[str(target)] = payload
            return width, height, outputs


def verify_live_source(drive, source):
    current = drive.file(source["id"])
    if (current.get("mimeType") != "image/jpeg" or current.get("trashed")
            or current.get("md5Checksum") != source.get("md5Checksum")
            or current.get("capabilities", {}).get("canDownload") is not True):
        raise ValueError("Original source changed or is unavailable")
    # Follow actual parent metadata, not a caller URL or an unchecked snapshot.
    pending = list(current.get("parents", []))
    seen = set()
    for _ in range(32):
        if not pending:
            break
        parent = pending.pop()
        if parent == drive.root_id:
            root = drive.file(parent)
            if root.get("mimeType") == "application/vnd.google-apps.folder" and not root.get("trashed"):
                return current
            break
        if parent in seen:
            raise ValueError("Original ancestry repeats a folder")
        seen.add(parent)
        item = drive.file(parent)
        if item.get("mimeType") != "application/vnd.google-apps.folder" or item.get("trashed"):
            raise ValueError("Original ancestry is invalid")
        pending.extend(item.get("parents", []))
    raise ValueError("Original is outside the allowed archive")


def _attribute_map(value):
    serializer = TypeSerializer()
    return {key: serializer.serialize(item) for key, item in value.items()}


def publish(album, image, record, owner):
    # The source image must still be committed to this active album. All before
    # objects are private even if deletion/visibility changes race this commit.
    boto3.client("dynamodb").transact_write_items(TransactItems=[
        {"ConditionCheck": {
            "TableName": os.environ["ALBUMS_TABLE"], "Key": _attribute_map({"albumId": album["albumId"]}),
            "ConditionExpression": ("contains(images, :image) AND (attribute_not_exists(#status) OR #status = :active) "
                                    "AND (attribute_not_exists(#type) OR #type = :photo)"),
            "ExpressionAttributeNames": {"#status": "status", "#type": "type"},
            "ExpressionAttributeValues": _attribute_map({":image": image, ":active": "active", ":photo": "photo"}),
        }},
        {"Put": {
            "TableName": os.environ["ORIGINAL_COMPARISON_TABLE"], "Item": _attribute_map(record),
            "ConditionExpression": "leaseOwner = :owner",
            "ExpressionAttributeValues": _attribute_map({":owner": owner}),
        }},
    ])


def process_job(job):
    album_id = validate_uuid(job.get("albumId"))
    albums = boto3.resource("dynamodb").Table(os.environ["ALBUMS_TABLE"])
    album = albums.get_item(Key={"albumId": album_id}, ConsistentRead=True).get("Item")
    if not album or album.get("status", "active") != "active" or album.get("type", "photo") != "photo":
        return "skipped"
    raw_key = validate_album_media_key(job.get("rawKey"), album=album)
    image = next((item for item in album.get("images", []) if isinstance(item, dict)
                  and (item.get("rawKey") or item.get("key")) == raw_key), None)
    if image is None:
        return "skipped"
    media_id = media_id_for_key(raw_key)
    key = {"albumId": album_id, "mediaId": media_id}
    table = comparison_table()
    owner = uuid.uuid4().hex
    now = int(time.time())
    try:
        response = table.update_item(
            Key=key, UpdateExpression=("SET leaseOwner = :owner, leaseUntil = :until, "
                                       "rawKey = :raw, #status = if_not_exists(#status, :pending)"),
            ConditionExpression="attribute_not_exists(leaseUntil) OR leaseUntil < :now",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":owner": owner, ":until": now + 360, ":now": now,
                                       ":raw": raw_key, ":pending": "pending"}, ReturnValues="ALL_NEW",
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return "busy"
        raise
    previous = response.get("Attributes", {})
    record = {**key, "rawKey": raw_key, "schemaVersion": 1, "updatedAt": now, "status": "pending"}
    try:
        state = index_state()
        if not state.get("indexKey"):
            publish(album, image, record, owner)
            return "pending"
        s3 = boto3.client("s3")
        header = s3.get_object(Bucket=os.environ["IMAGES_BUCKET"], Key=raw_key,
                               Range=f"bytes=0-{MAX_HEADER_BYTES - 1}")
        try:
            data = header["Body"].read(MAX_HEADER_BYTES + 1)
        finally:
            header["Body"].close()
        if len(data) > MAX_HEADER_BYTES:
            raise ValueError("Photo header exceeds processing limit")
        evidence = extract_evidence(data, image.get("originalFilename") or raw_key.rsplit("/", 1)[-1])
        record.update(evidence=evidence, websiteEtag=header.get("ETag", ""), indexGeneration=state["generation"])
        match = match_original(evidence, match_index(state))
        if match["status"] != "matched":
            record["status"] = "ambiguous" if match["status"] == "ambiguous" else "unavailable"
            publish(album, image, record, owner)
            return record["status"]
        source = match["source"]
        checksum = str(source.get("md5Checksum", ""))
        if not re.fullmatch(r"[a-fA-F0-9]{32}", checksum):
            raise ValueError("Original checksum is unavailable")
        checksum = checksum.lower()
        if (previous.get("status") == "ready" and previous.get("sourceChecksum") == checksum
                and previous.get("sourceFileId") == source["id"] and previous.get("websiteEtag") == record["websiteEtag"]):
            # Repeated queue delivery and later index generations reuse immutable outputs.
            keep = {k: v for k, v in previous.items() if k not in {"leaseOwner", "leaseUntil"}}
            keep.update(indexGeneration=state["generation"], updatedAt=now)
            publish(album, image, keep, owner)
            return "ready"
        drive = OriginalDrive.from_environment()
        if drive.root_id != state["rootId"]:
            raise ValueError("Original archive root changed")
        verify_live_source(drive, source)
        original = drive.download(source["id"], MAX_SOURCE_BYTES, expected_md5=checksum)
        width, height, outputs = generate_previews(original)
        previews = {}
        for target, payload in outputs.items():
            output_key = f"before/{album_id}/{media_id}/{checksum}/w{target}.webp"
            # Never overwrite an existing derivative. A source replacement gets
            # a different checksum namespace. No existing website originals touched.
            try:
                s3.put_object(Bucket=os.environ["ORIGINAL_PREVIEW_BUCKET"], Key=output_key,
                              Body=payload, ContentType="image/webp", CacheControl="private, max-age=1800",
                              ServerSideEncryption="AES256", IfNoneMatch="*")
            except ClientError as error:
                if error.response.get("Error", {}).get("Code") not in {"PreconditionFailed", "412"}:
                    raise
            previews[target] = output_key
        current = s3.head_object(Bucket=os.environ["IMAGES_BUCKET"], Key=raw_key)
        if current.get("ETag") != record["websiteEtag"]:
            raise ValueError("Edited photo changed during comparison processing")
        record.update(status="ready", sourceFileId=source["id"], sourceChecksum=checksum,
                      sourceRevision=str(source.get("version", "")), matchMethod=match.get("method", "filename_time_camera"),
                      width=width, height=height, previews=previews)
        publish(album, image, record, owner)
        return "ready"
    except Exception:
        # Preserve a retryable failure instead of misreporting a provider outage
        # as a missing original. No source paths/provider errors enter logs.
        try:
            table.update_item(
                Key=key, UpdateExpression="SET #status = :failed, updatedAt = :now REMOVE leaseOwner, leaseUntil",
                ConditionExpression="leaseOwner = :owner",
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues={":failed": "failed", ":now": now, ":owner": owner},
            )
        except ClientError:
            pass
        raise


def handler(event, context):
    failures = []
    for message in event.get("Records", []):
        try:
            status = process_job(json.loads(message["body"]))
            logger.info("original_comparison_completed status=%s", status)
        except Exception as error:
            logger.error("original_comparison_failed error_type=%s", type(error).__name__)
            failures.append({"itemIdentifier": message["messageId"]})
    return {"batchItemFailures": failures}
