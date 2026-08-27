"""Asynchronous bounded ZIP worker. Exceptions are re-raised for DLQ delivery."""

import io
import logging
import os
import posixpath
import zipfile

import boto3

from album_access import authorize_album
from media_access import bucket_name, tag_keys_visibility, validate_album_media_key
from validation_helpers import ValidationError, validate_uuid
from zip_helpers import get_album_record, raw_image_keys, zip_keys


logger = logging.getLogger("photography_api.zip_worker")
s3 = boto3.client("s3")


class StreamToS3(io.RawIOBase):
    def __init__(self, bucket, key):
        self.bucket = bucket
        self.key = key
        self.multipart = s3.create_multipart_upload(
            Bucket=bucket,
            Key=key,
            ContentType="application/zip",
            Tagging="visibility=pending",
        )
        self.parts = []
        self.buffer = bytearray()
        self.part_number = 1
        self.part_size = 8 * 1024 * 1024
        self._is_closed = False

    def writable(self):
        return True

    def write(self, data):
        self.buffer.extend(data)
        while len(self.buffer) >= self.part_size:
            self._upload_part(self.buffer[: self.part_size])
            del self.buffer[: self.part_size]
        return len(data)

    def _upload_part(self, data):
        response = s3.upload_part(
            Bucket=self.bucket,
            Key=self.key,
            UploadId=self.multipart["UploadId"],
            PartNumber=self.part_number,
            Body=bytes(data),
        )
        self.parts.append({"PartNumber": self.part_number, "ETag": response["ETag"]})
        self.part_number += 1

    def close(self):
        if self._is_closed:
            return
        self._is_closed = True
        if self.buffer:
            self._upload_part(self.buffer)
            self.buffer.clear()
        s3.complete_multipart_upload(
            Bucket=self.bucket,
            Key=self.key,
            UploadId=self.multipart["UploadId"],
            MultipartUpload={"Parts": self.parts},
        )
        super().close()

    def cancel(self):
        if self._is_closed:
            return
        self._is_closed = True
        s3.abort_multipart_upload(Bucket=self.bucket, Key=self.key, UploadId=self.multipart["UploadId"])


def _validated_album(event):
    album_id = (event or {}).get("albumId")
    share_code = (event or {}).get("shareCode")
    if album_id:
        album_id = validate_uuid(album_id)
        album = get_album_record(album_id=album_id)
        if not album:
            raise ValidationError("Album not found")
        # Internal invocation happens only after create_zip authorized the caller.
        # Re-check active/default-deny state, but no user claim is propagated.
        if album.get("status", "active") != "active" or album.get("visibility") not in {"public", "private", "unlisted"}:
            raise ValidationError("Album is unavailable")
        return album
    if share_code:
        album = get_album_record(share_code=share_code)
        authorize_album(album, share_code=share_code)
        return album
    raise ValidationError("Missing album identifier")


def handler(event, context):
    album = None
    lock_key = None
    stream = None
    bucket = bucket_name()
    try:
        album = _validated_album(event)
        if album.get("type", "photo") not in {"photo", "video"}:
            raise ValidationError("Unsupported album type")
        raw_keys = raw_image_keys(album)
        max_objects = max(1, min(int(os.environ.get("ZIP_MAX_OBJECTS", "1000")), 5000))
        max_bytes = max(1, int(os.environ.get("ZIP_MAX_TOTAL_BYTES", str(10 * 1024 * 1024 * 1024))))
        if not raw_keys or len(raw_keys) > max_objects:
            raise ValidationError("ZIP object quota exceeded")

        validated_keys = [
            validate_album_media_key(key, album=album) for key in raw_keys
        ]
        total_bytes = 0
        for key in validated_keys:
            total_bytes += int(s3.head_object(Bucket=bucket, Key=key).get("ContentLength", 0))
            if total_bytes > max_bytes:
                raise ValidationError("ZIP byte quota exceeded")

        zip_key, lock_key = zip_keys(album)
        stream = StreamToS3(bucket, zip_key)
        # Deflate preserves the original media bytes while avoiding store-only
        # archives. JPEG and MP4 inputs are already compressed, so savings vary,
        # but no image or video quality is discarded.
        with zipfile.ZipFile(
            stream,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
            allowZip64=True,
        ) as archive:
            for index, key in enumerate(validated_keys, start=1):
                filename = posixpath.basename(key).replace("\r", "_").replace("\n", "_") or "media"
                archive_name = f"{index:04d}_{filename}"
                response = s3.get_object(Bucket=bucket, Key=key)
                with archive.open(archive_name, "w") as destination:
                    for chunk in iter(lambda: response["Body"].read(1024 * 1024), b""):
                        destination.write(chunk)
        stream.close()
        stream = None
        tag_keys_visibility([zip_key], album["visibility"])
        s3.delete_object(Bucket=bucket, Key=lock_key)
        return {"status": "complete", "objectCount": len(validated_keys), "totalBytes": total_bytes}
    except Exception as error:
        if stream is not None:
            try:
                stream.cancel()
            except Exception:
                pass
        if lock_key:
            try:
                s3.delete_object(Bucket=bucket, Key=lock_key)
            except Exception:
                pass
        logger.error("zip_worker_failed error_type=%s", type(error).__name__)
        raise
