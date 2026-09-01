"""Coverage for immutable hover-preview manifests and refresh orchestration."""

import datetime as dt
import base64
import hashlib
import json
import os
import unittest
from unittest.mock import MagicMock, Mock, patch

from botocore.exceptions import ClientError

import test_support  # noqa: F401  # installs deterministic AWS test environment

_previous_preview_table = os.environ.get("PREVIEW_METADATA_TABLE")
os.environ["PREVIEW_METADATA_TABLE"] = "preview-metadata-test"
import hover_preview_manifest_builder as builder
if _previous_preview_table is None:
    os.environ.pop("PREVIEW_METADATA_TABLE", None)
else:
    os.environ["PREVIEW_METADATA_TABLE"] = _previous_preview_table
import hover_preview_refresh
import media_access
from validation_helpers import ValidationError


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


def image(name, width=1800, height=1200):
    return {
        "rawKey": f"albums/{ALBUM_ID}/original/{name}.jpg",
        "thumbKey": f"albums/{ALBUM_ID}/thumbnail/{name}.jpg",
        "width": width,
        "height": height,
    }


def album(images=None, **updates):
    images = list(images or [])
    value = {
        "albumId": ALBUM_ID,
        "visibility": "public",
        "status": "active",
        "type": "photo",
        "coverImageUrl": image("cover")["rawKey"],
        "coverThumbKey": image("cover")["thumbKey"],
        "imageCount": len(images),
        "images": images,
    }
    value.update(updates)
    return value


def metadata_for(source, *, ready=True, width=640, height=427):
    raw_key = source["rawKey"]
    return {
        "albumId": ALBUM_ID,
        "mediaId": media_access.media_id_for_key(raw_key),
        "status": "ready" if ready else "pending",
        "previewVersion": media_access.PREVIEW_VERSION,
        "previewKeys": media_access.expected_preview_keys(ALBUM_ID, raw_key),
        "dimensions": {"640": {"width": width, "height": height}},
    }


