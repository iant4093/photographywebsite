import json
import os
import unittest
from copy import deepcopy
from decimal import Decimal
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from test_support import claims, response_body

import add_images
import create_album
import delete_album
import delete_images
import update_album
import update_image


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ID = "22222222-2222-4222-8222-222222222222"
RAW_KEY = f"albums/{ALBUM_ID}/original/photo.jpg"
RAW_KEY_2 = f"albums/{ALBUM_ID}/original/photo-2.jpg"
THUMB_KEY = f"albums/{ALBUM_ID}/thumbnail/photo.jpg"
THUMB_KEY_2 = f"albums/{ALBUM_ID}/thumbnail/photo-2.jpg"


def client_error(code="InternalServerError", operation="Operation"):
    return ClientError({"Error": {"Code": code, "Message": "provider detail"}}, operation)


def event(body=None, *, album_id=ALBUM_ID):
    value = {"pathParameters": {"albumId": album_id}}
    if body is not None:
        value["body"] = json.dumps(body)
    return value


def create_body(**overrides):
    body = {
        "albumId": ALBUM_ID,
        "type": "photo",
        "visibility": "public",
        "title": "Album",
        "description": "Description",
        "category": "Portraits",
        "createdAt": "2026-01-01T00:00:00Z",
        "images": [{"rawKey": RAW_KEY, "thumbKey": THUMB_KEY, "width": 2000, "height": 1200}],
        "backupToGoogleDrive": False,
    }
    body.update(overrides)
    return body


def album(**overrides):
    value = {
        "albumId": ALBUM_ID,
        "type": "photo",
        "status": "active",
        "visibility": "public",
        "title": "Album",
        "description": "Description",
        "category": "Portraits",
        "createdAt": "2026-01-01T00:00:00Z",
        "images": [{"rawKey": RAW_KEY, "thumbKey": THUMB_KEY, "blurhash": "old"}],
        "imageCount": 1,
        "coverImageUrl": RAW_KEY,
        "coverThumbKey": THUMB_KEY,
        "coverBlurhash": "old",
        "backupToGoogleDrive": False,
    }
    value.update(overrides)
    return value


