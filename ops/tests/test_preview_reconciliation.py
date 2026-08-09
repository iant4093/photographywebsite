from collections import Counter
import json
import pathlib
import sys
import unittest
from unittest import mock


OPS_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(OPS_DIR) not in sys.path:
    sys.path.insert(0, str(OPS_DIR))

import backfill_preview_v3
import reconcile_preview_v3


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
RAW_KEY = f"albums/{ALBUM_ID}/original/private-name.jpg"


def dynamo(value):
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, int):
        return {"N": str(value)}
    if isinstance(value, list):
        return {"L": [dynamo(item) for item in value]}
    if isinstance(value, dict):
        return {"M": {key: dynamo(item) for key, item in value.items()}}
    raise TypeError(value)


def record(**values):
    return {key: dynamo(value) for key, value in values.items()}


def vp8x_header(width, height):
    data = bytearray(30)
    data[:4] = b"RIFF"
    data[8:12] = b"WEBP"
    data[12:16] = b"VP8X"
    data[24:27] = (width - 1).to_bytes(3, "little")
    data[27:30] = (height - 1).to_bytes(3, "little")
    return bytes(data)


class PreviewReconciliationTests(unittest.TestCase):
    def test_expected_inventory_is_metadata_independent_and_classified(self):
        album = record(
            albumId=ALBUM_ID,
            type="photo",
            status="active",
            visibility="private",
            images=[{"rawKey": RAW_KEY, "width": 3000, "height": 2000}],
        )
        inventory, counts = reconcile_preview_v3.expected_inventory([album])

        self.assertEqual(inventory, [{
            "job": {"albumId": ALBUM_ID, "rawKey": RAW_KEY, "previewVersion": backfill_preview_v3.PREVIEW_VERSION},
            "visibility": "private",
        }])
        self.assertEqual(counts["plannedJobCount"], 1)
        self.assertEqual(
            reconcile_preview_v3.inventory_digest(inventory),
            backfill_preview_v3.plan_digest([inventory[0]["job"]]),
        )

    def test_parses_vp8x_vp8_and_vp8l_dimensions(self):
        self.assertEqual(reconcile_preview_v3.parse_webp_dimensions(vp8x_header(640, 427)), (640, 427))

        vp8 = bytearray(30)
        vp8[:4], vp8[8:12], vp8[12:16] = b"RIFF", b"WEBP", b"VP8 "
        vp8[23:26] = b"\x9d\x01\x2a"
        vp8[26:28] = (1280).to_bytes(2, "little")
        vp8[28:30] = (853).to_bytes(2, "little")
        self.assertEqual(reconcile_preview_v3.parse_webp_dimensions(bytes(vp8)), (1280, 853))

        width, height = 320, 777
        packed = (width - 1) | ((height - 1) << 14)
        vp8l = bytearray(25)
        vp8l[:4], vp8l[8:12], vp8l[12:16] = b"RIFF", b"WEBP", b"VP8L"
        vp8l[20] = 0x2F
        vp8l[21:25] = packed.to_bytes(4, "little")
        self.assertEqual(reconcile_preview_v3.parse_webp_dimensions(bytes(vp8l)), (width, height))

    def test_rejects_truncated_or_unknown_webp(self):
        for value in (b"", b"not-webp" * 4, vp8x_header(10, 10)[:25]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                reconcile_preview_v3.parse_webp_dimensions(value)

    def test_ready_metadata_requires_exact_keys_checksums_and_dimensions(self):
        keys = backfill_preview_v3.expected_preview_keys(ALBUM_ID, RAW_KEY)
        metadata = {
            "status": "ready",
            "previewVersion": backfill_preview_v3.PREVIEW_VERSION,
            "previewKeys": keys,
            "sourceSha256": "a" * 64,
            "dimensions": {
                "640": {"width": 640, "height": 427},
                "960": {"width": 960, "height": 640},
                "1440": {"width": 1440, "height": 960},
                "1920": {"width": 1920, "height": 1280},
            },
        }
        digest, dimensions, failures = reconcile_preview_v3.validate_ready_metadata(metadata, keys)
        self.assertEqual(digest, "a" * 64)
        self.assertEqual(dimensions, {"640": 427, "960": 640, "1440": 960, "1920": 1280})
        self.assertFalse(failures)

        metadata["dimensions"] = {
            "640": {"width": 640, "height": 961},
            "960": {"width": 960, "height": 1441},
            "1440": {"width": 1440, "height": 2161},
            "1920": {"width": 1920, "height": 2881},
        }
        _, dimensions, failures = reconcile_preview_v3.validate_ready_metadata(metadata, keys)
        self.assertEqual(dimensions, {"640": 961, "960": 1441, "1440": 2161, "1920": 2881})
        self.assertFalse(failures)

        metadata["sourceSha256"] = "invalid"
        metadata["dimensions"]["1920"]["height"] = 700
        metadata["jobId"] = "must-not-remain"
        _, _, failures = reconcile_preview_v3.validate_ready_metadata(metadata, keys)
        self.assertEqual(failures["metadataSourceChecksumInvalid"], 1)
        self.assertEqual(failures["metadataAspectRatioMismatch"], 1)
        self.assertEqual(failures["readyMetadataRetainsJobId"], 1)

    def test_validates_complete_public_object_contract(self):
        head = {
            "ContentLength": 12345,
            "ContentType": "image/webp",
            "CacheControl": reconcile_preview_v3.EXPECTED_CACHE_CONTROL,
            "ServerSideEncryption": "AES256",
            "ETag": '"' + ("a" * 32) + '"',
            "VersionId": "version",
            "Metadata": {
                "preview-version": str(backfill_preview_v3.PREVIEW_VERSION),
                "preview-width": "640",
                "source-sha256": "b" * 64,
                "generator": reconcile_preview_v3.EXPECTED_GENERATOR,
            },
        }
        tags = {"TagSet": [{"Key": "visibility", "Value": "public"}]}
        with mock.patch.object(
            reconcile_preview_v3, "aws_json", side_effect=[head, tags]
        ), mock.patch.object(
            reconcile_preview_v3, "read_object_prefix", return_value=vp8x_header(640, 427)
        ), mock.patch.object(
            reconcile_preview_v3,
            "edge_head",
            return_value=(200, {
                "content-type": "image/webp",
                "cache-control": reconcile_preview_v3.EXPECTED_CACHE_CONTROL,
            }),
        ):
            failures = reconcile_preview_v3.validate_object(
                bucket="bucket",
                key="internal-key",
                width=640,
                height=427,
                source_digest="b" * 64,
                visibility="public",
                expected_encryption="AES256",
                media_domain="distribution.cloudfront.net",
                profile=None,
                region="us-west-2",
                maximum_bytes=20_000_000,
                timeout_seconds=1,
            )
        self.assertFalse(failures)

    def test_protected_object_must_be_denied_at_edge(self):
        head = {
            "ContentLength": 100,
            "ContentType": "image/webp",
            "CacheControl": reconcile_preview_v3.EXPECTED_CACHE_CONTROL,
            "ServerSideEncryption": "AES256",
            "ChecksumSHA256": "checksum",
            "Metadata": {
                "preview-version": str(backfill_preview_v3.PREVIEW_VERSION),
                "preview-width": "640",
                "source-sha256": "c" * 64,
                "generator": reconcile_preview_v3.EXPECTED_GENERATOR,
            },
        }
        tags = {"TagSet": [{"Key": "visibility", "Value": "private"}]}
        with mock.patch.object(
            reconcile_preview_v3, "aws_json", side_effect=[head, tags]
        ), mock.patch.object(
            reconcile_preview_v3, "read_object_prefix", return_value=vp8x_header(640, 427)
        ), mock.patch.object(reconcile_preview_v3, "edge_head", return_value=(200, {})):
            failures = reconcile_preview_v3.validate_object(
                bucket="bucket", key="private-key", width=640, height=427,
                source_digest="c" * 64, visibility="private", expected_encryption="AES256",
                media_domain="distribution.cloudfront.net", profile=None, region="us-west-2",
                maximum_bytes=20_000_000, timeout_seconds=1,
            )
        self.assertEqual(failures["protectedEdgeAccessInvalid"], 1)

    def test_object_failures_are_fixed_aggregate_codes_not_exception_text(self):
        secret_key = "albums/private/client-name.jpg"
        with mock.patch.object(
            reconcile_preview_v3, "aws_json", side_effect=RuntimeError(secret_key)
        ):
            failures = reconcile_preview_v3.validate_object(
                bucket="bucket", key=secret_key, width=640, height=427,
                source_digest="d" * 64, visibility="private", expected_encryption="AES256",
                media_domain="distribution.cloudfront.net", profile=None, region="us-west-2",
                maximum_bytes=20_000_000, timeout_seconds=1,
            )
        serialized = json.dumps(failures)
        self.assertEqual(failures, Counter({"objectInspectionError": 1}))
        self.assertNotIn(secret_key, serialized)
        self.assertNotIn("client-name", serialized)

    def test_main_emits_only_aggregate_output(self):
        album = record(
            albumId=ALBUM_ID,
            type="photo",
            status="active",
            visibility="private",
            images=[{"rawKey": RAW_KEY, "width": 3000, "height": 2000}],
        )
        inventory, _ = reconcile_preview_v3.expected_inventory([album])
        digest = reconcile_preview_v3.inventory_digest(inventory)
        media_id = backfill_preview_v3.media_id_for_key(RAW_KEY)
        metadata = record(
            albumId=ALBUM_ID,
            mediaId=media_id,
            status="ready",
            previewVersion=backfill_preview_v3.PREVIEW_VERSION,
            previewKeys=backfill_preview_v3.expected_preview_keys(ALBUM_ID, RAW_KEY),
            sourceSha256="e" * 64,
            dimensions={
                "640": {"width": 640, "height": 427},
                "960": {"width": 960, "height": 640},
                "1440": {"width": 1440, "height": 960},
                "1920": {"width": 1920, "height": 1280},
            },
        )
        argv = [
            "reconcile_preview_v3.py", "--stack-name", "photo-stack",
            "--expected-account-id", "123", "--expected-inventory-count", "1",
            "--expected-inventory-digest", digest,
        ]

        def discovery(arguments, _profile, _region):
            if arguments[:2] == ["sts", "get-caller-identity"]:
                return {"Account": "123"}
            if arguments[:2] == ["cloudfront", "get-distribution"]:
                return {"Distribution": {
                    "Status": "Deployed",
                    "DomainName": "distribution.cloudfront.net",
                    "DistributionConfig": {"Enabled": True},
                }}
            raise AssertionError(arguments)

        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            reconcile_preview_v3, "aws_json", side_effect=discovery
        ), mock.patch.object(
            reconcile_preview_v3, "stack_resource", return_value="resource"
        ), mock.patch.object(
            reconcile_preview_v3.backfill, "scan_all", side_effect=[[album], [metadata]]
        ), mock.patch.object(
            reconcile_preview_v3, "validate_bucket_controls", return_value=("AES256", Counter())
        ), mock.patch.object(
            reconcile_preview_v3, "validate_object", return_value=Counter()
        ), mock.patch("builtins.print") as output:
            self.assertEqual(reconcile_preview_v3.main(), 0)

        rendered = output.call_args.args[0]
        summary = json.loads(rendered)
        self.assertEqual(summary["status"], "pass")
        self.assertEqual(summary["account"], "verified")
        self.assertEqual(summary["stack"], "verified")
        self.assertEqual(summary["objectValidatedCount"], 4)
        self.assertNotIn('"account": "123"', rendered)
        self.assertNotIn('"stack": "ian-website"', rendered)
        self.assertNotIn(ALBUM_ID, rendered)
        self.assertNotIn(RAW_KEY, rendered)
        self.assertNotIn(media_id, rendered)
        self.assertNotIn("private-name", rendered)

    def test_tool_source_contains_no_aws_mutation_operations(self):
        source = pathlib.Path(reconcile_preview_v3.__file__).read_text(encoding="utf-8")
        for operation in (
            "put-object", "put-object-tagging", "delete-object", "update-item",
            "put-item", "send-message", "create-invalidation",
        ):
            self.assertNotIn(operation, source)


if __name__ == "__main__":
    unittest.main()