class HoverPreviewManifestContractTests(unittest.TestCase):
    def test_helper_contracts_fail_closed_for_malformed_values(self):
        self.assertEqual(builder._comparable_key(None), "")
        self.assertEqual(builder._comparable_key(""), "")
        self.assertEqual(
            builder._comparable_key("https://cdn.test/albums/example%20image.jpg?token=ignored"),
            "albums/example image.jpg",
        )
        self.assertIsNone(builder._dimension({}, "640"))
        self.assertIsNone(builder._dimension({"dimensions": {"640": {"width": "bad", "height": 1}}}, "640"))
        self.assertIsNone(builder._dimension({"dimensions": {"640": {"width": 0, "height": 1}}}, "640"))
        self.assertEqual(
            builder.build_hover_manifest(album([]), "not-a-list", {}),
            {"status": "unavailable", "images": []},
        )
        self.assertEqual(
            builder.build_hover_manifest(album([]), [None, {"rawKey": "outside/album.jpg"}], {}),
            {"status": "unavailable", "images": []},
        )

    def test_build_is_deterministic_bounded_and_excludes_cover_non_landscape_and_pending(self):
        sources = [image("cover")]
        sources.extend(image(f"landscape-{index}") for index in range(15))
        sources.extend((image("portrait", 1200, 1800), image("wrong-width"), image("pending")))
        record = album(sources)
        metadata = {
            media_access.media_id_for_key(item["rawKey"]): metadata_for(
                item,
                ready=item["rawKey"] != image("pending")["rawKey"],
                width=600 if item["rawKey"] == image("wrong-width")["rawKey"] else 640,
                height=960 if item["rawKey"] == image("portrait")["rawKey"] else 427,
            )
            for item in sources
        }

        first = builder.build_hover_manifest(record, sources, metadata)
        second = builder.build_hover_manifest(record, list(reversed(sources)), metadata)

        self.assertEqual(first, second)
        self.assertEqual(first["status"], "ready")
        self.assertEqual(len(first["images"]), builder.MANIFEST_LIMIT)
        self.assertRegex(first["version"], r"^[a-f0-9]{24}$")
        self.assertEqual(
            first["manifestKey"],
            media_access.hover_preview_manifest_key(ALBUM_ID, first["version"]),
        )
        urls = [item["url"] for item in first["images"]]
        self.assertTrue(all("/public-previews/" in value and value.endswith("-w640.webp") for value in urls))
        self.assertNotIn(media_access.media_id_for_key(image("cover")["rawKey"]), "".join(urls))

    def test_build_returns_unavailable_and_ignores_non_public_albums(self):
        source = image("one")
        self.assertEqual(
            builder.build_hover_manifest(album([source]), [source], {
                media_access.media_id_for_key(source["rawKey"]): metadata_for(source),
            }),
            {"status": "unavailable", "images": []},
        )
        self.assertIsNone(builder.build_hover_manifest(
            album([source], visibility="private"),
            [source],
            {},
        ))

    def test_manifest_path_contract_fails_closed(self):
        version = "a" * 24
        key = media_access.hover_preview_manifest_key(ALBUM_ID, version)
        self.assertEqual(
            media_access.public_hover_preview_manifest_key(ALBUM_ID, key),
            f"public-previews/{ALBUM_ID}/v3/hover-{version}.json",
        )
        record = album([], hoverPreviewManifestKey=key, hoverPreviewVersion=version)
        self.assertEqual(media_access.validated_hover_preview_manifest_key(record), key)
        for bad in ("BAD", "a" * 23, "a" * 25):
            with self.assertRaises(ValidationError):
                media_access.hover_preview_manifest_key(ALBUM_ID, bad)
        record["hoverPreviewVersion"] = "b" * 24
        self.assertEqual(media_access.validated_hover_preview_manifest_key(record), "")
        with self.assertRaises(ValidationError):
            media_access.public_hover_preview_manifest_key(
                ALBUM_ID,
                f"albums/{ALBUM_ID}/preview/v3/not-a-manifest.json",
            )

    def test_public_summary_exposes_only_a_valid_ready_pointer(self):
        version = "c" * 24
        key = media_access.hover_preview_manifest_key(ALBUM_ID, version)
        record = album([], hoverPreviewStatus="ready", hoverPreviewVersion=version, hoverPreviewManifestKey=key)
        summary = media_access.serialize_album_summary(record)
        self.assertEqual(summary["hoverPreviewStatus"], "ready")
        self.assertEqual(summary["hoverPreviewVersion"], version)
        self.assertIn(f"/public-previews/{ALBUM_ID}/v3/hover-{version}.json", summary["hoverPreviewManifestUrl"])

        unavailable = media_access.serialize_album_summary(album([], hoverPreviewStatus="unavailable"))
        self.assertEqual(unavailable["hoverPreviewStatus"], "unavailable")
        self.assertNotIn("hoverPreviewManifestUrl", unavailable)
        private = media_access.serialize_album_summary(album([], visibility="private", hoverPreviewStatus="ready"))
        self.assertNotIn("hoverPreviewStatus", private)