class CreateAlbumBranchTests(unittest.TestCase):
    def test_audit_details_and_image_normalization_branches(self):
        with patch.object(create_album, "actor_context", return_value=("admin", "jwt")), patch.object(
            create_album, "emit_audit_event"
        ) as emit:
            create_album._audit({}, None, "success", "ok", media_count=2, visibility="mystery")
        self.assertEqual(emit.call_args.kwargs["details"], {"media_count": 2, "visibility": "unknown"})

        with self.assertRaises(create_album.ValidationError):
            create_album._normalize_images([None], ALBUM_ID, "photo")
        for image in (
            {"rawKey": RAW_KEY, "width": "bad"},
            {"rawKey": RAW_KEY, "height": 0},
            {"rawKey": RAW_KEY, "thumbnailTime": "bad"},
        ):
            with self.subTest(image=image):
                kind = "video" if "thumbnailTime" in image else "photo"
                with self.assertRaises(create_album.ValidationError):
                    create_album._normalize_images([image], ALBUM_ID, kind)
        normalized = create_album._normalize_images(
            [{"rawKey": RAW_KEY, "thumbKey": THUMB_KEY, "blurhash": "hash", "width": "3", "thumbnailTime": 999999}],
            ALBUM_ID,
            "video",
        )[0]
        self.assertEqual(normalized["width"], 3)
        self.assertEqual(normalized["thumbnailTime"], Decimal("86400.0"))
        self.assertIn("hlsUrl", normalized)

    def test_exif_and_video_auxiliary_provider_paths(self):
        images = [{"rawKey": RAW_KEY}, {"rawKey": RAW_KEY_2}, {"rawKey": RAW_KEY}]
        with patch.object(
            create_album,
            "extract_exif_data",
            side_effect=[{"model": "Camera"}, RuntimeError("bad"), None],
        ):
            create_album._extract_exif(images)
        self.assertEqual(images[0]["exif"], {"model": "Camera"})
        self.assertNotIn("exif", images[1])

        videos = [
            {"rawKey": f"albums/{ALBUM_ID}/original/one.mp4", "hlsUrl": "one"},
            {"rawKey": f"albums/{ALBUM_ID}/original/two.mp4", "hlsUrl": "two"},
        ]
        with patch.object(create_album, "start_mediaconvert_job", side_effect=["job-1", RuntimeError("offline")]):
            create_album._start_video_jobs(videos)
        self.assertEqual(videos[0]["mediaConvertJobId"], "job-1")
        self.assertNotIn("hlsUrl", videos[1])

    def _run_success(self, body, **extra_patches):
        table = Mock()
        patches = [
            patch.object(create_album, "require_admin", return_value=None),
            patch.object(create_album, "get_caller_claims", return_value=claims(groups=["Admins"])),
            patch.object(create_album, "_extract_exif"),
            patch.object(create_album, "tag_album_visibility", return_value=1),
            patch.object(create_album, "enqueue_preview_jobs", return_value=1),
            patch.object(create_album, "ensure_album_item_budget"),
            patch.object(create_album, "_audit"),
            patch.object(create_album, "table", table),
        ]
        patches.extend(extra_patches.values())
        entered = [item.start() for item in patches]
        self.addCleanup(lambda: [item.stop() for item in reversed(patches)])
        return create_album.handler({"body": json.dumps(body)}, None), table, entered

    def test_admin_denial_and_public_photo_success_with_preview_failure(self):
        denied = {"statusCode": 403}
        with patch.object(create_album, "require_admin", return_value=denied):
            self.assertIs(create_album.handler({}, None), denied)
        response, table, _ = self._run_success(
            create_body(),
            queue=patch.object(create_album, "enqueue_preview_jobs", side_effect=RuntimeError("queue")),
        )
        self.assertEqual(response["statusCode"], 201)
        public_item = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(public_item["status"], "active")
        self.assertEqual(public_item["ownerEmail"], "")
        self.assertNotIn("ownerSub", public_item)
        self.assertEqual(table.update_item.call_count, 2)

    def test_unlisted_share_code_and_private_notification_success_and_failure(self):
        with patch.object(create_album.secrets, "token_urlsafe", return_value="share-code"):
            response, table, _ = self._run_success(create_body(visibility="unlisted", isShared=True))
        self.assertEqual(response["statusCode"], 201)
        unlisted_item = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(unlisted_item["shareCode"], "share-code")
        self.assertNotIn("ownerSub", unlisted_item)

        for failure in (False, True):
            with self.subTest(failure=failure):
                send = patch.object(create_album, "send_email", side_effect=RuntimeError("email") if failure else None)
                response, table, entered = self._run_success(
                    create_body(visibility="private", ownerEmail="owner@example.com", ownerSub=ALBUM_ID),
                    owner=patch.object(create_album, "_resolve_owner", return_value=("owner@example.com", ALBUM_ID)),
                    send=send,
                    emit=patch.object(create_album, "emit_audit_event"),
                )
                self.assertEqual(response["statusCode"], 201)
                self.assertEqual(table.put_item.call_args.kwargs["Item"]["ownerSub"], ALBUM_ID)

    def test_drive_dispatch_success_and_failure_are_nonfatal(self):
        for failure in (False, True):
            with self.subTest(failure=failure), patch.dict(
                os.environ, {"GOOGLE_DRIVE_SYNC_FUNCTION_NAME": "drive-worker"}
            ):
                lambda_client = Mock()
                if failure:
                    lambda_client.invoke.side_effect = RuntimeError("offline")
                response, _, _ = self._run_success(
                    create_body(backupToGoogleDrive=True),
                    client=patch.object(create_album.boto3, "client", return_value=lambda_client),
                    emit=patch.object(create_album, "emit_audit_event"),
                )
                self.assertEqual(response["statusCode"], 201)
                lambda_client.invoke.assert_called_once()

    def test_video_job_write_and_idempotent_conditional_retry(self):
        body = create_body(
            type="video",
            images=[{"rawKey": f"albums/{ALBUM_ID}/original/movie.mp4"}],
        )
        response, table, _ = self._run_success(body, jobs=patch.object(create_album, "_start_video_jobs"))
        self.assertEqual(response["statusCode"], 201)
        self.assertGreaterEqual(table.update_item.call_count, 2)

        existing = album(status="pending", createdBySub="user-sub")
        table = Mock()
        table.put_item.side_effect = client_error("ConditionalCheckFailedException", "PutItem")
        table.get_item.return_value = {"Item": existing}
        with patch.object(create_album, "require_admin", return_value=None), patch.object(
            create_album, "get_caller_claims", return_value=claims()
        ), patch.object(create_album, "_extract_exif"), patch.object(
            create_album, "tag_album_visibility"
        ), patch.object(create_album, "enqueue_preview_jobs"), patch.object(
            create_album, "ensure_album_item_budget"
        ), patch.object(create_album, "_audit"), patch.object(create_album, "table", table):
            response = create_album.handler({"body": json.dumps(create_body())}, None)
        self.assertEqual(response["statusCode"], 201)

    def test_conflict_validation_and_provider_failures(self):
        table = Mock()
        table.put_item.side_effect = client_error("ConditionalCheckFailedException", "PutItem")
        table.get_item.return_value = {"Item": album(status="deleted", createdBySub="other")}
        with patch.object(create_album, "require_admin", return_value=None), patch.object(
            create_album, "get_caller_claims", return_value=claims()
        ), patch.object(create_album, "_extract_exif"), patch.object(
            create_album, "ensure_album_item_budget"
        ), patch.object(create_album, "_audit"), patch.object(create_album, "table", table):
            self.assertEqual(create_album.handler({"body": json.dumps(create_body())}, None)["statusCode"], 409)

        with patch.object(create_album, "require_admin", return_value=None), patch.object(
            create_album, "get_caller_claims", return_value=claims()
        ), patch.object(create_album, "_audit"):
            self.assertEqual(create_album.handler({"body": "{}"}, None)["statusCode"], 400)
        with patch.object(create_album, "require_admin", return_value=None), patch.object(
            create_album, "get_caller_claims", side_effect=RuntimeError("boom")
        ), patch.object(create_album, "_audit"):
            self.assertEqual(create_album.handler({"body": "{}"}, None)["statusCode"], 500)
        table.put_item.side_effect = client_error("AccessDeniedException", "PutItem")
        with patch.object(create_album, "require_admin", return_value=None), patch.object(
            create_album, "get_caller_claims", return_value=claims()
        ), patch.object(create_album, "_extract_exif"), patch.object(
            create_album, "ensure_album_item_budget"
        ), patch.object(create_album, "_audit"), patch.object(create_album, "table", table):
            self.assertEqual(create_album.handler({"body": json.dumps(create_body())}, None)["statusCode"], 500)


