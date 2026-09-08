"""Build immutable album ZIPs from a FIFO queue, with bounded memory and I/O."""

from concurrent.futures import ThreadPoolExecutor
import io
import json
import logging
import os
import posixpath
import time
import zipfile

import boto3
from botocore.config import Config

from album_access import authorize_album
from media_access import bucket_name, validate_album_media_key
from validation_helpers import ValidationError, validate_uuid
from zip_helpers import archive_entries, get_album_record, zip_keys, zip_version
from zip_jobs import object_metadata


logger = logging.getLogger("photography_api.zip_worker")
s3 = boto3.client("s3", config=Config(
    connect_timeout=5, read_timeout=30, max_pool_connections=12,
    retries={"mode": "standard", "max_attempts": 2},
))
COMPRESSED_MEDIA_EXTENSIONS = frozenset({
    ".jpg", ".jpeg", ".jpe", ".png", ".gif", ".webp", ".avif", ".heic", ".heif",
    ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpeg", ".mpg", ".mts", ".m2ts",
})


class ArchiveSuperseded(Exception):
    pass


class ArchiveQuotaExceeded(ValidationError):
    pass


class StreamToS3(io.RawIOBase):
    def __init__(self, bucket, key):
        self.bucket = bucket
        self.key = key
        self.multipart = s3.create_multipart_upload(
            Bucket=bucket, Key=key, ContentType="application/zip", Tagging="visibility=private",
        )
        self.parts = []
        self.buffer = bytearray()
        self.part_number = 1
        self.part_size = 8 * 1024 * 1024
        self._is_closed = False
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="zip-upload")
        self.pending = []

    def writable(self):
        return True

    def write(self, data):
        self.buffer.extend(data)
        while len(self.buffer) >= self.part_size:
            self._submit_part(bytes(self.buffer[:self.part_size]))
            del self.buffer[:self.part_size]
        return len(data)

    def _submit_part(self, data):
        # At most two parts in flight; source reads overlap uploads without
        # buffering a whole photo or video (or a whole album) in memory.
        if len(self.pending) >= 2:
            self.parts.append(self.pending.pop(0).result())
        number = self.part_number
        self.part_number += 1
        self.pending.append(self.executor.submit(self._upload_part, data, number))

    def _upload_part(self, data, number):
        response = s3.upload_part(
            Bucket=self.bucket, Key=self.key, UploadId=self.multipart["UploadId"],
            PartNumber=number, Body=data,
        )
        return {"PartNumber": number, "ETag": response["ETag"]}

    def close(self):
        if self._is_closed:
            return
        if self.buffer:
            self._submit_part(bytes(self.buffer))
            self.buffer.clear()
        self.parts.extend(future.result() for future in self.pending)
        self.executor.shutdown(wait=True)
        s3.complete_multipart_upload(
            Bucket=self.bucket, Key=self.key, UploadId=self.multipart["UploadId"],
            MultipartUpload={"Parts": self.parts},
        )
        self._is_closed = True
        super().close()

    def cancel(self):
        if self._is_closed:
            return
        self._is_closed = True
        self.executor.shutdown(wait=True, cancel_futures=True)
        s3.abort_multipart_upload(Bucket=self.bucket, Key=self.key, UploadId=self.multipart["UploadId"])
        super().close()


def _validated_album(event):
    album_id = event.get("albumId")
    share_code = event.get("shareCode")
    if album_id:
        album = get_album_record(album_id=validate_uuid(album_id))
        if album and (album.get("status", "active") != "active" or album.get("createdBySub")):
            return None
        if album and album.get("visibility") not in {"public", "private", "unlisted"}:
            return None
        return album
    if share_code:
        album = get_album_record(share_code=share_code)
        authorize_album(album, share_code=share_code)
        return album
    raise ValidationError("Missing album identifier")


def _prune_archives(album_id, keep_key=None):
    # Retain the current object indefinitely. Superseded objects become delete
    # markers; the bucket lifecycle expires their noncurrent bytes after a day.
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket_name(), Prefix=f"album-zips/{album_id}/"):
        for item in page.get("Contents", []):
            if item["Key"] != keep_key:
                s3.delete_object(Bucket=bucket_name(), Key=item["Key"])


def _still_current(album):
    current = get_album_record(album_id=album["albumId"])
    return (
        current is not None
        and current.get("status", "active") == "active"
        and not current.get("createdBySub")
        and zip_version(current) == zip_version(album)
    )


def _check_deadline(context):
    if context is not None and context.get_remaining_time_in_millis() < 30_000:
        raise TimeoutError("Archive preparation exceeded its time budget")


def _write_failure(key, code, message):
    s3.put_object(
        Bucket=bucket_name(), Key=key, ContentType="application/json", Tagging="visibility=private",
        Body=json.dumps({"status": "failed", "code": code, "message": message}),
    )