class HoverPreviewManifestProviderTests(unittest.TestCase):
    def setUp(self):
        self.sources = [image("cover"), image("one"), image("two")]
        self.record = album(self.sources)
        self.metadata = {
            media_access.media_id_for_key(item["rawKey"]): metadata_for(item)
            for item in self.sources
        }

    def test_rebuild_publishes_pointer_and_invalidates_catalog(self):
        manifest = builder.build_hover_manifest(self.record, self.sources, self.metadata)
        with patch.object(builder, "_load_album", return_value=self.record), patch.object(
            builder, "_album_images", return_value=self.sources
        ), patch.object(builder, "load_preview_metadata", return_value=self.metadata), patch.object(
            builder, "_publish_manifest", return_value=True
        ) as publish, patch.object(builder.albums_table, "update_item") as update, patch.object(
            builder, "request_public_api_invalidation"
        ) as invalidate:
            result = builder.rebuild_album_manifest(ALBUM_ID)

        self.assertEqual(result["status"], "published")
        self.assertEqual(result["imageCount"], 2)
        publish.assert_called_once_with(manifest)
        update.assert_called_once()
        self.assertEqual(
            update.call_args.kwargs["ExpressionAttributeValues"][":manifest"],
            manifest["manifestKey"],
        )
        self.assertIn("coverThumbKey = :cover_thumb", update.call_args.kwargs["ConditionExpression"])
        invalidate.assert_called_once_with(catalog=True, reason="hover-preview-published")

    def test_rebuild_is_noop_when_pointer_and_object_are_current(self):
        manifest = builder.build_hover_manifest(self.record, self.sources, self.metadata)
        current = {
            **self.record,
            "hoverPreviewStatus": "ready",
            "hoverPreviewVersion": manifest["version"],
            "hoverPreviewManifestKey": manifest["manifestKey"],
        }
        with patch.object(builder, "_load_album", return_value=current), patch.object(
            builder, "_album_images", return_value=self.sources
        ), patch.object(builder, "load_preview_metadata", return_value=self.metadata), patch.object(
            builder, "_publish_manifest", return_value=False
        ) as publish, patch.object(builder.albums_table, "update_item") as update, patch.object(
            builder, "request_public_api_invalidation"
        ) as invalidate:
            result = builder.rebuild_album_manifest(ALBUM_ID)

        self.assertEqual(result["status"], "unchanged")
        publish.assert_called_once()
        update.assert_not_called()
        invalidate.assert_not_called()

    def test_unavailable_pointer_is_committed_once_and_inactive_is_ignored(self):
        one = [image("one")]
        metadata = {media_access.media_id_for_key(one[0]["rawKey"]): metadata_for(one[0])}
        with patch.object(builder, "_load_album", return_value=album(one)), patch.object(
            builder, "_album_images", return_value=one
        ), patch.object(builder, "load_preview_metadata", return_value=metadata), patch.object(
            builder.albums_table, "update_item"
        ) as update, patch.object(builder, "request_public_api_invalidation") as invalidate:
            result = builder.rebuild_album_manifest(ALBUM_ID)
        self.assertEqual(result["status"], "unavailable")
        update.assert_called_once()
        invalidate.assert_called_once()

        with patch.object(builder, "_load_album", return_value=album(
            one,
            hoverPreviewStatus="unavailable",
        )), patch.object(builder, "_album_images", return_value=one), patch.object(
            builder, "load_preview_metadata", return_value=metadata
        ), patch.object(builder.albums_table, "update_item") as update:
            result = builder.rebuild_album_manifest(ALBUM_ID)
        self.assertEqual(result["status"], "unchanged")
        update.assert_not_called()

        with patch.object(builder, "_load_album", return_value=album(one, visibility="private")):
            self.assertEqual(builder.rebuild_album_manifest(ALBUM_ID)["status"], "ignored")
        with patch.object(builder, "_load_album", return_value=None):
            self.assertEqual(builder.rebuild_album_manifest(ALBUM_ID)["status"], "ignored")

    def test_publish_is_immutable_and_verifies_preexisting_objects(self):
        manifest = builder.build_hover_manifest(self.record, self.sources, self.metadata)
        body = builder._manifest_bytes(manifest)
        with patch.object(builder.s3, "put_object") as put:
            self.assertTrue(builder._publish_manifest(manifest))
        self.assertEqual(put.call_args.kwargs["IfNoneMatch"], "*")
        self.assertIn("immutable", put.call_args.kwargs["CacheControl"])
        self.assertEqual(
            put.call_args.kwargs["ChecksumSHA256"],
            base64.b64encode(hashlib.sha256(body).digest()).decode("ascii"),
        )

        error = ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
        head = {
            "ContentType": "application/json",
            "CacheControl": "public, max-age=31536000, immutable",
            "ContentLength": len(body),
            "ChecksumSHA256": base64.b64encode(hashlib.sha256(body).digest()).decode("ascii"),
            "Metadata": {
                "album-id": ALBUM_ID,
                "manifest-version": manifest["version"],
                "schema-version": "1",
            },
        }
        tags = {"TagSet": [
            {"Key": "artifact", "Value": "hover-preview-manifest"},
            {"Key": "visibility", "Value": "public"},
        ]}
        with patch.object(builder.s3, "put_object", side_effect=error), patch.object(
            builder.s3, "head_object", return_value=head
        ), patch.object(builder.s3, "get_object_tagging", return_value=tags):
            self.assertFalse(builder._publish_manifest(manifest))
        with patch.object(builder.s3, "put_object", side_effect=error), patch.object(
            builder.s3, "head_object", return_value={**head, "ContentType": "text/plain"}
        ), patch.object(builder.s3, "get_object_tagging", return_value=tags):
            with self.assertRaises(RuntimeError):
                builder._publish_manifest(manifest)

        access_denied = ClientError({"Error": {"Code": "AccessDenied"}}, "PutObject")
        with patch.object(builder.s3, "put_object", side_effect=access_denied):
            with self.assertRaises(ClientError):
                builder._publish_manifest(manifest)

    def test_pointer_condition_guards_absent_cover_and_count_fields(self):
        condition, names, values = builder._pointer_condition({"albumId": ALBUM_ID})
        self.assertIn("attribute_not_exists(coverImageUrl)", condition)
        self.assertIn("attribute_not_exists(coverThumbKey)", condition)
        self.assertIn("attribute_not_exists(imageCount)", condition)
        self.assertEqual(names["#visibility"], "visibility")
        self.assertNotIn(":cover", values)
        self.assertNotIn(":count", values)

    def test_loads_normalized_and_legacy_album_media(self):
        normalized = album([], mediaStoreVersion=builder.MEDIA_STORE_VERSION)
        with patch.object(builder, "query_album_media", side_effect=[
            ([image("one")], {"next": "cursor"}),
            ([image("two")], None),
        ]):
            self.assertEqual(len(builder._album_images(normalized)), 2)
        self.assertEqual(builder._album_images(album(self.sources)), self.sources)


