"""Verify archive bytes, compression choices, and bounded multipart streaming."""

import io
import unittest
import zipfile
from unittest.mock import Mock, patch

import test_support  # noqa: F401 - supplies the isolated AWS test environment
import worker_zip


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


class TrackedBody(io.BytesIO):
    def __init__(self, content):
        super().__init__(content)
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        return super().read(size)


class ZipMediaCompressionTests(unittest.TestCase):
    def test_real_archive_stores_compressed_media_and_round_trips_every_byte(self):
        names = ["photo.JPEG", "photo.webp", "photo.png", "photo.heic", "video.mp4", "video.mov", "video.webm", "scan.tiff"]
        contents = {
            f"albums/{ALBUM_ID}/original/{name}": (
                bytes(range(256)) * (36 * 1024 if index == 0 else 16)
            )
            for index, name in enumerate(names)
        }
        record = {
            "albumId": ALBUM_ID,
            "type": "photo",
            "visibility": "public",
            "images": [{"rawKey": key} for key in contents],
        }
        bodies = {key: TrackedBody(value) for key, value in contents.items()}
        s3 = Mock()
        s3.head_object.side_effect = lambda **request: {"ContentLength": len(contents[request["Key"]])}
        s3.get_object.side_effect = lambda **request: {"Body": bodies[request["Key"]]}
        s3.create_multipart_upload.return_value = {"UploadId": "upload"}
        s3.upload_part.side_effect = lambda **request: {"ETag": str(request["PartNumber"])}
        with patch.object(worker_zip, "s3", s3), patch.object(
            worker_zip, "_validated_album", return_value=record
        ), patch.object(worker_zip, "tag_keys_visibility") as tag:
            result = worker_zip.handler({"albumId": ALBUM_ID}, None)

        self.assertEqual(result, {
            "status": "complete",
            "objectCount": len(contents),
            "totalBytes": sum(len(value) for value in contents.values()),
        })
        self.assertGreater(s3.upload_part.call_count, 1)
        parts = [call.kwargs["Body"] for call in s3.upload_part.call_args_list]
        self.assertTrue(all(len(part) <= 8 * 1024 * 1024 for part in parts))
        s3.complete_multipart_upload.assert_called_once()
        s3.abort_multipart_upload.assert_not_called()
        tag.assert_called_once()
        self.assertTrue(all(body.closed for body in bodies.values()))
        self.assertTrue(all(size == 1024 * 1024 for body in bodies.values() for size in body.read_sizes))

        with zipfile.ZipFile(io.BytesIO(b"".join(parts))) as archive:
            self.assertIsNone(archive.testzip())
            for index, (key, original) in enumerate(contents.items(), start=1):
                archive_name = f"{index:04d}_{names[index - 1]}"
                self.assertEqual(archive.read(archive_name), original, key)
                expected_compression = zipfile.ZIP_DEFLATED if key.endswith(".tiff") else zipfile.ZIP_STORED
                self.assertEqual(archive.getinfo(archive_name).compress_type, expected_compression)


if __name__ == "__main__":
    unittest.main()
