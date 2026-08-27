import datetime
import io
import json
import os
import unittest
from decimal import Decimal
from unittest.mock import MagicMock, Mock, call, patch

from botocore.exceptions import ClientError

from test_support import claims, gateway_event, response_body

import create_zip
import get_album
import get_albums
import get_download_url
import get_shared_album
import get_upload_url
import tag_media_object
import worker_zip


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
RAW_KEY = f"albums/{ALBUM_ID}/original/photo.jpg"
RAW_KEY_2 = f"albums/{ALBUM_ID}/original/photo-2.jpg"
SHARE_CODE = "share-code-123"


def client_error(code="InternalServerError", operation="Operation"):
    return ClientError({"Error": {"Code": code, "Message": "provider detail"}}, operation)


def album(**overrides):
    value = {
        "albumId": ALBUM_ID,
        "status": "active",
        "visibility": "public",
        "type": "photo",
        "title": "Album",
        "createdAt": "2026-01-01T00:00:00Z",
        "images": [{"rawKey": RAW_KEY}],
        "imageCount": 1,
        "coverImageUrl": RAW_KEY,
        "isShared": False,
    }
    value.update(overrides)
    return value


def request(*, path=None, body=None, query=None, headers=None):
    event = {
        "pathParameters": path or {},
        "requestContext": {"http": {"sourceIp": "192.0.2.20"}},
    }
    if body is not None:
        event["body"] = json.dumps(body)
    if query is not None:
        event["queryStringParameters"] = query
    if headers is not None:
        event["headers"] = headers
    return event