class AddImagesBranchTests(unittest.TestCase):
    def setUp(self):
        self.table = Mock()
        self.table.get_item.return_value = {"Item": album()}

    def _call(self, body, **patches):
        patchers = [
            patch.object(add_images, "require_admin", return_value=None),
            patch.object(add_images, "table", self.table),
            patch.object(add_images, "ensure_album_item_budget"),
            patch.object(add_images, "_extract_exif"),
            patch.object(add_images, "_start_video_jobs"),
            patch.object(add_images, "tag_keys_visibility"),
            patch.object(add_images, "enqueue_preview_jobs", return_value=1),
            patch.object(add_images, "_audit"),
        ] + list(patches.values())
        for patcher in patchers:
            patcher.start()
        try:
            return add_images.handler(event(body), None)
        finally:
            for patcher in reversed(patchers):
                patcher.stop()

    def test_denied_missing_inactive_duplicate_and_validation(self):
        denied = {"statusCode": 403}
        with patch.object(add_images, "require_admin", return_value=denied):
            self.assertIs(add_images.handler({}, None), denied)
        for item in (None, album(status="pending")):
            self.table.get_item.return_value = {"Item": item} if item else {}
            self.assertEqual(self._call({"images": [{"rawKey": RAW_KEY_2}]})["statusCode"], 404)
        self.table.get_item.return_value = {"Item": album()}
        response = self._call({"images": [{"rawKey": RAW_KEY}]})
        self.assertEqual(response_body(response)["added"], 0)
        self.table.update_item.assert_not_called()
        self.assertEqual(self._call({"images": [None]})["statusCode"], 400)

    def test_photo_and_video_paths_preview_failure_and_drive_dispatch(self):
        self.table.get_item.return_value = {"Item": album(backupToGoogleDrive=True)}
        lambda_client = Mock()
        response = self._call(
            {"images": [{"rawKey": RAW_KEY_2}]},
            queue=patch.object(add_images, "enqueue_preview_jobs", side_effect=RuntimeError("queue")),
            client=patch.object(add_images.boto3, "client", return_value=lambda_client),
            env=patch.dict(os.environ, {"GOOGLE_DRIVE_SYNC_FUNCTION_NAME": "drive-worker"}),
        )
        self.assertEqual(response_body(response)["added"], 1)
        lambda_client.invoke.assert_called_once()

        self.table.reset_mock()
        self.table.get_item.return_value = {"Item": album(type="video")}
        response = self._call({"images": [{"rawKey": f"albums/{ALBUM_ID}/original/movie.mp4"}]})
        self.assertEqual(response["statusCode"], 200)

    def test_drive_failure_maximum_and_unexpected_paths(self):
        existing = [{"rawKey": f"albums/{ALBUM_ID}/original/{index}.jpg"} for index in range(500)]
        self.table.get_item.return_value = {"Item": album(images=existing, imageCount=500)}
        self.assertEqual(self._call({"images": [{"rawKey": RAW_KEY_2}]})["statusCode"], 400)

        lambda_client = Mock()
        lambda_client.invoke.side_effect = RuntimeError("offline")
        self.table.get_item.return_value = {"Item": album(backupToGoogleDrive=True)}
        with patch.object(add_images, "emit_audit_event"):
            response = self._call(
                {"images": [{"rawKey": RAW_KEY_2}]},
                client=patch.object(add_images.boto3, "client", return_value=lambda_client),
                env=patch.dict(os.environ, {"GOOGLE_DRIVE_SYNC_FUNCTION_NAME": "drive-worker"}),
            )
        self.assertEqual(response["statusCode"], 200)
        self.table.get_item.side_effect = RuntimeError("db")
        self.assertEqual(self._call({"images": [{"rawKey": RAW_KEY_2}]})["statusCode"], 500)