class HoverPreviewOrchestrationTests(unittest.TestCase):
    def test_event_and_reconciliation_query_guards(self):
        with self.assertRaises(ValidationError):
            builder._record_album_id({
                "eventSource": "aws:sqs",
                "body": json.dumps({"version": 2, "albumId": ALBUM_ID}),
            })
        with self.assertRaises(ValidationError):
            builder._record_album_id({"eventSource": "unsupported"})

        unavailable_index = ClientError(
            {"Error": {"Code": "ResourceNotFoundException"}},
            "Query",
        )
        scan_result = {"Items": [], "LastEvaluatedKey": None}
        with patch.dict(os.environ, {"PUBLIC_SUMMARY_INDEX": "public-summary-test"}), patch.object(
            builder.albums_table, "query", side_effect=unavailable_index
        ) as query, patch.object(builder.albums_table, "scan", return_value=scan_result) as scan:
            self.assertEqual(
                builder._query_reconciliation_page({"albumId": ALBUM_ID}, limit=0),
                scan_result,
            )
        self.assertEqual(query.call_args.kwargs["Limit"], 1)
        self.assertEqual(scan.call_args.kwargs["ExclusiveStartKey"], {"albumId": ALBUM_ID})

        access_denied = ClientError({"Error": {"Code": "AccessDeniedException"}}, "Query")
        with patch.dict(os.environ, {"PUBLIC_SUMMARY_INDEX": "public-summary-test"}), patch.object(
            builder.albums_table, "query", side_effect=access_denied
        ), patch.object(builder.albums_table, "scan") as scan:
            with self.assertRaises(ClientError):
                builder._query_reconciliation_page(None)
        scan.assert_not_called()

    def test_refresh_helper_validates_and_queues_without_failing_album_edits(self):
        queue = Mock()
        with patch.dict(os.environ, {"HOVER_PREVIEW_REFRESH_QUEUE_URL": "https://sqs.test/hover"}), patch.object(
            hover_preview_refresh, "_client", return_value=queue
        ):
            self.assertTrue(hover_preview_refresh.request_hover_preview_refresh(ALBUM_ID))
        payload = json.loads(queue.send_message.call_args.kwargs["MessageBody"])
        self.assertEqual(payload, {"version": 1, "albumId": ALBUM_ID})
        self.assertEqual(queue.send_message.call_args.kwargs["DelaySeconds"], 5)
        with patch.dict(os.environ, {"HOVER_PREVIEW_REFRESH_QUEUE_URL": ""}):
            self.assertFalse(hover_preview_refresh.request_hover_preview_refresh(ALBUM_ID))
        with self.assertRaises(ValidationError):
            hover_preview_refresh.request_hover_preview_refresh("bad")

        error = ClientError({"Error": {"Code": "AccessDenied"}}, "SendMessage")
        with patch.dict(os.environ, {"HOVER_PREVIEW_REFRESH_QUEUE_URL": "queue"}), patch.object(
            hover_preview_refresh, "_client", return_value=Mock(send_message=Mock(side_effect=error))
        ):
            self.assertFalse(hover_preview_refresh.request_hover_preview_refresh(ALBUM_ID))

    def test_handler_coalesces_queue_and_stream_records_and_reports_failures(self):
        other = "22222222-2222-4222-8222-222222222222"
        event = {"Records": [
            {"eventSource": "aws:sqs", "messageId": "q1", "body": json.dumps({"version": 1, "albumId": ALBUM_ID})},
            {"eventSource": "aws:dynamodb", "eventID": "d1", "dynamodb": {"Keys": {"albumId": {"S": ALBUM_ID}}}},
            {"eventSource": "aws:dynamodb", "eventID": "system", "dynamodb": {"Keys": {"albumId": {"S": "__SYSTEM__"}}}},
            {"eventSource": "aws:sqs", "messageId": "q2", "body": json.dumps({"version": 1, "albumId": other})},
            {"eventSource": "aws:sqs", "messageId": "bad", "body": "not-json"},
        ]}
        with patch.object(builder, "rebuild_album_manifest", side_effect=lambda value: (
            (_ for _ in ()).throw(RuntimeError("failed")) if value == other else {"status": "published"}
        )) as rebuild:
            result = builder.handler(event, None)
        self.assertEqual(rebuild.call_count, 2)
        self.assertEqual(
            result,
            {"batchItemFailures": [{"itemIdentifier": "bad"}, {"itemIdentifier": "q2"}]},
        )

    def test_reconciliation_is_bounded_persistent_and_idles_until_next_cycle(self):
        future = int(dt.datetime(2026, 1, 2, tzinfo=dt.timezone.utc).timestamp())
        with patch.object(builder.preview_table, "get_item", return_value={"Item": {
            "status": "complete",
            "nextRunAt": future,
        }}), patch.object(builder.preview_table, "put_item") as put:
            result = builder._reconciliation_page(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc))
        self.assertEqual(result, {"status": "idle", "processed": 0, "failed": 0})
        put.assert_not_called()

        response = {"Items": [{"albumId": ALBUM_ID}], "LastEvaluatedKey": {"albumId": ALBUM_ID}}
        with patch.object(builder.preview_table, "get_item", return_value={}), patch.object(
            builder, "_query_reconciliation_page", return_value=response
        ), patch.object(builder, "rebuild_album_manifest", return_value={"status": "published"}), patch.object(
            builder.preview_table, "put_item"
        ) as put:
            result = builder.handler({}, None)
        self.assertEqual(result, {"status": "running", "processed": 1, "failed": 0})
        state = put.call_args.kwargs["Item"]
        self.assertEqual(state["lastEvaluatedKey"], {"albumId": ALBUM_ID})
        self.assertFalse(state["scanComplete"])

        with patch.object(builder.preview_table, "get_item", return_value={"Item": {
            "status": "running",
            "scanComplete": True,
            "retryAlbumIds": [ALBUM_ID],
        }}), patch.object(builder, "rebuild_album_manifest", return_value={"status": "unchanged"}), patch.object(
            builder.preview_table, "put_item"
        ) as put:
            result = builder._reconciliation_page(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc))
        self.assertEqual(result, {"status": "complete", "processed": 1, "failed": 0})
        self.assertGreater(put.call_args.kwargs["Item"]["nextRunAt"], 0)

        retries = [
            f"{index:08x}-1111-4111-8111-{index:012x}"
            for index in range(builder.RECONCILIATION_PAGE_LIMIT + 3)
        ]
        with patch.object(builder.preview_table, "get_item", return_value={"Item": {
            "status": "running",
            "lastEvaluatedKey": {"albumId": ALBUM_ID},
            "retryAlbumIds": retries,
        }}), patch.object(
            builder, "rebuild_album_manifest", return_value={"status": "unchanged"}
        ) as rebuild, patch.object(
            builder, "_query_reconciliation_page"
        ) as query, patch.object(builder.preview_table, "put_item") as put:
            result = builder._reconciliation_page(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc))
        self.assertEqual(rebuild.call_count, builder.RECONCILIATION_PAGE_LIMIT)
        query.assert_not_called()
        self.assertEqual(result, {"status": "running", "processed": 20, "failed": 3})
        self.assertEqual(len(put.call_args.kwargs["Item"]["retryAlbumIds"]), 3)


if __name__ == "__main__":
    unittest.main()
