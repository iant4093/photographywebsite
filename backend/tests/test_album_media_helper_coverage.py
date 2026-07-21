import datetime
import os
import unittest
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from botocore.exceptions import ClientError

from test_support import DEFAULT_ENV

import album_access
import album_mutation_helpers
import deletion_helpers
import media_access
import media_helpers
import preview_jobs
import zip_helpers


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
RAW_KEY = f"albums/{ALBUM_ID}/original/photo.jpg"
THUMB_KEY = f"albums/{ALBUM_ID}/thumbnail/photo.jpg"


def client_error(code="Boom", operation="Operation"):
    return ClientError({"Error": {"Code": code, "Message": "provider detail"}}, operation)


class Ratio:
    def __init__(self, num, den):
        self.num = num
        self.den = den


class Tag:
    def __init__(self, value):
        self.values = [value]


class AlbumAccessBranchTests(unittest.TestCase):
    def test_missing_inactive_and_private_failure_modes(self):
        with self.assertRaisesRegex(album_access.AuthError, "not found"):
            album_access.authorize_album(None)
        with self.assertRaisesRegex(album_access.AuthError, "not found"):
            album_access.authorize_album({"status": "deleted", "visibility": "public"})
        with self.assertRaisesRegex(album_access.AuthError, "Authentication"):
            album_access.authorize_album({"status": "active", "visibility": "private"})
        with self.assertRaisesRegex(album_access.AuthError, "Access denied"):
            album_access.authorize_album(
                {"status": "active", "visibility": "private", "ownerEmail": "owner@example.com"},
                claims={"sub": "other", "email": ""},
            )

    def test_cursor_empty_and_all_malformed_shapes(self):
        self.assertIsNone(album_access.encode_cursor(None, "scope"))
        self.assertIsNone(album_access.decode_cursor(None, "scope"))
        for key in (
            {"a": 1},
            {str(index): str(index) for index in range(7)},
            {"albumId": ["invalid"]},
            {"albumId": Decimal("1.25")},
        ):
            with self.subTest(key=key), self.assertRaises(album_access.ValidationError):
                album_access.encode_cursor(key, "scope")
        invalid = [
            123,
            "x" * 4097,
            album_access.encode_cursor({"albumId": "one"}, "other"),
        ]
        for cursor in invalid:
            with self.subTest(cursor_type=type(cursor).__name__):
                with self.assertRaises(album_access.ValidationError):
                    album_access.decode_cursor(cursor, "scope")
        encoded = album_access.encode_cursor({"albumId": "one"}, "scope")
        self.assertEqual(album_access.decode_cursor(encoded, "scope"), {"albumId": "one"})