class UpdateAlbumBranchTests(unittest.TestCase):
    def test_updated_album_all_metadata_visibility_and_sharing_branches(self):
        base = album(ownerEmail="", ownerSub="")
        with patch.object(update_album, "_resolve_owner", return_value=("owner@example.com", ALBUM_ID)):
            private = update_album._updated_album(base, {
                "title": "New",
                "description": "D",
                "category": "",
                "createdAt": "2026-02-01T00:00:00Z",
                "coverBlurhash": "hash",
                "coverImageUrl": RAW_KEY_2,
                "coverThumbKey": "",
                "visibility": "private",
                "ownerEmail": "owner@example.com",
            })
        self.assertEqual(private["ownerSub"], ALBUM_ID)
        self.assertEqual(private["category"], "Uncategorized")
        with self.assertRaises(update_album.ValidationError):
            update_album._updated_album(base, {"shareCode": "client"})
        with self.assertRaisesRegex(update_album.ValidationError, "require owner"):
            update_album._updated_album({**base, "visibility": "private"}, {})

        with patch.object(update_album.secrets, "token_urlsafe", return_value="new-share"):
            shared = update_album._updated_album(base, {"visibility": "unlisted", "isShared": True})
        self.assertEqual(shared["shareCode"], "new-share")
        self.assertNotIn("ownerSub", shared)
        revoked = update_album._updated_album({**shared, "shareCode": "old"}, {"visibility": "unlisted", "isShared": False})
        self.assertNotIn("shareCode", revoked)
        public = update_album._updated_album({**shared, "ownerEmail": "x", "ownerSub": ALBUM_ID}, {"visibility": "public"})
        self.assertEqual(public["ownerEmail"], "")
        self.assertNotIn("ownerSub", public)
        self.assertFalse(public["isShared"])
        preserved = update_album._updated_album(
            {**shared, "visibility": "unlisted", "shareCode": "existing"}, {"isShared": True}
        )
        self.assertEqual(preserved["shareCode"], "existing")

    def test_audit_classifies_visibility_details(self):
        with patch.object(update_album, "actor_context", return_value=("admin", "jwt")), patch.object(
            update_album, "emit_audit_event"
        ) as emit:
            update_album._audit({}, None, "success", "updated", previous_visibility="bad", visibility="private")
        self.assertEqual(
            emit.call_args.kwargs["details"],
            {"previous_visibility": "unknown", "visibility": "private"},
        )
        with patch.object(update_album, "actor_context", return_value=("admin", "jwt")), patch.object(
            update_album, "emit_audit_event"
        ) as emit:
            update_album._audit({}, None, "success", "updated")
        self.assertIsNone(emit.call_args.kwargs["details"])

    def _call(self, body, record=None, *, put_error=None, tag_error=None):
        table = Mock()
        table.get_item.return_value = {"Item": record} if record is not None else {}
        table.put_item.side_effect = put_error
        with patch.object(update_album, "require_admin", return_value=None), patch.object(
            update_album, "table", table
        ), patch.object(update_album, "tag_album_visibility", side_effect=tag_error) as tag, patch.object(
            update_album, "tag_preview_visibility"
        ) as preview, patch.object(update_album, "_audit"):
            response = update_album.handler(event(body), None)
        return response, table, tag, preview

    def test_denial_empty_missing_and_both_visibility_orders(self):
        denied = {"statusCode": 403}
        with patch.object(update_album, "require_admin", return_value=denied):
            self.assertIs(update_album.handler({}, None), denied)
        self.assertEqual(self._call({}, album())[0]["statusCode"], 400)
        self.assertEqual(self._call({"title": "x"}, None)[0]["statusCode"], 404)
        self.assertEqual(self._call({"title": "x"}, album(status="pending"))[0]["statusCode"], 404)

        response, table, tag, preview = self._call(
            {"visibility": "private", "ownerEmail": "owner@example.com", "ownerSub": ALBUM_ID}, album()
        )
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(tag.call_count, 1)
        self.assertLess(tag.call_args_list[0], table.put_item.call_args) if False else None
        preview.assert_called_once()

        response, table, tag, _ = self._call({"visibility": "public"}, album(visibility="private", ownerEmail="x", ownerSub=ALBUM_ID))
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(tag.call_count, 1)
        no_images = {key: value for key, value in album().items() if key != "images"}
        self.assertIn(
            "attribute_not_exists(#images)",
            self._call({"title": "x"}, no_images)[1].put_item.call_args.kwargs["ConditionExpression"],
        )

    def test_conflict_provider_validation_and_unexpected_errors(self):
        conditional = client_error("ConditionalCheckFailedException", "PutItem")
        self.assertEqual(self._call({"title": "x"}, album(), put_error=conditional)[0]["statusCode"], 409)
        self.assertEqual(self._call({"title": "x"}, album(), put_error=client_error())[0]["statusCode"], 500)
        self.assertEqual(self._call({"shareCode": "x"}, album())[0]["statusCode"], 400)
        self.assertEqual(self._call({"title": "x"}, album(), tag_error=RuntimeError("s3"))[0]["statusCode"], 500)