class GetAlbumBranchTests(unittest.TestCase):
    def test_legacy_fallback_filters_derivatives_duplicates_and_stops_at_limit(self):
        paginator = Mock()
        objects = [
            {"Key": RAW_KEY},
            {"Key": RAW_KEY},
            {"Key": f"albums/{ALBUM_ID}/"},
            {"Key": f"albums/{ALBUM_ID}/preview/v2/x.webp"},
            {"Key": f"albums/{ALBUM_ID}/preview/v3/x.webp"},
            {"Key": f"albums/{ALBUM_ID}/thumbnail/thumb_x.jpg"},
            {"Key": f"albums/{ALBUM_ID}/movie_hls/part.ts"},
            {},
            {"Key": RAW_KEY_2},
        ]
        paginator.paginate.return_value = [{"Contents": objects}]
        s3 = Mock()
        s3.get_paginator.return_value = paginator
        with patch.object(get_album, "s3", s3), patch.object(
            get_album, "album_media_prefixes", return_value=(f"albums/{ALBUM_ID}/", "albums/legacy/")
        ):
            self.assertEqual(get_album._legacy_images(album(images=[])), [{"rawKey": RAW_KEY}, {"rawKey": RAW_KEY_2}])
        self.assertEqual(paginator.paginate.call_count, 2)

        paginator.paginate.reset_mock()
        paginator.paginate.return_value = [{"Contents": [{"Key": f"albums/{ALBUM_ID}/original/{index}.jpg"} for index in range(1001)]}]
        with patch.object(get_album, "s3", s3), patch.object(
            get_album, "album_media_prefixes", return_value=(f"albums/{ALBUM_ID}/", "albums/legacy/")
        ):
            self.assertEqual(len(get_album._legacy_images(album(images=[]))), 1001)
        paginator.paginate.assert_called_once()

    def test_handler_notfound_public_legacy_and_private_access_matrix(self):
        table = Mock()
        table.get_item.return_value = {}
        with patch.object(get_album, "table", table):
            self.assertEqual(get_album.handler(request(path={"albumId": ALBUM_ID}), None)["statusCode"], 404)

        table.get_item.return_value = {"Item": album(images=[])}
        with patch.object(get_album, "table", table), patch.object(
            get_album, "get_verified_claims", return_value=None
        ), patch.object(get_album, "_legacy_images", return_value=[{"rawKey": RAW_KEY}]) as fallback, patch.object(
            get_album, "serialize_album_detail", return_value={"albumId": ALBUM_ID}
        ), patch.object(get_album, "serialize_images", return_value=[{"id": "id"}]):
            response = get_album.handler(request(path={"albumId": ALBUM_ID}), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertIn("public, max-age", response["headers"]["Cache-Control"])
        fallback.assert_called_once()

        private = album(visibility="private", ownerSub="owner")
        table.get_item.return_value = {"Item": private}
        with patch.object(get_album, "table", table), patch.object(
            get_album, "get_verified_claims", return_value=None
        ), patch.object(get_album, "_audit") as audit:
            self.assertEqual(get_album.handler(request(path={"albumId": ALBUM_ID}), None)["statusCode"], 401)
        audit.assert_called_once()

        with patch.object(get_album, "table", table), patch.object(
            get_album, "get_verified_claims", return_value=claims(subject="owner")
        ), patch.object(get_album, "serialize_album_detail", return_value={}), patch.object(
            get_album, "serialize_images", return_value=[]
        ), patch.object(get_album, "_audit") as audit:
            response = get_album.handler(request(path={"albumId": ALBUM_ID}), None)
        self.assertEqual(response["headers"]["Cache-Control"], "private, no-store")
        audit.assert_called_once()

    def test_handler_validation_and_protected_provider_failure_audit(self):
        self.assertEqual(get_album.handler(request(path={"albumId": "bad"}), None)["statusCode"], 400)
        table = Mock()
        table.get_item.return_value = {"Item": album(visibility="private", ownerSub="owner")}
        with patch.object(get_album, "table", table), patch.object(
            get_album, "get_verified_claims", return_value=claims(subject="owner")
        ), patch.object(get_album, "serialize_album_detail", side_effect=RuntimeError("boom")), patch.object(
            get_album, "_audit"
        ) as audit:
            self.assertEqual(get_album.handler(request(path={"albumId": ALBUM_ID}), None)["statusCode"], 500)
        self.assertEqual(audit.call_args.args[2:4], ("failure", "unexpected_error"))
        table.get_item.return_value = {"Item": album()}
        with patch.object(get_album, "table", table), patch.object(
            get_album, "get_verified_claims", return_value=None
        ), patch.object(get_album, "authorize_album", side_effect=get_album.AuthError("denied", 403)):
            self.assertEqual(get_album.handler(request(path={"albumId": ALBUM_ID}), None)["statusCode"], 403)
        with patch.object(get_album, "table", table), patch.object(
            get_album, "get_verified_claims", side_effect=RuntimeError("provider")
        ):
            self.assertEqual(get_album.handler(request(path={"albumId": ALBUM_ID}), None)["statusCode"], 500)


class GetAlbumsBranchTests(unittest.TestCase):
    def test_index_feature_phases_and_count_validation(self):
        configured = {
            "VISIBILITY_CREATED_AT_INDEX": "vis",
            "PUBLIC_SUMMARY_INDEX": "summary",
            "OWNER_SUB_CREATED_AT_INDEX": "owner",
        }
        cases = [
            ("none", (False, False, False)),
            ("visibility", (True, False, False)),
            ("summary", (True, True, False)),
            ("both", (True, True, True)),
        ]
        for phase, expected in cases:
            with self.subTest(phase=phase), patch.dict(os.environ, {**configured, "ALBUM_INDEX_DEPLOYMENT_PHASE": phase}):
                self.assertEqual(
                    tuple(get_albums._index_enabled(kind) for kind in ("visibility", "public_summary", "owner")),
                    expected,
                )
        for value, expected in ((True, False), (-1, False), (0, True), (Decimal("2"), True), (Decimal("2.5"), False), ("2", False)):
            self.assertEqual(get_albums._valid_image_count(value), expected)

    def test_filter_building_and_fetch_owner_visibility_admin_scan_paths(self):
        self.assertIsNone(get_albums._type_filter(None))
        self.assertIsNotNone(get_albums._filter_for("private", "photo", owner_sub="sub", owner_email="e@example.com"))
        self.assertIsNotNone(get_albums._filter_for("private", owner_sub="sub"))
        self.assertIsNotNone(get_albums._filter_for("private", owner_email="e@example.com"))

        table = Mock()
        table.query.return_value = {"Items": [album(visibility="private")], "LastEvaluatedKey": None}
        with patch.object(get_albums, "table", table), patch.object(get_albums, "_index_enabled", side_effect=lambda kind: kind == "owner"), patch.dict(
            os.environ, {"OWNER_SUB_CREATED_AT_INDEX": "owner-index"}
        ):
            items, key = get_albums._fetch_page(
                visibility="private", album_type="photo", limit=10, start_key={"albumId": "start"}, owner_sub="sub"
            )
        self.assertEqual(len(items), 1)
        self.assertIsNone(key)
        self.assertEqual(table.query.call_args.kwargs["IndexName"], "owner-index")
        self.assertEqual(table.query.call_args.kwargs["ExclusiveStartKey"], {"albumId": "start"})

        table.reset_mock()
        table.query.return_value = {"Items": [album()], "LastEvaluatedKey": None}
        with patch.object(get_albums, "table", table), patch.object(get_albums, "_index_enabled", return_value=True), patch.dict(
            os.environ, {"VISIBILITY_CREATED_AT_INDEX": "visibility-index"}
        ):
            get_albums._fetch_page(
                visibility="public", album_type="video", limit=2, start_key=None, admin_owner_email="owner@example.com"
            )
        self.assertIn("FilterExpression", table.query.call_args.kwargs)

        table.reset_mock()
        table.scan.return_value = {"Items": [album()], "LastEvaluatedKey": None}
        with patch.object(get_albums, "table", table), patch.object(get_albums, "_index_enabled", return_value=False):
            get_albums._fetch_page(
                visibility="all", album_type=None, limit=2, start_key=None, admin_all=True, admin_owner_email="owner@example.com"
            )
        self.assertIn("FilterExpression", table.scan.call_args.kwargs)

    def test_fetch_retries_filtered_pages_caps_loops_and_propagates_nonindex_errors(self):
        table = Mock()
        table.scan.side_effect = [
            {"Items": [], "LastEvaluatedKey": {"albumId": str(index)}} for index in range(12)
        ]
        with patch.object(get_albums, "table", table), patch.object(get_albums, "_index_enabled", return_value=False):
            items, key = get_albums._fetch_page(visibility="public", album_type=None, limit=2, start_key=None)
        self.assertEqual(items, [])
        self.assertEqual(table.scan.call_count, 12)
        self.assertEqual(key, {"albumId": "11"})

        table.query.side_effect = client_error("AccessDeniedException", "Query")
        with patch.object(get_albums, "table", table), patch.object(get_albums, "_index_enabled", return_value=True), patch.dict(
            os.environ, {"VISIBILITY_CREATED_AT_INDEX": "visibility-index"}
        ):
            with self.assertRaises(ClientError):
                get_albums._fetch_page(visibility="public", album_type=None, limit=2, start_key=None)

    def test_handler_authenticated_public_private_and_error_outcomes(self):
        with patch.object(get_albums, "get_verified_claims", return_value=claims()), patch.object(
            get_albums, "_fetch_page", return_value=([album()], None)
        ) as fetch:
            response = get_albums.handler(request(query={"visibility": "public", "limit": "10"}), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(fetch.call_args.kwargs["visibility"], "public")

        private = album(visibility="private", ownerSub="user-sub", ownerEmail="user@example.com")
        with patch.object(get_albums, "get_verified_claims", return_value=claims()), patch.object(
            get_albums, "_fetch_page", return_value=([private], {"albumId": ALBUM_ID})
        ) as fetch:
            response = get_albums.handler(request(query={"visibility": "private", "type": "photo"}), None)
        self.assertEqual(fetch.call_args.kwargs["owner_sub"], "user-sub")
        self.assertIsNotNone(response_body(response)["nextCursor"])

        with patch.object(get_albums, "get_verified_claims", return_value=claims(groups=["Admins"])), patch.object(
            get_albums, "_fetch_page", return_value=([], None)
        ) as fetch:
            response = get_albums.handler(request(query={"visibility": "private", "ownerEmail": "OWNER@example.com"}), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(fetch.call_args.kwargs["admin_owner_email"], "owner@example.com")

        with patch.object(get_albums, "get_verified_claims", side_effect=RuntimeError("boom")):
            self.assertEqual(get_albums.handler(request(query={}), None)["statusCode"], 500)
        with patch.object(get_albums, "get_verified_claims", return_value=None):
            self.assertEqual(get_albums.handler(request(query={"limit": "bad"}), None)["statusCode"], 400)
        with patch.object(get_albums, "get_verified_claims", return_value=None), patch.object(
            get_albums, "_fetch_page", return_value=([album()], None)
        ), patch.object(get_albums, "serialize_album_summary", side_effect=get_albums.ValidationError("bad")):
            self.assertEqual(response_body(get_albums.handler(request(query={"limit": "5"}), None))["items"], [])

    def test_additional_scan_filter_branches(self):
        table = Mock()
        table.scan.return_value = {"Items": [], "LastEvaluatedKey": None}
        with patch.object(get_albums, "table", table), patch.object(get_albums, "_index_enabled", return_value=False):
            get_albums._fetch_page(
                visibility="all", album_type="photo", limit=2, start_key=None, admin_all=True
            )
            get_albums._fetch_page(
                visibility="public", album_type=None, limit=2, start_key=None,
                admin_owner_email="owner@example.com",
            )
            get_albums._fetch_page(
                visibility="all", album_type=None, limit=2, start_key=None, admin_all=True
            )
        self.assertEqual(table.scan.call_count, 3)
        self.assertNotIn("FilterExpression", table.scan.call_args_list[-1].kwargs)


class SharedAlbumBranchTests(unittest.TestCase):
    def _call(self, *, code=SHARE_CODE, verify=True, allowed=True, items=None, authorize_error=None, query_error=None):
        table = Mock()
        table.query.return_value = {"Items": items if items is not None else [album(visibility="unlisted", isShared=True, shareCode=code)]}
        table.query.side_effect = query_error
        with patch.object(get_shared_album, "table", table), patch.object(
            get_shared_album, "verify_turnstile", return_value=verify
        ), patch.object(get_shared_album, "check_rate_limit", return_value=allowed), patch.object(
            get_shared_album, "authorize_album", side_effect=authorize_error
        ), patch.object(get_shared_album, "serialize_album_detail", return_value={"albumId": ALBUM_ID}), patch.object(
            get_shared_album, "serialize_images", return_value=[]
        ), patch.object(get_shared_album, "_audit"):
            response = get_shared_album.handler(
                request(path={"shareCode": code}, headers={"X-Turnstile-Token": "token"}), None
            )
        return response, table

    def test_invalid_captcha_rate_cardinality_success_and_auth_hiding(self):
        self.assertEqual(self._call(code="bad")[0]["statusCode"], 404)
        response, table = self._call(verify=False)
        self.assertEqual(response["statusCode"], 403)
        table.query.assert_not_called()
        self.assertEqual(self._call(allowed=False)[0]["statusCode"], 429)
        for items in ([], [album(), album()]):
            self.assertEqual(self._call(items=items)[0]["statusCode"], 404)
        success = self._call()[0]
        self.assertEqual(success["statusCode"], 200)
        self.assertEqual(success["headers"]["Cache-Control"], "private, no-store")
        self.assertEqual(
            self._call(authorize_error=get_shared_album.AuthError("denied", 403))[0]["statusCode"], 404
        )
        self.assertEqual(
            self._call(authorize_error=get_shared_album.AuthError("odd", 418))[0]["statusCode"], 418
        )

    def test_validation_and_unexpected_errors(self):
        self.assertEqual(
            self._call(authorize_error=get_shared_album.ValidationError("bad"))[0]["statusCode"], 404
        )
        self.assertEqual(self._call(query_error=RuntimeError("db"))[0]["statusCode"], 500)


class UploadDownloadBranchTests(unittest.TestCase):
    def test_upload_intent_all_rejections_and_thumbnail_normalization(self):
        base = {"albumId": ALBUM_ID, "filename": "photo.jpg", "contentType": "image/jpeg", "size": 1}
        invalid = [
            {**base, "filename": ".."},
            {**base, "kind": "other"},
            {**base, "size": "bad"},
            {**base, "size": 0},
            {**base, "filename": "photo.png"},
            {**base, "size": 101 * 1024 * 1024},
            {**base, "kind": "thumbnail", "contentType": "image/png"},
        ]
        for candidate in invalid:
            with self.subTest(candidate=candidate):
                with self.assertRaises(get_upload_url.ValidationError):
                    get_upload_url._validate_upload_intent(candidate)
        result = get_upload_url._validate_upload_intent({**base, "filename": "path\\photo.jpeg", "kind": "thumbnail"})
        self.assertEqual(result[2:4], ("thumbnail", ".jpg"))

    def test_upload_handler_denied_ttl_bounds_validation_and_provider_failure(self):
        denied = {"statusCode": 403}
        with patch.object(get_upload_url, "require_admin", return_value=denied):
            self.assertIs(get_upload_url.handler({}, None), denied)
        s3 = Mock()
        s3.generate_presigned_url.return_value = "signed"
        with patch.object(get_upload_url, "require_admin", return_value=None), patch.object(
            get_upload_url, "s3", s3
        ), patch.object(get_upload_url, "_audit"), patch.object(get_upload_url.uuid, "uuid4", return_value=Mock(hex="fixed")), patch.dict(
            os.environ, {"UPLOAD_URL_TTL_SECONDS": "9999"}
        ):
            response = get_upload_url.handler(request(body={
                "albumId": ALBUM_ID, "filename": "photo.jpg", "contentType": "image/jpeg", "size": 2
            }), None)
        self.assertEqual(response_body(response)["expiresIn"], 900)
        self.assertEqual(s3.generate_presigned_url.call_args.kwargs["Params"]["ContentLength"], 2)
        with patch.object(get_upload_url, "require_admin", return_value=None), patch.object(get_upload_url, "_audit"):
            self.assertEqual(get_upload_url.handler(request(body={}), None)["statusCode"], 400)
        with patch.object(get_upload_url, "require_admin", return_value=None), patch.object(
            get_upload_url, "_validate_upload_intent", side_effect=RuntimeError("boom")
        ), patch.object(get_upload_url, "_audit"):
            self.assertEqual(get_upload_url.handler(request(body={}), None)["statusCode"], 500)

    def _download(self, path, *, record=None, claims_value=None, authorize_error=None, image=None, rate=True, provider_error=None):
        media_id = "a" * 24
        with patch.object(get_download_url, "get_album_record", return_value=record), patch.object(
            get_download_url, "get_verified_claims", return_value=claims_value
        ), patch.object(get_download_url, "authorize_album", side_effect=authorize_error), patch.object(
            get_download_url, "find_image_by_media_id", return_value=image
        ), patch.object(get_download_url, "check_rate_limit", return_value=rate), patch.object(
            get_download_url, "presigned_get_url", side_effect=provider_error or (lambda *args, **kwargs: "signed")
        ), patch.object(get_download_url, "url_expiry_metadata", return_value={"expiresIn": 60}), patch.object(
            get_download_url, "_audit"
        ):
            return get_download_url.handler(request(path=path, body={"mediaId": media_id}), None)

    def test_download_album_share_missing_rate_auth_validation_and_provider_paths(self):
        self.assertEqual(self._download({}, record=None)["statusCode"], 404)
        self.assertEqual(self._download({"albumId": ALBUM_ID}, record=None)["statusCode"], 404)
        self.assertEqual(self._download({"shareCode": SHARE_CODE}, record=None)["statusCode"], 404)
        shared = album(visibility="unlisted", isShared=True, shareCode=SHARE_CODE)
        response = self._download({"shareCode": SHARE_CODE}, record=shared, image={"rawKey": RAW_KEY})
        self.assertEqual(response["statusCode"], 200)
        response = self._download({"albumId": ALBUM_ID}, record=album(), image={"rawKey": RAW_KEY}, rate=False)
        self.assertEqual(response["statusCode"], 429)
        response = self._download(
            {"albumId": ALBUM_ID}, record=album(visibility="private"), authorize_error=get_download_url.AuthError("denied", 403)
        )
        self.assertEqual(response["statusCode"], 403)
        response = self._download(
            {"shareCode": SHARE_CODE}, record=shared, authorize_error=get_download_url.AuthError("denied", 403)
        )
        self.assertEqual(response["statusCode"], 404)
        response = self._download(
            {"albumId": ALBUM_ID}, record=album(), image={"rawKey": "outside.jpg"}
        )
        self.assertEqual(response["statusCode"], 404)
        response = self._download(
            {"albumId": ALBUM_ID}, record=album(), image={"rawKey": RAW_KEY}, provider_error=RuntimeError("s3")
        )
        self.assertEqual(response["statusCode"], 500)
        with patch.object(get_download_url, "get_album_record", return_value=album()), patch.object(
            get_download_url, "get_verified_claims", return_value=None
        ), patch.object(get_download_url, "authorize_album"), patch.object(get_download_url, "_audit"):
            response = get_download_url.handler(
                request(path={"albumId": ALBUM_ID}, body={"mediaId": "not-hex"}), None
            )
        self.assertEqual(response["statusCode"], 404)


class CreateZipBranchTests(unittest.TestCase):
    def _call(self, path, *, record=None, claims_value=None, authorize_error=None, rate=True, list_effect=None):
        s3 = Mock()
        if list_effect is None and record:
            zip_key, _ = create_zip.zip_keys(record)
            s3.list_objects_v2.return_value = {"Contents": [{"Key": zip_key}]}
        else:
            s3.list_objects_v2.side_effect = list_effect
        worker = Mock()
        with patch.object(create_zip, "get_album_record", return_value=record), patch.object(
            create_zip, "get_verified_claims", return_value=claims_value
        ), patch.object(create_zip, "authorize_album", side_effect=authorize_error), patch.object(
            create_zip, "check_rate_limit", return_value=rate
        ), patch.object(create_zip, "s3", s3), patch.object(create_zip, "lambda_client", worker), patch.object(
            create_zip, "presigned_get_url", return_value="signed"
        ), patch.object(create_zip, "_audit"):
            response = create_zip.handler(request(path=path), None)
        return response, s3, worker

    def test_lookup_visibility_type_empty_size_rate_and_ready_paths(self):
        self.assertEqual(self._call({}, record=None)[0]["statusCode"], 404)
        self.assertEqual(self._call({"albumId": ALBUM_ID}, record=None)[0]["statusCode"], 404)
        self.assertEqual(self._call({"shareCode": SHARE_CODE}, record=None)[0]["statusCode"], 404)
        self.assertEqual(self._call({"albumId": ALBUM_ID}, record=album(type="audio"))[0]["statusCode"], 400)
        self.assertIn(
            self._call({"albumId": ALBUM_ID}, record=album(type="video"))[0]["statusCode"],
            {200, 202},
        )
        self.assertEqual(self._call({"albumId": ALBUM_ID}, record=album(images=[]))[0]["statusCode"], 400)
        with patch.dict(os.environ, {"ZIP_MAX_OBJECTS": "1"}):
            self.assertEqual(self._call({"albumId": ALBUM_ID}, record=album(images=[{"rawKey": RAW_KEY}, {"rawKey": RAW_KEY_2}]))[0]["statusCode"], 413)
        self.assertEqual(self._call({"albumId": ALBUM_ID}, record=album(), rate=False)[0]["statusCode"], 429)
        response, _, _ = self._call({"albumId": ALBUM_ID}, record=album())
        self.assertEqual(response_body(response)["status"], "ready")

    def test_share_processing_stale_and_active_locks_and_provider_errors(self):
        shared = album(visibility="unlisted", isShared=True, shareCode=SHARE_CODE)
        stale = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=901)
        _, shared_lock = create_zip.zip_keys(shared)
        response, s3, worker = self._call(
            {"shareCode": SHARE_CODE},
            record=shared,
            list_effect=[
                {"Contents": []},
                {"Contents": [{"Key": shared_lock, "LastModified": stale}]},
            ],
        )
        self.assertEqual(response["statusCode"], 202)
        s3.put_object.assert_called_once()
        worker.invoke.assert_called_once()

        recent = datetime.datetime.now(datetime.timezone.utc)
        active = album()
        _, active_lock = create_zip.zip_keys(active)
        response, s3, worker = self._call(
            {"albumId": ALBUM_ID},
            record=active,
            list_effect=[
                {"Contents": []},
                {"Contents": [{"Key": active_lock, "LastModified": recent}]},
            ],
        )
        self.assertEqual(response["statusCode"], 202)
        s3.put_object.assert_not_called()
        worker.invoke.assert_not_called()

        self.assertEqual(
            self._call({"albumId": ALBUM_ID}, record=album(visibility="private"), authorize_error=create_zip.AuthError("no", 403))[0]["statusCode"],
            403,
        )
        self.assertEqual(
            self._call({"albumId": "bad"}, record=album())[0]["statusCode"],
            400,
        )
        self.assertEqual(
            self._call(
                {"albumId": ALBUM_ID},
                record=album(),
                list_effect=client_error("AccessDenied", "ListObjectsV2"),
            )[0]["statusCode"],
            500,
        )
        self.assertEqual(
            self._call(
                {"albumId": ALBUM_ID},
                record=album(),
                list_effect=[{"Contents": []}, client_error("AccessDenied", "ListObjectsV2")],
            )[0]["statusCode"],
            500,
        )
        self.assertEqual(
            self._call(
                {"albumId": ALBUM_ID},
                record=album(),
                list_effect=[{"Contents": "malformed"}],
            )[0]["statusCode"],
            500,
        )


class WorkerZipBranchTests(unittest.TestCase):
    def test_stream_multipart_write_close_cancel_and_idempotence(self):
        s3 = Mock()
        s3.create_multipart_upload.return_value = {"UploadId": "upload"}
        s3.upload_part.side_effect = [{"ETag": "one"}, {"ETag": "two"}, {"ETag": "three"}]
        with patch.object(worker_zip, "s3", s3):
            stream = worker_zip.StreamToS3("bucket", "archive.zip")
            stream.part_size = 3
            self.assertTrue(stream.writable())
            self.assertEqual(stream.write(b"abcdefg"), 7)
            stream.close()
            stream.close()
        self.assertEqual(s3.upload_part.call_count, 3)
        s3.complete_multipart_upload.assert_called_once()

        s3.reset_mock()
        s3.create_multipart_upload.return_value = {"UploadId": "upload"}
        with patch.object(worker_zip, "s3", s3):
            stream = worker_zip.StreamToS3("bucket", "archive.zip")
            stream.cancel()
            stream.cancel()
        s3.abort_multipart_upload.assert_called_once()
        s3.reset_mock()
        s3.create_multipart_upload.return_value = {"UploadId": "upload"}
        with patch.object(worker_zip, "s3", s3):
            empty = worker_zip.StreamToS3("bucket", "empty.zip")
            empty.close()
        s3.upload_part.assert_not_called()

    def test_validated_album_id_share_missing_and_unavailable(self):
        with patch.object(worker_zip, "get_album_record", return_value=None):
            with self.assertRaises(worker_zip.ValidationError):
                worker_zip._validated_album({"albumId": ALBUM_ID})
        for record in (album(status="pending"), album(visibility="unknown")):
            with patch.object(worker_zip, "get_album_record", return_value=record):
                with self.assertRaises(worker_zip.ValidationError):
                    worker_zip._validated_album({"albumId": ALBUM_ID})
        active = album()
        with patch.object(worker_zip, "get_album_record", return_value=active):
            self.assertIs(worker_zip._validated_album({"albumId": ALBUM_ID}), active)
        shared = album(visibility="unlisted", isShared=True, shareCode=SHARE_CODE)
        with patch.object(worker_zip, "get_album_record", return_value=shared), patch.object(
            worker_zip, "authorize_album", return_value="share"
        ):
            self.assertIs(worker_zip._validated_album({"shareCode": SHARE_CODE}), shared)
        with self.assertRaises(worker_zip.ValidationError):
            worker_zip._validated_album({})

    def test_handler_success_byte_object_and_type_quota_failures(self):
        s3 = Mock()
        s3.head_object.return_value = {"ContentLength": 4}
        body = io.BytesIO(b"data")
        s3.get_object.return_value = {"Body": body}
        stream = MagicMock()
        archive = MagicMock()
        destination = MagicMock()
        archive.__enter__.return_value.open.return_value = destination
        destination.__enter__.return_value = destination
        with patch.object(worker_zip, "s3", s3), patch.object(worker_zip, "_validated_album", return_value=album()), patch.object(
            worker_zip, "StreamToS3", return_value=stream
        ), patch.object(worker_zip.zipfile, "ZipFile", return_value=archive) as zip_file, patch.object(
            worker_zip, "tag_keys_visibility"
        ):
            result = worker_zip.handler({"albumId": ALBUM_ID}, None)
        self.assertEqual(result, {"status": "complete", "objectCount": 1, "totalBytes": 4})
        stream.close.assert_called_once()
        destination.write.assert_called_once_with(b"data")
        zip_file.assert_called_once_with(
            stream,
            "w",
            compression=worker_zip.zipfile.ZIP_DEFLATED,
            compresslevel=6,
            allowZip64=True,
        )

        for record, env in (
            (album(type="audio"), {}),
            (album(images=[]), {}),
            (album(images=[{"rawKey": RAW_KEY}, {"rawKey": RAW_KEY_2}]), {"ZIP_MAX_OBJECTS": "1"}),
        ):
            with self.subTest(record=record), patch.object(worker_zip, "_validated_album", return_value=record), patch.dict(
                os.environ, env, clear=False
            ):
                with self.assertRaises(worker_zip.ValidationError):
                    worker_zip.handler({}, None)
        with patch.object(worker_zip, "_validated_album", return_value=album()), patch.object(
            worker_zip, "s3", s3
        ), patch.dict(os.environ, {"ZIP_MAX_TOTAL_BYTES": "3"}):
            with self.assertRaisesRegex(worker_zip.ValidationError, "byte quota"):
                worker_zip.handler({}, None)

    def test_handler_failure_cancels_stream_and_lock_cleanup_failures_do_not_mask(self):
        s3 = Mock()
        s3.head_object.return_value = {"ContentLength": 1}
        s3.delete_object.side_effect = RuntimeError("cleanup")
        stream = Mock()
        stream.cancel.side_effect = RuntimeError("cancel")
        with patch.object(worker_zip, "s3", s3), patch.object(worker_zip, "_validated_album", return_value=album()), patch.object(
            worker_zip, "zip_keys", return_value=("zip", "lock")
        ), patch.object(worker_zip, "StreamToS3", return_value=stream), patch.object(
            worker_zip.zipfile, "ZipFile", side_effect=RuntimeError("archive")
        ):
            with self.assertRaisesRegex(RuntimeError, "archive"):
                worker_zip.handler({}, None)
        stream.cancel.assert_called_once()
        s3.delete_object.assert_called_once()


class TagMediaObjectBranchTests(unittest.TestCase):
    def test_album_id_parser_and_handler_bucket_skip_pending_and_visibility(self):
        self.assertIsNone(tag_media_object._album_id_from_key("other/key/file"))
        self.assertIsNone(tag_media_object._album_id_from_key("albums/not-a-uuid/file"))
        self.assertEqual(tag_media_object._album_id_from_key(RAW_KEY), ALBUM_ID)
        bad_bucket = request()
        bad_bucket["Records"] = [{"s3": {"bucket": {"name": "other"}, "object": {"key": RAW_KEY}}}]
        with self.assertRaises(ValueError):
            tag_media_object.handler(bad_bucket, None)

        records = [
            {"s3": {"bucket": {"name": "images-test"}, "object": {"key": "not-an-album"}}},
            {"s3": {"bucket": {"name": "images-test"}, "object": {"key": RAW_KEY.replace("/", "%2F")}}},
        ]
        table = Mock()
        table.get_item.return_value = {"Item": album(status="pending", visibility="public")}
        with patch.object(tag_media_object, "table", table), patch.object(
            tag_media_object, "tag_keys_visibility", return_value=1
        ) as tag:
            self.assertEqual(tag_media_object.handler({"Records": records}, None), {"tagged": 1})
        tag.assert_called_once_with([RAW_KEY], "pending")

        table.get_item.return_value = {"Item": album(visibility="unlisted")}
        with patch.object(tag_media_object, "table", table), patch.object(
            tag_media_object, "tag_keys_visibility", return_value=1
        ) as tag:
            tag_media_object.handler({"Records": [records[1]]}, None)
        tag.assert_called_once_with([RAW_KEY], "unlisted")


if __name__ == "__main__":
    unittest.main()