class AlbumMutationHelperBranchTests(unittest.TestCase):
    def test_created_at_and_explicit_owner_validation(self):
        self.assertEqual(album_mutation_helpers.validate_created_at("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00Z")
        with self.assertRaisesRegex(album_mutation_helpers.ValidationError, "ISO-8601"):
            album_mutation_helpers.validate_created_at("not-a-date")
        self.assertEqual(
            album_mutation_helpers.resolve_owner({"ownerEmail": "OWNER@example.com", "ownerSub": ALBUM_ID}),
            ("owner@example.com", ALBUM_ID),
        )

    def test_owner_lookup_requires_exactly_one_user_and_escapes_filter(self):
        with patch.object(album_mutation_helpers.cognito, "list_users", return_value={"Users": []}):
            with self.assertRaisesRegex(album_mutation_helpers.ValidationError, "exactly one"):
                album_mutation_helpers.resolve_owner({"ownerEmail": "owner@example.com"})
        users = [{"Attributes": []}, {"Attributes": []}]
        with patch.object(album_mutation_helpers.cognito, "list_users", return_value={"Users": users}):
            with self.assertRaises(album_mutation_helpers.ValidationError):
                album_mutation_helpers.resolve_owner({"ownerEmail": "owner@example.com"})
        response = {"Users": [{"Attributes": [{"Name": "sub", "Value": ALBUM_ID}, {"Value": "ignored"}]}]}
        with patch.object(album_mutation_helpers.cognito, "list_users", return_value=response) as lookup:
            self.assertEqual(
                album_mutation_helpers.resolve_owner({"ownerEmail": 'own"er@example.com'}),
                ('own"er@example.com', ALBUM_ID),
            )
        self.assertIn(r'own\"er@example.com', lookup.call_args.kwargs["Filter"])


class DeletionHelperBranchTests(unittest.TestCase):
    def test_sync_limit_clamps_and_recovers_from_invalid_environment(self):
        for value, expected in (("bad", 5000), ("0", 1), ("999999", 50000), ("12", 12)):
            with self.subTest(value=value), patch.dict(os.environ, {"MAX_SYNC_DELETE_VERSIONS": value}):
                self.assertEqual(deletion_helpers.sync_delete_limit(), expected)

    def test_delete_batches_empty_large_and_provider_errors(self):
        self.assertEqual(deletion_helpers._delete_batch([]), 0)
        with patch.object(deletion_helpers.s3, "delete_objects", return_value={"Errors": [{"Code": "Denied"}]}):
            with self.assertRaises(RuntimeError):
                deletion_helpers._delete_batch([{"Key": "one", "VersionId": "v"}])
        with patch.object(deletion_helpers, "_delete_batch", side_effect=lambda values: len(values)) as delete:
            self.assertEqual(deletion_helpers.delete_object_versions([{"Key": "x"}] * 2001), 2001)
        self.assertEqual([len(call.args[0]) for call in delete.call_args_list], [1000, 1000, 1])

    def test_version_enumeration_filters_inexact_and_incomplete_records(self):
        prefix_pages = [{
            "Versions": [{"Key": RAW_KEY, "VersionId": "v1"}, {"Key": RAW_KEY}],
            "DeleteMarkers": [{"Key": THUMB_KEY, "VersionId": "d1"}, {"VersionId": "d2"}],
        }]
        paginator = Mock()
        paginator.paginate.return_value = prefix_pages
        with patch.object(deletion_helpers.s3, "get_paginator", return_value=paginator):
            self.assertEqual(
                list(deletion_helpers._versions_under_prefix(f"albums/{ALBUM_ID}")),
                [{"Key": RAW_KEY, "VersionId": "v1"}, {"Key": THUMB_KEY, "VersionId": "d1"}],
            )

        exact = Mock()
        exact.paginate.return_value = [{
            "Versions": [
                {"Key": RAW_KEY, "VersionId": "v1"},
                {"Key": RAW_KEY + ".bak", "VersionId": "v2"},
            ],
            "DeleteMarkers": [{"Key": RAW_KEY, "VersionId": "d1"}],
        }]
        with patch.object(deletion_helpers.s3, "get_paginator", return_value=exact):
            self.assertEqual(
                list(deletion_helpers._versions_for_exact_keys([RAW_KEY, RAW_KEY, ""])),
                [{"Key": RAW_KEY, "VersionId": "v1"}, {"Key": RAW_KEY, "VersionId": "d1"}],
            )

    def test_preflight_deduplicates_and_bounds_targets_and_versions(self):
        with self.assertRaises(deletion_helpers.DeletionTooLargeError):
            deletion_helpers.preflight_deletion(prefixes=["a", "b"], max_prefixes=1)
        duplicate = {"Key": RAW_KEY, "VersionId": "v1"}
        with patch.object(deletion_helpers, "_versions_under_prefix", return_value=iter([duplicate])), patch.object(
            deletion_helpers, "_versions_for_exact_keys", return_value=iter([duplicate])
        ):
            self.assertEqual(deletion_helpers.preflight_deletion(prefixes=[RAW_KEY], keys=[RAW_KEY], max_versions=1), 1)
        with patch.object(
            deletion_helpers,
            "_versions_for_exact_keys",
            return_value=iter([duplicate, {"Key": THUMB_KEY, "VersionId": "v2"}]),
        ):
            with self.assertRaises(deletion_helpers.DeletionTooLargeError):
                deletion_helpers.preflight_deletion(keys=[RAW_KEY], max_versions=1)

    def test_prefix_and_exact_delete_empty_and_thousand_boundary(self):
        objects = [{"Key": RAW_KEY, "VersionId": str(index)} for index in range(1001)]
        with patch.object(deletion_helpers, "_versions_under_prefix", return_value=iter(objects)), patch.object(
            deletion_helpers, "_delete_batch", side_effect=lambda values: len(values)
        ) as delete:
            self.assertEqual(deletion_helpers.delete_prefix_all_versions(f"albums/{ALBUM_ID}/"), 1001)
        self.assertEqual([len(call.args[0]) for call in delete.call_args_list], [1000, 1])
        self.assertEqual(deletion_helpers.delete_keys_all_versions([]), 0)
        with patch.object(deletion_helpers, "_versions_for_exact_keys", return_value=iter(objects)), patch.object(
            deletion_helpers, "delete_object_versions", return_value=1001
        ) as delete_versions:
            self.assertEqual(deletion_helpers.delete_keys_all_versions([RAW_KEY]), 1001)
        delete_versions.assert_called_once_with(objects)


class ZipAndPreviewHelperBranchTests(unittest.TestCase):
    def test_zip_record_lookup_by_id_and_share_cardinality(self):
        table = Mock()
        table.get_item.return_value = {"Item": {"albumId": ALBUM_ID}}
        resource = Mock()
        resource.Table.return_value = table
        with patch.object(zip_helpers, "dynamodb", resource):
            self.assertEqual(zip_helpers.get_album_record(album_id=ALBUM_ID), {"albumId": ALBUM_ID})
            self.assertTrue(table.get_item.call_args.kwargs["ConsistentRead"])
            for items, expected in (([], None), ([{"albumId": ALBUM_ID}], {"albumId": ALBUM_ID}), ([{}, {}], None)):
                table.query.return_value = {"Items": items}
                self.assertEqual(zip_helpers.get_album_record(share_code="share-code"), expected)

    def test_zip_key_material_ignores_malformed_manifest_entries(self):
        album = {"albumId": ALBUM_ID, "visibility": "public", "images": [None, {}, {"key": RAW_KEY}, RAW_KEY]}
        self.assertEqual(zip_helpers.raw_image_keys(album), [RAW_KEY])
        zip_key, lock_key = zip_helpers.zip_keys(album)
        self.assertTrue(zip_key.startswith(f"temp-zips/{ALBUM_ID}/"))
        self.assertTrue(zip_key.endswith(".zip"))
        self.assertEqual(lock_key, zip_key.removesuffix(".zip") + ".lock")

    def test_preview_client_is_lazy_and_dispatch_skips_non_objects(self):
        client = Mock()
        client.send_message_batch.return_value = {"Successful": [{"Id": "0"}], "Failed": []}
        with patch.object(preview_jobs, "_sqs", None), patch.object(preview_jobs.boto3, "client", return_value=client) as factory:
            self.assertIs(preview_jobs.get_sqs_client(), client)
            self.assertIs(preview_jobs.get_sqs_client(), client)
            factory.assert_called_once_with("sqs")
            with patch.dict(os.environ, {"PREVIEW_QUEUE_URL": "queue"}):
                self.assertEqual(preview_jobs.enqueue_preview_jobs(ALBUM_ID, [None, {"rawKey": RAW_KEY}]), 1)

    def test_preview_dispatch_surfaces_batch_failure(self):
        client = Mock()
        client.send_message_batch.return_value = {"Failed": [{"Id": "0"}], "Successful": []}
        with patch.dict(os.environ, {"PREVIEW_QUEUE_URL": "queue"}), patch.object(
            preview_jobs, "get_sqs_client", return_value=client
        ):
            with self.assertRaisesRegex(RuntimeError, "1 message"):
                preview_jobs.enqueue_preview_jobs(ALBUM_ID, [{"rawKey": RAW_KEY}])


class MediaHelperBranchTests(unittest.TestCase):
    def tearDown(self):
        media_helpers.s3 = None
        media_helpers.mediaconvert = None

    def test_lazy_s3_and_mediaconvert_endpoint_success_and_failure(self):
        s3 = Mock()
        initial = Mock()
        endpoint = Mock()
        initial.describe_endpoints.return_value = {"Endpoints": [{"Url": "https://mc.example"}]}
        with patch.object(media_helpers.boto3, "client", side_effect=[s3, initial, endpoint]) as factory:
            self.assertIs(media_helpers.get_s3_client(), s3)
            self.assertIs(media_helpers.get_s3_client(), s3)
            self.assertIs(media_helpers.get_mediaconvert_client(), endpoint)
            self.assertIs(media_helpers.get_mediaconvert_client(), endpoint)
        self.assertEqual(factory.call_count, 3)

        media_helpers.mediaconvert = None
        failed = Mock()
        failed.describe_endpoints.side_effect = RuntimeError("offline")
        with patch.object(media_helpers.boto3, "client", return_value=failed):
            self.assertIs(media_helpers.get_mediaconvert_client(), failed)

    def test_fraction_formatting_covers_wrapped_and_direct_ratios(self):
        cases = [
            (Tag(Ratio(7, 0)), "7"),
            (Tag(Ratio(0, 4)), "0"),
            (Tag(Ratio(1, 60)), "1/60"),
            (Tag(Ratio(8, 4)), "2"),
            (Tag(Ratio(7, 2)), "3.5"),
            (Ratio(3, 0), "3"),
            (Ratio(0, 3), "0"),
            (Ratio(1, 4), "1/4"),
            (Ratio(8, 4), "2"),
            (Ratio(5, 2), "2.5"),
            ("plain", "plain"),
        ]
        for value, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(media_helpers.format_fraction(value), expected)
        wrapped_non_ratio = Tag("not-a-ratio")
        self.assertEqual(media_helpers.format_fraction(wrapped_non_ratio), str(wrapped_non_ratio))

    def test_exif_success_and_provider_failure(self):
        body = Mock()
        body.read.return_value = b"jpeg"
        s3 = Mock()
        s3.get_object.return_value = {"Body": body}
        tags = {
            "Image Model": "Camera",
            "EXIF LensModel": "Lens",
            "EXIF FocalLength": Ratio(50, 1),
            "EXIF FNumber": Ratio(28, 10),
            "EXIF ExposureTime": Ratio(1, 125),
            "EXIF ISOSpeedRatings": "400",
        }
        with patch.object(media_helpers, "get_s3_client", return_value=s3), patch.object(
            media_helpers.exifread, "process_file", return_value=tags
        ):
            self.assertEqual(
                media_helpers.extract_exif_data("bucket", RAW_KEY),
                {
                    "model": "Camera",
                    "lens": "Lens",
                    "focalLength": "50mm",
                    "focalRatio": "f/2.8",
                    "shutterSpeed": "1/125s",
                    "iso": "ISO 400",
                },
            )
        with patch.object(media_helpers, "get_s3_client", return_value=s3), patch.object(
            media_helpers.exifread, "process_file", return_value={}
        ):
            self.assertEqual(media_helpers.extract_exif_data("bucket", RAW_KEY), {})
        s3.get_object.side_effect = RuntimeError("offline")
        with patch.object(media_helpers, "get_s3_client", return_value=s3):
            self.assertIsNone(media_helpers.extract_exif_data("bucket", RAW_KEY))

    def test_mediaconvert_job_success_and_failure(self):
        client = Mock()
        client.create_job.return_value = {"Job": {"Id": "job-1"}}
        with patch.object(media_helpers, "get_mediaconvert_client", return_value=client), patch.dict(
            os.environ, {"MEDIACONVERT_ROLE_ARN": "arn:role"}
        ):
            self.assertEqual(media_helpers.start_mediaconvert_job("s3://in", "s3://out"), "job-1")
        settings = client.create_job.call_args.kwargs["Settings"]
        self.assertEqual(settings["Inputs"][0]["FileInput"], "s3://in")
        self.assertEqual(settings["OutputGroups"][0]["OutputGroupSettings"]["HlsGroupSettings"]["Destination"], "s3://out")
        client.create_job.side_effect = RuntimeError("provider")
        with patch.object(media_helpers, "get_mediaconvert_client", return_value=client), patch.dict(
            os.environ, {"MEDIACONVERT_ROLE_ARN": "arn:role"}
        ):
            with self.assertRaises(RuntimeError):
                media_helpers.start_mediaconvert_job("s3://in", "s3://out")


class MediaAccessBranchTests(unittest.TestCase):
    def setUp(self):
        self.album = {
            "albumId": ALBUM_ID,
            "status": "active",
            "visibility": "public",
            "title": "Album",
            "images": [{"rawKey": RAW_KEY, "thumbKey": THUMB_KEY}],
            "coverImageUrl": RAW_KEY,
            "coverThumbKey": THUMB_KEY,
        }

    def tearDown(self):
        media_access._s3 = None
        media_access._dynamodb = None

    def test_lazy_clients_bucket_domain_and_ttl_boundaries(self):
        s3 = Mock()
        dynamo = Mock()
        with patch.object(media_access.boto3, "client", return_value=s3) as client, patch.object(
            media_access.boto3, "resource", return_value=dynamo
        ) as resource:
            self.assertIs(media_access.get_s3_client(), s3)
            self.assertIs(media_access.get_s3_client(), s3)
            self.assertIs(media_access.get_dynamodb_resource(), dynamo)
            self.assertIs(media_access.get_dynamodb_resource(), dynamo)
        client.assert_called_once()
        resource.assert_called_once_with("dynamodb")
        with patch.dict(os.environ, {"IMAGES_BUCKET": ""}):
            with self.assertRaises(RuntimeError):
                media_access.bucket_name()
        with patch.dict(os.environ, {"CLOUDFRONT_DOMAIN": "https://cdn.example/"}):
            self.assertEqual(media_access.cdn_domain(), "cdn.example")
        for value, expected in (("5", 60), ("9999", 3600), ("bad", 600)):
            with patch.dict(os.environ, {"MEDIA_URL_TTL_SECONDS": value}):
                self.assertEqual(media_access._ttl_seconds(), expected)
        self.assertEqual(media_access.url_expiry_metadata(123)["expiresIn"], 123)

    def test_key_normalization_and_namespace_validation_fail_closed(self):
        for value in (None, "", "a" * 1025, "bad\\key", "bad\x00key", "../outside", ".", ".."):
            with self.subTest(value=repr(value)):
                with self.assertRaises(media_access.ValidationError):
                    media_access.normalize_object_key(value)
        self.assertEqual(media_access.normalize_object_key("/albums/x/./photo.jpg"), "albums/x/photo.jpg")
        with self.assertRaises(media_access.ValidationError):
            media_access.validate_album_media_key(RAW_KEY)
        self.assertEqual(media_access.validate_media_key_under_prefix(RAW_KEY, f"albums/{ALBUM_ID}"), RAW_KEY)
        with self.assertRaises(media_access.ValidationError):
            media_access.validate_media_key_under_prefix("albums/other/file.jpg", f"albums/{ALBUM_ID}")

    def test_urls_and_download_disposition_are_normalized(self):
        with patch.dict(os.environ, {**DEFAULT_ENV, "CLOUDFRONT_DOMAIN": ""}):
            with self.assertRaises(RuntimeError):
                media_access.public_url(RAW_KEY)
        s3 = Mock()
        s3.generate_presigned_url.return_value = "signed"
        with patch.object(media_access, "get_s3_client", return_value=s3):
            self.assertEqual(media_access.presigned_get_url(RAW_KEY, download_filename="../bad\r\nname.jpg", expiration=99), "signed")
        params = s3.generate_presigned_url.call_args.kwargs["Params"]
        self.assertNotIn("\r", params["ResponseContentDisposition"])
        self.assertNotIn("\n", params["ResponseContentDisposition"])
        self.assertEqual(media_access.media_url("", "public"), "")
        with patch.object(media_access, "public_url", return_value="public"), patch.object(
            media_access, "presigned_get_url", return_value="private"
        ):
            self.assertEqual(media_access.media_url(RAW_KEY, "public"), "public")
            self.assertEqual(media_access.media_url(RAW_KEY, "private"), "private")
            self.assertEqual(media_access.media_url(RAW_KEY, "public", download_filename="x"), "private")

    def test_preview_contract_rejects_every_partial_or_mismatched_shape(self):
        image = {"rawKey": RAW_KEY}
        expected = media_access.expected_preview_keys(ALBUM_ID, RAW_KEY)
        media_id = media_access.media_id_for_key(RAW_KEY)
        base = {
            "albumId": ALBUM_ID,
            "mediaId": media_id,
            "status": "ready",
            "previewVersion": 2,
            "previewKeys": expected,
        }
        self.assertEqual(media_access.validated_preview_keys(None, self.album, base), {})
        for mutation in (
            {"status": "pending"},
            {"previewVersion": 1},
            {"albumId": "other"},
            {"mediaId": "0" * 24},
            {"previewKeys": []},
            {"previewKeys": {"640": expected["640"]}},
            {"previewKeys": {**expected, "640": "albums/other/preview.webp"}},
        ):
            with self.subTest(mutation=mutation):
                self.assertEqual(media_access.validated_preview_keys(image, self.album, {**base, **mutation}), {})
        self.assertEqual(media_access.validated_preview_keys(image, self.album, {**base, "status": "pending"}, allow_pending=True), expected)

    def test_preview_metadata_empty_retry_and_strict_paths(self):
        with patch.dict(os.environ, {"PREVIEW_METADATA_TABLE": ""}):
            self.assertEqual(media_access.load_preview_metadata(self.album), {})
        with patch.dict(os.environ, {"PREVIEW_METADATA_TABLE": "previews"}):
            self.assertEqual(media_access.load_preview_metadata(None), {})
            self.assertEqual(media_access.load_preview_metadata({**self.album, "images": [None]}), {})

        media_id = media_access.media_id_for_key(RAW_KEY)
        resource = Mock()
        resource.batch_get_item.side_effect = [
            {"Responses": {"previews": []}, "UnprocessedKeys": {"previews": {"Keys": [{"albumId": ALBUM_ID, "mediaId": media_id}]}}},
            {"Responses": {"previews": [{"albumId": ALBUM_ID, "mediaId": media_id}]}, "UnprocessedKeys": {}},
        ]
        with patch.dict(os.environ, {"PREVIEW_METADATA_TABLE": "previews"}), patch.object(
            media_access, "get_dynamodb_resource", return_value=resource
        ):
            self.assertEqual(media_access.load_preview_metadata(self.album)[media_id]["albumId"], ALBUM_ID)
        self.assertEqual(resource.batch_get_item.call_count, 2)

        resource.batch_get_item.return_value = {
            "Responses": {},
            "UnprocessedKeys": {"previews": {"Keys": [{"albumId": ALBUM_ID, "mediaId": media_id}]}},
        }
        resource.batch_get_item.side_effect = None
        with patch.dict(os.environ, {"PREVIEW_METADATA_TABLE": "previews"}), patch.object(
            media_access, "get_dynamodb_resource", return_value=resource
        ):
            self.assertEqual(media_access.load_preview_metadata(self.album), {})
            with self.assertRaises(RuntimeError):
                media_access.load_preview_metadata(self.album, strict=True)

    def test_preview_metadata_provider_fallback_and_delete_batch(self):
        resource = Mock()
        resource.batch_get_item.side_effect = client_error("ProvisionedThroughputExceededException", "BatchGetItem")
        with patch.dict(os.environ, {"PREVIEW_METADATA_TABLE": "previews"}), patch.object(
            media_access, "get_dynamodb_resource", return_value=resource
        ):
            self.assertEqual(media_access.load_preview_metadata(self.album), {})
        with patch.dict(os.environ, {"PREVIEW_METADATA_TABLE": ""}):
            self.assertEqual(media_access.delete_preview_metadata(ALBUM_ID, ["x"]), 0)

        batch = MagicMock()
        table = Mock()
        table.batch_writer.return_value = batch
        resource = Mock()
        resource.Table.return_value = table
        with patch.dict(os.environ, {"PREVIEW_METADATA_TABLE": "previews"}), patch.object(
            media_access, "get_dynamodb_resource", return_value=resource
        ):
            self.assertEqual(media_access.delete_preview_metadata(ALBUM_ID, ["b", "a", "a"]), 2)
        self.assertEqual(batch.__enter__.return_value.delete_item.call_count, 2)

    def test_preview_known_keys_and_media_lookup_ignore_invalid_records(self):
        metadata = {
            media_access.media_id_for_key(RAW_KEY): {
                "albumId": ALBUM_ID,
                "mediaId": media_access.media_id_for_key(RAW_KEY),
                "status": "pending",
                "previewVersion": 2,
                "previewKeys": media_access.expected_preview_keys(ALBUM_ID, RAW_KEY),
            }
        }
        album = {**self.album, "images": [None, {"rawKey": "albums/other/x.jpg"}, {"rawKey": RAW_KEY}]}
        with patch.object(media_access, "load_preview_metadata", return_value=metadata):
            self.assertEqual(len(media_access.preview_known_keys(album)), 2)
        self.assertEqual(media_access._raw_key("key"), "key")
        self.assertEqual(media_access._raw_key(None), "")
        self.assertIsNone(media_access.find_image_by_media_id(self.album, 1))
        self.assertIsNone(media_access.find_image_by_media_id(self.album, "0" * 24))

    def test_serializers_cover_public_private_internal_and_invalid_paths(self):
        source = {
            "rawKey": RAW_KEY,
            "thumbKey": THUMB_KEY,
            "hlsUrl": f"albums/{ALBUM_ID}/video_hls/main.m3u8",
            "width": 100,
            "height": 50,
            "blurhash": "hash",
            "exif": {"iso": 100},
            "thumbnailTime": 2,
            "mediaConvertJobId": "job",
        }
        with patch.object(media_access, "media_url", side_effect=lambda key, visibility, **kwargs: f"{visibility}:{key}"), patch.object(
            media_access, "public_url", side_effect=lambda key: f"public:{key}"
        ), patch.object(media_access, "url_expiry_metadata", return_value={"expiresIn": 60, "expiresAt": "soon"}):
            public = media_access.serialize_image(source, "public", include_internal=True)
            private = media_access.serialize_image(source, "private")
        self.assertEqual(public["hlsUrl"], f"public:albums/{ALBUM_ID}/video_hls/main.m3u8")
        self.assertEqual(public["mediaConvertJobId"], "job")
        self.assertTrue(private["freshDownloadRequired"])
        self.assertNotIn("hlsUrl", private)
        with self.assertRaises(media_access.ValidationError):
            media_access.serialize_images({**self.album, "visibility": "unknown"})
        with patch.object(media_access, "load_preview_metadata", return_value={}), patch.object(
            media_access, "serialize_image", return_value={"ok": True}
        ):
            result = media_access.serialize_images({**self.album, "images": ["albums/other/x.jpg", RAW_KEY]})
        self.assertEqual(result, [{"ok": True}])

    def test_summary_absolute_cdn_admin_and_detail_fields(self):
        with patch.dict(os.environ, {"CLOUDFRONT_DOMAIN": "media.example.test"}), patch.object(
            media_access, "media_url", side_effect=lambda key, visibility: f"{visibility}:{key}"
        ), patch.object(media_access, "url_expiry_metadata", return_value={"expiresIn": 60}):
            absolute = media_access.serialize_album_summary({
                **self.album,
                "coverImageUrl": "https://media.example.test/legacy.jpg",
                "coverThumbKey": "",
            })
            private_admin = media_access.serialize_album_summary(
                {**self.album, "visibility": "private", "ownerEmail": "x", "ownerSub": ALBUM_ID, "backupToGoogleDrive": True},
                include_admin=True,
            )
            detail = media_access.serialize_album_detail(
                {**self.album, "visibility": "private", "backupToGoogleDrive": True}, include_admin=True
            )
        self.assertEqual(absolute["coverImageUrl"], "https://media.example.test/legacy.jpg")
        self.assertEqual(private_admin["ownerEmail"], "x")
        self.assertIn("expiresIn", private_admin)
        self.assertNotIn("imageCount", detail)
        self.assertTrue(detail["backupToGoogleDrive"])

    def test_visibility_tag_failures_dedup_and_derivative_enumeration(self):
        with self.assertRaises(media_access.ValidationError):
            media_access._merge_visibility_tag(RAW_KEY, "invalid")
        s3 = Mock()
        s3.get_object_tagging.side_effect = client_error("AccessDenied", "GetObjectTagging")
        with patch.object(media_access, "get_s3_client", return_value=s3):
            with self.assertRaises(ClientError):
                media_access._merge_visibility_tag(RAW_KEY, "public")

        with patch.object(media_access, "_merge_visibility_tag", side_effect=[True, False]) as merge, patch.dict(
            os.environ, {"MEDIA_TAG_WORKERS": "bad"}
        ):
            self.assertEqual(media_access.tag_keys_visibility(["", RAW_KEY, RAW_KEY, THUMB_KEY], "private"), 1)
        self.assertEqual(merge.call_count, 2)
        self.assertEqual(media_access.tag_keys_visibility([], "private"), 0)

        paginator = Mock()
        paginator.paginate.return_value = [{"Contents": [{"Key": "one.ts"}, {}, {"Key": "two.ts"}]}]
        s3.get_paginator.return_value = paginator
        album = {**self.album, "images": [{"rawKey": RAW_KEY}, {"rawKey": "albums/other/bad.mp4"}, None]}
        with patch.object(media_access, "get_s3_client", return_value=s3), patch.object(
            media_access, "album_known_keys", return_value=[RAW_KEY]
        ), patch.object(media_access, "tag_keys_visibility", side_effect=[1, 2]) as tag:
            self.assertEqual(media_access.tag_album_visibility(album, "public", include_derivatives=True, max_derivatives=2), 3)
        self.assertEqual(tag.call_count, 2)
        with self.assertRaises(media_access.ValidationError):
            media_access.tag_album_visibility(album, "invalid")

    def test_album_known_keys_handles_strings_invalid_and_http(self):
        album = {
            **self.album,
            "images": [
                RAW_KEY,
                {"rawKey": RAW_KEY, "key": "", "thumbKey": THUMB_KEY, "hlsUrl": "https://evil"},
                {"rawKey": "albums/other/outside.jpg"},
                None,
            ],
            "coverImageUrl": "https://media.example.test/cover.jpg",
        }
        with patch.object(media_access, "preview_known_keys", return_value=["preview"]):
            keys = media_access.album_known_keys(album)
        self.assertIn(RAW_KEY, keys)
        self.assertIn(THUMB_KEY, keys)
        self.assertIn("preview", keys)
        self.assertNotIn("https://evil", keys)

    def test_remaining_media_access_guard_branches(self):
        self.assertIsNone(media_access.approved_legacy_prefix(None))
        with self.assertRaises(media_access.ValidationError):
            media_access.serialize_album_summary({**self.album, "visibility": "invalid"})
        with patch.object(media_access, "preview_known_keys", return_value=[RAW_KEY]), patch.object(
            media_access, "tag_keys_visibility", return_value=1
        ) as tag:
            self.assertEqual(media_access.tag_preview_visibility(self.album, "private"), 1)
            self.assertEqual(media_access.tag_album_visibility(self.album, "private", include_derivatives=False), 1)
        self.assertEqual(tag.call_count, 2)
        with patch.object(media_access, "album_known_keys", return_value=[]), patch.object(
            media_access, "tag_keys_visibility", return_value=0
        ), patch.object(media_access, "_hls_prefixes", return_value=["one/", "two/"]), patch.object(
            media_access, "get_s3_client", return_value=Mock()
        ):
            self.assertEqual(
                media_access.tag_album_visibility(self.album, "public", include_derivatives=True, max_derivatives=0),
                0,
            )
        paginator = Mock()
        paginator.paginate.return_value = [{"Contents": [{"Key": "segment.ts"}]}]
        s3 = Mock()
        s3.get_paginator.return_value = paginator
        with patch.object(media_access, "album_known_keys", return_value=[]), patch.object(
            media_access, "tag_keys_visibility", side_effect=[0, 1]
        ), patch.object(media_access, "_hls_prefixes", return_value=["one/"]), patch.object(
            media_access, "get_s3_client", return_value=s3
        ):
            self.assertEqual(
                media_access.tag_album_visibility(self.album, "public", include_derivatives=True, max_derivatives=10),
                1,
            )

    def test_metadata_response_ignores_malformed_items(self):
        media_id = media_access.media_id_for_key(RAW_KEY)
        resource = Mock()
        resource.batch_get_item.return_value = {
            "Responses": {"previews": [None, {}, {"mediaId": 4}, {"mediaId": media_id, "albumId": ALBUM_ID}]},
            "UnprocessedKeys": {},
        }
        with patch.dict(os.environ, {"PREVIEW_METADATA_TABLE": "previews"}), patch.object(
            media_access, "get_dynamodb_resource", return_value=resource
        ):
            self.assertEqual(set(media_access.load_preview_metadata(self.album)), {media_id})


if __name__ == "__main__":
    unittest.main()