class UpdateImageBranchTests(unittest.TestCase):
    def _call(self, body, record=None, **extra):
        table = Mock()
        table.meta.client.exceptions.ConditionalCheckFailedException = type("ConditionalCheckFailedException", (Exception,), {})
        table.get_item.return_value = {"Item": record} if record is not None else {}
        patchers = [
            patch.object(update_image, "require_admin", return_value=None),
            patch.object(update_image, "table", table),
            patch.object(update_image, "tag_keys_visibility"),
            patch.object(update_image, "preflight_deletion"),
            patch.object(update_image, "delete_keys_all_versions"),
            patch.object(update_image, "_audit"),
        ] + list(extra.values())
        for patcher in patchers:
            patcher.start()
        try:
            return update_image.handler(event(body), None), table
        finally:
            for patcher in reversed(patchers):
                patcher.stop()

    def test_denial_empty_missing_and_media_not_found(self):
        denied = {"statusCode": 403}
        with patch.object(update_image, "require_admin", return_value=denied):
            self.assertIs(update_image.handler({}, None), denied)
        self.assertEqual(self._call({"rawKey": RAW_KEY}, album())[0]["statusCode"], 400)
        self.assertEqual(self._call({"rawKey": RAW_KEY, "blurhash": "x"}, None)[0]["statusCode"], 404)
        self.assertEqual(self._call({"rawKey": RAW_KEY_2, "blurhash": "x"}, album())[0]["statusCode"], 404)

    def test_noncover_shared_and_retained_old_thumbnails_are_not_deleted(self):
        record = album(
            coverImageUrl=RAW_KEY_2,
            coverThumbKey=THUMB_KEY,
            images=[
                {"rawKey": RAW_KEY, "thumbKey": THUMB_KEY},
                {"rawKey": RAW_KEY_2, "thumbKey": THUMB_KEY},
            ],
        )
        response, table = self._call({"rawKey": RAW_KEY, "thumbKey": THUMB_KEY_2, "blurhash": "new"}, record)
        self.assertEqual(response["statusCode"], 200)
        self.assertNotIn("coverThumbKey", table.update_item.call_args.kwargs["UpdateExpression"])
        response, _ = self._call(
            {"rawKey": RAW_KEY, "thumbKey": THUMB_KEY_2},
            album(images=[{"rawKey": RAW_KEY, "thumbKey": ""}]),
        )
        self.assertEqual(response["statusCode"], 200)

    def test_malformed_stored_thumb_deletion_too_large_validation_and_provider(self):
        malformed = album(images=[{"rawKey": RAW_KEY, "thumbKey": "outside.jpg"}])
        self.assertEqual(self._call({"rawKey": RAW_KEY, "thumbKey": THUMB_KEY_2}, malformed)[0]["statusCode"], 200)
        self.assertEqual(
            self._call(
                {"rawKey": RAW_KEY, "thumbKey": THUMB_KEY_2},
                album(),
                too_large=patch.object(update_image, "preflight_deletion", side_effect=update_image.DeletionTooLargeError()),
            )[0]["statusCode"],
            409,
        )
        self.assertEqual(self._call({"rawKey": "bad", "blurhash": "x"}, album())[0]["statusCode"], 400)
        self.assertEqual(
            self._call(
                {"rawKey": RAW_KEY, "thumbKey": THUMB_KEY_2},
                album(),
                error=patch.object(update_image, "tag_keys_visibility", side_effect=RuntimeError("s3")),
            )[0]["statusCode"],
            500,
        )

    def test_conditional_update_conflict(self):
        conditional = type("ConditionalCheckFailedException", (Exception,), {})
        table = Mock()
        table.meta.client.exceptions.ConditionalCheckFailedException = conditional
        table.get_item.return_value = {"Item": album()}
        table.update_item.side_effect = conditional()
        with patch.object(update_image, "require_admin", return_value=None), patch.object(
            update_image, "table", table
        ), patch.object(update_image, "_audit"):
            self.assertEqual(
                update_image.handler(event({"rawKey": RAW_KEY, "blurhash": "new"}), None)["statusCode"],
                409,
            )