def _build(event, context):
    album = _validated_album(event)
    album_id = album["albumId"] if album else validate_uuid(event.get("albumId"))
    if not album:
        # A delayed message must not resurrect a deleted/unavailable album.
        _prune_archives(album_id)
        return {"status": "unavailable"}
    entries = archive_entries(album)
    if not entries or album.get("type", "photo") not in {"photo", "video"}:
        _prune_archives(album_id)
        return {"status": "empty"}
    zip_key, failure_key = zip_keys(album)
    if object_metadata(s3, bucket_name(), zip_key):
        _prune_archives(album_id, zip_key)
        return {"status": "ready"}

    stream = None
    try:
        next_revision_check = 0

        def check_revision():
            nonlocal next_revision_check
            now = time.monotonic()
            if now >= next_revision_check:
                if not _still_current(album):
                    raise ArchiveSuperseded()
                next_revision_check = now + 5

        # FIFO messages are wakeups, not frozen manifests. Reading the latest
        # album here coalesces rapid edits and avoids building queued old versions.
        s3.delete_object(Bucket=bucket_name(), Key=failure_key)
        max_objects = max(1, min(int(os.environ.get("ZIP_MAX_OBJECTS", "1000")), 5000))
        max_bytes = max(1, int(os.environ.get("ZIP_MAX_TOTAL_BYTES", str(10 * 1024**3))))
        if len(entries) > max_objects:
            raise ArchiveQuotaExceeded("ZIP object quota exceeded")
        keys = [validate_album_media_key(entry["key"], album=album) for entry in entries]
        with ThreadPoolExecutor(max_workers=8, thread_name_prefix="zip-head") as executor:
            metadata = list(executor.map(lambda key: s3.head_object(Bucket=bucket_name(), Key=key), keys))
        total_bytes = sum(int(item.get("ContentLength", 0)) for item in metadata)
        if total_bytes > max_bytes:
            raise ArchiveQuotaExceeded("ZIP byte quota exceeded")
        _check_deadline(context)
        stream = StreamToS3(bucket_name(), zip_key)
        with zipfile.ZipFile(stream, "w", allowZip64=True) as archive:
            for entry, key, source in zip(entries, keys, metadata):
                _check_deadline(context)
                check_revision()
                info = zipfile.ZipInfo(entry["name"])
                info.compress_type = (
                    zipfile.ZIP_STORED
                    if posixpath.splitext(key)[1].lower() in COMPRESSED_MEDIA_EXTENSIONS
                    else zipfile.ZIP_DEFLATED
                )
                params = {"Bucket": bucket_name(), "Key": key}
                if source.get("VersionId"):
                    params["VersionId"] = source["VersionId"]
                response = s3.get_object(**params)
                try:
                    with archive.open(info, "w", force_zip64=True) as destination:
                        for chunk in iter(lambda: response["Body"].read(1024 * 1024), b""):
                            _check_deadline(context)
                            check_revision()
                            destination.write(chunk)
                finally:
                    response["Body"].close()
        if not _still_current(album):
            stream.cancel()
            return {"status": "superseded"}
        stream.close()
        stream = None
        # Check again after S3 finalization, including album deletion during upload.
        if not _still_current(album):
            s3.delete_object(Bucket=bucket_name(), Key=zip_key)
            return {"status": "superseded"}
        _prune_archives(album_id, zip_key)
        return {"status": "complete", "objectCount": len(keys), "totalBytes": total_bytes}
    except Exception as error:
        if stream is not None:
            try:
                stream.cancel()
            except Exception as cleanup_error:
                logger.error("zip_multipart_abort_failed error_type=%s", type(cleanup_error).__name__)
        if isinstance(error, ArchiveSuperseded):
            return {"status": "superseded"}
        code = "ZIP_TOO_LARGE" if isinstance(error, ArchiveQuotaExceeded) else "ZIP_FAILED"
        message = (
            "This album exceeds the ZIP download limits. Download individual files instead."
            if code == "ZIP_TOO_LARGE"
            else "The ZIP could not be prepared. Please try again shortly."
        )
        try:
            _write_failure(failure_key, code, message)
        except Exception as cleanup_error:
            logger.error("zip_failure_status_write_failed error_type=%s", type(cleanup_error).__name__)
        if isinstance(error, ValidationError):
            return {"status": "failed", "code": code}
        logger.error("zip_worker_failed error_type=%s", type(error).__name__)
        raise


def handler(event, context):
    if "Records" not in event:
        # Compatibility for an already-in-flight invocation during rollout.
        return _build(event, context)
    failures = []
    for index, record in enumerate(event["Records"]):
        try:
            _build(json.loads(record["body"]), context)
        except Exception:
            # Preserve FIFO ordering on a failed batch. Successful explicit
            # failures retry promptly instead of waiting the full timeout lease.
            failures.extend({"itemIdentifier": item["messageId"]} for item in event["Records"][index:])
            try:
                boto3.client("sqs").change_message_visibility(
                    QueueUrl=os.environ["ZIP_QUEUE_URL"], ReceiptHandle=record["receiptHandle"], VisibilityTimeout=30,
                )
            except Exception as cleanup_error:
                logger.error("zip_retry_visibility_failed error_type=%s", type(cleanup_error).__name__)
            break
    return {"batchItemFailures": failures}