class DeleteHandlerBranchTests(unittest.TestCase):
    def test_delete_image_small_helpers(self):
        self.assertEqual(delete_images._raw_key(None), "")
        self.assertEqual(delete_images._raw_key({"key": RAW_KEY}), RAW_KEY)
        self.assertEqual(delete_images._cover_fields(None), ("", "", ""))
        self.assertEqual(delete_images._cover_fields({"rawKey": RAW_KEY, "thumbKey": THUMB_KEY, "blurhash": "h"}), (RAW_KEY, THUMB_KEY, "h"))

    def _delete_images(self, requested, record=None, **extra):
        table = Mock()
        table.meta.client.exceptions.ConditionalCheckFailedException = type("ConditionalCheckFailedException", (Exception,), {})
        table.get_item.return_value = {"Item": record} if record is not None else {}
        patchers = [
            patch.object(delete_images, "require_admin", return_value=None),
            patch.object(delete_images, "table", table),
            patch.object(delete_images, "load_preview_metadata", return_value={}),
            patch.object(delete_images, "validated_preview_keys", return_value={}),
            patch.object(delete_images, "preflight_deletion"),
            patch.object(delete_images, "delete_keys_all_versions", return_value=2),
            patch.object(delete_images, "delete_prefix_all_versions", return_value=3),
            patch.object(delete_images, "delete_preview_metadata"),
            patch.object(delete_images, "_audit"),
        ] + list(extra.values())
        for patcher in patchers:
            patcher.start()
        try:
            return delete_images.handler(event({"keys": requested}), None), table
        finally:
            for patcher in reversed(patchers):
                patcher.stop()

    def test_delete_images_denial_notfound_partial_request_and_noncover_success(self):
        denied = {"statusCode": 403}
        with patch.object(delete_images, "require_admin", return_value=denied):
            self.assertIs(delete_images.handler({}, None), denied)
        self.assertEqual(self._delete_images([RAW_KEY], None)[0]["statusCode"], 404)
        self.assertEqual(self._delete_images([RAW_KEY_2], album())[0]["statusCode"], 404)
        self.assertEqual(self._delete_images([RAW_KEY, RAW_KEY_2], album())[0]["statusCode"], 400)
        record = album(
            coverImageUrl=RAW_KEY_2,
            coverThumbKey=THUMB_KEY_2,
            images=[
                {"rawKey": RAW_KEY, "thumbKey": THUMB_KEY},
                {"rawKey": RAW_KEY_2, "thumbKey": THUMB_KEY_2, "blurhash": "keep"},
            ],
        )
        response, table = self._delete_images([RAW_KEY], record)
        self.assertEqual(response_body(response)["deletedObjectVersions"], 5)
        self.assertEqual(table.update_item.call_args.kwargs["ExpressionAttributeValues"][":cover"], RAW_KEY_2)

    def test_delete_images_too_large_validation_and_unexpected(self):
        self.assertEqual(
            self._delete_images(
                [RAW_KEY], album(), too_large=patch.object(delete_images, "preflight_deletion", side_effect=delete_images.DeletionTooLargeError())
            )[0]["statusCode"],
            413,
        )
        self.assertEqual(self._delete_images(["bad"], album())[0]["statusCode"], 404)
        self.assertEqual(
            self._delete_images(
                [RAW_KEY], album(), failure=patch.object(delete_images, "delete_keys_all_versions", side_effect=RuntimeError("s3"))
            )[0]["statusCode"],
            500,
        )
        self.assertEqual(self._delete_images([None], album())[0]["statusCode"], 400)

    def test_delete_images_conditional_manifest_conflict_and_key_without_derivatives(self):
        conditional = type("ConditionalCheckFailedException", (Exception,), {})
        raw_key = f"albums/{ALBUM_ID}/original/no-extension"
        record = album(images=[{"rawKey": raw_key}], coverImageUrl=raw_key, coverThumbKey="")
        table = Mock()
        table.meta.client.exceptions.ConditionalCheckFailedException = conditional
        table.get_item.return_value = {"Item": record}
        table.update_item.side_effect = conditional()
        with patch.object(delete_images, "require_admin", return_value=None), patch.object(
            delete_images, "table", table
        ), patch.object(delete_images, "load_preview_metadata", return_value={}), patch.object(
            delete_images, "preflight_deletion"
        ), patch.object(delete_images, "delete_keys_all_versions", return_value=1), patch.object(
            delete_images, "delete_preview_metadata"
        ), patch.object(delete_images, "_audit"):
            response = delete_images.handler(event({"keys": [raw_key]}), None)
        self.assertEqual(response["statusCode"], 409)

    def _delete_album(self, record=None, **extra):
        table = Mock()
        table.meta.client.exceptions.ConditionalCheckFailedException = type("ConditionalCheckFailedException", (Exception,), {})
        table.get_item.return_value = {"Item": record} if record is not None else {}
        patchers = [
            patch.object(delete_album, "require_admin", return_value=None),
            patch.object(delete_album, "table", table),
            patch.object(delete_album, "load_preview_metadata", return_value={"media": {}}),
            patch.object(delete_album, "album_media_prefixes", return_value=(f"albums/{ALBUM_ID}/",)),
            patch.object(delete_album, "preflight_deletion"),
            patch.object(delete_album, "delete_prefix_all_versions", return_value=2),
            patch.object(delete_album, "delete_preview_metadata"),
            patch.object(delete_album, "_audit"),
        ] + list(extra.values())
        for patcher in patchers:
            patcher.start()
        try:
            return delete_album.handler(event(), None), table
        finally:
            for patcher in reversed(patchers):
                patcher.stop()

    def test_delete_album_all_outcomes(self):
        denied = {"statusCode": 403}
        with patch.object(delete_album, "require_admin", return_value=denied):
            self.assertIs(delete_album.handler({}, None), denied)
        self.assertEqual(self._delete_album(None)[0]["statusCode"], 404)
        response, table = self._delete_album(album())
        self.assertEqual(response_body(response)["deletedObjectVersions"], 4)
        table.delete_item.assert_called_once()
        self.assertEqual(
            self._delete_album(album(), too_large=patch.object(delete_album, "preflight_deletion", side_effect=delete_album.DeletionTooLargeError()))[0]["statusCode"],
            409,
        )
        self.assertEqual(self._delete_album(album(), invalid=patch.object(delete_album, "album_media_prefixes", side_effect=delete_album.ValidationError("bad")))[0]["statusCode"], 400)
        self.assertEqual(self._delete_album(album(), failure=patch.object(delete_album, "delete_prefix_all_versions", side_effect=RuntimeError("s3")))[0]["statusCode"], 500)

        conditional = type("ConditionalCheckFailedException", (Exception,), {})
        table = Mock()
        table.meta.client.exceptions.ConditionalCheckFailedException = conditional
        table.get_item.return_value = {"Item": album()}
        table.delete_item.side_effect = conditional()
        with patch.object(delete_album, "require_admin", return_value=None), patch.object(
            delete_album, "table", table
        ), patch.object(delete_album, "load_preview_metadata", return_value={}), patch.object(
            delete_album, "album_media_prefixes", return_value=(f"albums/{ALBUM_ID}/",)), patch.object(
            delete_album, "preflight_deletion"
        ), patch.object(delete_album, "delete_prefix_all_versions", return_value=0), patch.object(
            delete_album, "delete_preview_metadata"
        ), patch.object(delete_album, "_audit"):
            self.assertEqual(delete_album.handler(event(), None)["statusCode"], 404)


if __name__ == "__main__":
    unittest.main()
