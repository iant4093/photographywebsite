import io
import json
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
OPS = ROOT / "ops"
if str(OPS) not in sys.path:
    sys.path.insert(0, str(OPS))

import backfill_album_owner_sub as owner_backfill
import backfill_legacy_media_prefix as legacy_backfill
import backfill_preview_v2 as preview_backfill
import tag_existing_media


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
SECOND_ID = "22222222-2222-4222-8222-222222222222"
SUBJECT = "33333333-3333-4333-8333-333333333333"


def string(value):
    return {"S": value}


def dynamo(value):
    if value is None:
        return {"NULL": True}
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, (int, float)):
        return {"N": str(value)}
    if isinstance(value, list):
        return {"L": [dynamo(item) for item in value]}
    if isinstance(value, dict):
        return {"M": {key: dynamo(item) for key, item in value.items()}}
    raise TypeError(value)


def record(**values):
    return {key: dynamo(value) for key, value in values.items()}


def json_documents(output):
    decoder = json.JSONDecoder()
    documents = []
    position = 0
    while position < len(output):
        start = output.find("{", position)
        if start < 0:
            break
        value, position = decoder.raw_decode(output, start)
        documents.append(value)
    return documents


class MainMixin:
    def invoke(self, module, *arguments):
        with patch.object(sys, "argv", [module.__file__, *arguments]), patch(
            "sys.stdout", new_callable=io.StringIO
        ) as output:
            result = module.main()
        return result, output.getvalue()


class OwnerBackfillHelperTests(unittest.TestCase):
    def test_scalar_attributes_uuid_and_pagination(self):
        self.assertIsNone(owner_backfill.scalar({"x": "bad"}, "x"))
        self.assertIsNone(owner_backfill.scalar({"x": {"S": ""}}, "x"))
        self.assertEqual(owner_backfill.scalar({"x": {"S": "value"}}, "x"), "value")
        self.assertEqual(
            owner_backfill.user_attributes(
                {"Attributes": [{"Name": "email", "Value": "e"}, {"Name": 1, "Value": "bad"}, "bad"]}
            ),
            {"email": "e"},
        )
        self.assertEqual(owner_backfill.valid_uuid(ALBUM_ID), ALBUM_ID)
        self.assertIsNone(owner_backfill.valid_uuid(None))
        self.assertIsNone(owner_backfill.valid_uuid("bad"))

        pages = [
            {"Items": [{"x": string("one")}], "LastEvaluatedKey": {"id": string("one")}},
            {"Items": [{"x": string("two")}]},
        ]
        with patch.object(owner_backfill, "aws_json", side_effect=pages) as aws:
            self.assertEqual(len(owner_backfill.scan_all("table", None, "r")), 2)
        self.assertIn("--exclusive-start-key", aws.call_args_list[1].args[0])
        for pages in (
            [{"Items": "bad"}],
            [
                {"Items": [], "LastEvaluatedKey": {"id": string("one")}},
                {"Items": [], "LastEvaluatedKey": {"id": string("one")}},
            ],
        ):
            with self.subTest(pages=pages), patch.object(owner_backfill, "aws_json", side_effect=pages), self.assertRaises(
                RuntimeError
            ):
                owner_backfill.scan_all("table", None, "r")

        user_pages = [
            {"Users": [{"Username": "one"}], "PaginationToken": "next"},
            {"Users": [{"Username": "two"}]},
        ]
        with patch.object(owner_backfill, "aws_json", side_effect=user_pages) as aws:
            self.assertEqual(len(owner_backfill.list_users_all("pool", None, "r")), 2)
        self.assertIn("--pagination-token", aws.call_args_list[1].args[0])
        for page in (
            {"Users": "bad"},
            {"Users": [], "PaginationToken": 1},
        ):
            with self.subTest(page=page), patch.object(owner_backfill, "aws_json", return_value=page), self.assertRaises(
                RuntimeError
            ):
                owner_backfill.list_users_all("pool", None, "r")

    def test_plan_counts_every_safe_and_unsafe_category(self):
        users = [
            {"Attributes": [{"Name": "email", "Value": "owner@example.com"}, {"Name": "sub", "Value": SUBJECT}]},
            {"Attributes": [{"Name": "email", "Value": "ambiguous@example.com"}, {"Name": "sub", "Value": SUBJECT}]},
            {"Attributes": [{"Name": "email", "Value": "ambiguous@example.com"}, {"Name": "sub", "Value": SECOND_ID}]},
            {"Attributes": [{"Name": "email", "Value": "bad"}, {"Name": "sub", "Value": "bad"}]},
        ]
        base = {"albumId": string(ALBUM_ID), "visibility": string("private"), "ownerEmail": string("owner@example.com")}
        albums = [
            base,
            {**base, "ownerSub": string(SUBJECT)},
            {**base, "ownerSub": string("bad")},
            {**base, "visibility": string("public")},
            {**base, "status": string("pending")},
            {**base, "albumId": string("bad")},
            {k: v for k, v in base.items() if k != "ownerEmail"},
            {**base, "ownerEmail": string("bad")},
            {**base, "ownerEmail": string("missing@example.com")},
            {**base, "ownerEmail": string("ambiguous@example.com")},
        ]
        candidates, counts = owner_backfill.build_backfill_plan(albums, users)
        self.assertEqual(candidates, [(ALBUM_ID, SUBJECT)])
        for key, value in counts.items():
            with self.subTest(key=key):
                self.assertGreaterEqual(value, 1)


class OwnerBackfillMainTests(MainMixin, unittest.TestCase):
    def base(self, *, counts=None, aws_update=None):
        albums = [{"albumId": string(ALBUM_ID)}]
        users = [{}]
        selected_counts = {"ambiguousOwnerEmailCount": 0} if counts is None else counts

        def aws(arguments, profile, region):
            if arguments[:2] == ["sts", "get-caller-identity"]:
                return {"Account": "123"}
            if arguments[:2] == ["dynamodb", "update-item"]:
                if aws_update:
                    raise aws_update
                return {}
            raise AssertionError(arguments)

        return albums, users, selected_counts, aws

    def run_owner(self, *arguments, counts=None, aws_update=None):
        albums, users, selected_counts, aws = self.base(counts=counts, aws_update=aws_update)
        with patch.object(owner_backfill, "aws_json", side_effect=aws), patch.object(
            owner_backfill, "stack_resource", side_effect=["table", "pool"]
        ), patch.object(owner_backfill, "scan_all", return_value=albums), patch.object(
            owner_backfill, "list_users_all", return_value=users
        ), patch.object(
            owner_backfill, "build_backfill_plan", return_value=([(ALBUM_ID, SUBJECT)], selected_counts)
        ):
            return self.invoke(owner_backfill, "--stack-name", "stack", *arguments)

    def test_dry_run_every_apply_guard_and_update(self):
        result, output = self.run_owner()
        self.assertEqual(result, 0)
        self.assertIn("Dry run only", output)
        guard_sets = (
            ("--expected-account-id", "wrong"),
            ("--expected-account-id", "123", "--expected-record-count", "0"),
            ("--expected-account-id", "123", "--expected-record-count", "1", "--confirm-stack-name", "wrong"),
            ("--expected-account-id", "123", "--expected-record-count", "1", "--confirm-stack-name", "stack", "--confirm", "wrong"),
        )
        for guards in guard_sets:
            with self.subTest(guards=guards), self.assertRaises(SystemExit):
                self.run_owner("--apply", *guards)
        complete = (
            "--apply",
            "--expected-account-id",
            "123",
            "--expected-record-count",
            "1",
            "--confirm-stack-name",
            "stack",
            "--confirm",
            "backfill-album-owner-sub",
        )
        with self.assertRaisesRegex(SystemExit, "ambiguous"):
            self.run_owner(*complete, counts={"ambiguousOwnerEmailCount": 1})
        result, output = self.run_owner(*complete)
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(output[output.rfind("{") :])["updatedCount"], 1)

        conflict = subprocess.CalledProcessError(1, ["aws"], stderr="ConditionalCheckFailedException")
        result, output = self.run_owner(*complete, aws_update=conflict)
        self.assertEqual(result, 1)
        other = subprocess.CalledProcessError(1, ["aws"], stderr="AccessDenied")
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_owner(*complete, aws_update=other)


class LegacyBackfillHelperTests(unittest.TestCase):
    def test_decode_identifiers_prefixes_keys_and_media_manifests(self):
        values = (
            ({"S": "value"}, "value"),
            ({"S": 1}, None),
            ({"L": [{"S": "value"}, {"NULL": True}]}, ["value", None]),
            ({"M": {"key": {"S": "value"}}}, {"key": "value"}),
            ({"NULL": True}, None),
            ({"X": "value"}, None),
            ({"S": "a", "N": "1"}, None),
            ("value", None),
        )
        for encoded, expected in values:
            with self.subTest(encoded=encoded):
                self.assertEqual(legacy_backfill.decode(encoded), expected)

        self.assertEqual(legacy_backfill.valid_uuid(ALBUM_ID), ALBUM_ID)
        for value in (None, "bad", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"):
            with self.subTest(uuid=value):
                self.assertIsNone(legacy_backfill.valid_uuid(value))
        self.assertEqual(legacy_backfill.valid_prefix("albums/a/"), "albums/a/")
        for value in (None, "albums/A/", "albums/a//", f"albums/{'a' * 221}/"):
            with self.subTest(prefix=value):
                self.assertIsNone(legacy_backfill.valid_prefix(value))

        prefix = "albums/safe/"
        malformed = (
            None,
            "",
            "a" * 1025,
            " albums/safe/a.jpg",
            "/albums/safe/a.jpg",
            "albums\\safe\\a.jpg",
            "albums/safe/a.jpg\x00",
            "albums/safe/../a.jpg",
        )
        for value in malformed:
            with self.subTest(key=value):
                self.assertEqual(legacy_backfill.classify_key(value, prefix), "malformed")
        self.assertEqual(legacy_backfill.classify_key("albums/other/a.jpg", prefix), "cross")
        self.assertEqual(legacy_backfill.classify_key(prefix.rstrip("/"), prefix), "cross")
        self.assertEqual(legacy_backfill.classify_key("albums/safe/a.jpg", prefix), "ok")

        album = record(
            coverImageUrl="albums/safe/cover.jpg",
            coverThumbKey="",
            images=[
                "albums/safe/plain.jpg",
                {
                    "rawKey": "albums/safe/raw.jpg",
                    "thumbKey": "albums/safe/thumb.jpg",
                    "hlsUrl": "albums/safe/video.m3u8",
                },
                {"key": "albums/safe/fallback.jpg"},
                5,
            ],
        )
        keys = legacy_backfill.record_media_keys(album)
        self.assertEqual(len(keys), 7)
        self.assertIn(None, keys)
        self.assertEqual(legacy_backfill.record_media_keys(record(images=None)), [])
        self.assertEqual(legacy_backfill.record_media_keys(record(images="bad")), [None])

    def test_scan_paginates_and_fails_closed(self):
        token = {"albumId": string(ALBUM_ID)}
        with patch.object(
            legacy_backfill,
            "aws_json",
            side_effect=[{"Items": [{"one": string("1")}], "LastEvaluatedKey": token}, {"Items": [{}]}],
        ) as aws:
            self.assertEqual(len(legacy_backfill.scan_all("table", "profile", "region")), 2)
        self.assertIn("--exclusive-start-key", aws.call_args_list[1].args[0])

        for pages in (
            [{"Items": "malformed"}],
            [{"Items": [], "LastEvaluatedKey": token}, {"Items": [], "LastEvaluatedKey": token}],
        ):
            with self.subTest(pages=pages), patch.object(legacy_backfill, "aws_json", side_effect=pages), self.assertRaises(
                RuntimeError
            ):
                legacy_backfill.scan_all("table", None, None)

    def test_plan_covers_safe_and_every_unsafe_category(self):
        def album(album_id, prefix, *, existing=None, images=None):
            values = {
                "albumId": album_id,
                "s3Prefix": prefix,
                "images": [] if images is None else images,
            }
            if existing is not None:
                values["legacyS3Prefix"] = existing
            return record(**values)

        albums = [
            album(ALBUM_ID, "albums/safe/", images=[{"rawKey": "albums/safe/a.jpg"}]),
            album(SECOND_ID, "albums/approved/", existing="albums/approved/"),
            album("bad", "albums/bad-id/"),
            album(SUBJECT, "bad-prefix"),
            album("44444444-4444-4444-8444-444444444444", "albums/duplicate/"),
            album("55555555-5555-4555-8555-555555555555", "albums/duplicate/"),
            album("66666666-6666-4666-8666-666666666666", "albums/conflict/", existing="albums/other/"),
            album("77777777-7777-4777-8777-777777777777", "albums/malformed/", images=[{"rawKey": " ../bad.jpg"}]),
            album("88888888-8888-4888-8888-888888888888", "albums/cross/", images=[{"rawKey": "albums/other/a.jpg"}]),
        ]
        candidates, counts = legacy_backfill.build_backfill_plan(albums)
        self.assertEqual(candidates, [(ALBUM_ID, "albums/safe/")])
        for key, value in counts.items():
            with self.subTest(key=key):
                self.assertGreaterEqual(value, 1)
        self.assertEqual(
            legacy_backfill.plan_digest(candidates),
            legacy_backfill.plan_digest(list(reversed(candidates))),
        )


class PreviewBackfillHelperTests(unittest.TestCase):
    def test_decode_normalization_scan_and_metadata_index(self):
        values = (
            ({"S": "value"}, "value"),
            ({"S": 1}, None),
            ({"N": "2"}, 2),
            ({"N": "2.5"}, 2.5),
            ({"N": "bad"}, None),
            ({"L": [{"S": "value"}]}, ["value"]),
            ({"M": {"key": {"S": "value"}}}, {"key": "value"}),
            ({"BOOL": True}, True),
            ({"BOOL": "true"}, None),
            ({"NULL": True}, None),
            ({"X": "value"}, None),
            ({"S": "a", "N": "1"}, None),
            ("value", None),
        )
        for encoded, expected in values:
            with self.subTest(encoded=encoded):
                self.assertEqual(preview_backfill.decode(encoded), expected)
        self.assertEqual(preview_backfill.decoded_item({"a": string("b")}), {"a": "b"})

        self.assertEqual(preview_backfill.normalized_uuid(ALBUM_ID), ALBUM_ID)
        for value in (None, "bad", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"):
            self.assertIsNone(preview_backfill.normalized_uuid(value))
        valid_key = f"albums/{ALBUM_ID}/original/a.jpg"
        self.assertEqual(preview_backfill.normalized_key(valid_key), valid_key)
        for value in (
            None,
            "",
            "a" * 1025,
            " a.jpg",
            "/a.jpg",
            "a\\b.jpg",
            "a.jpg\x00",
            "a/../b.jpg",
            "a/",
            "../a.jpg",
        ):
            with self.subTest(key=value):
                self.assertIsNone(preview_backfill.normalized_key(value))

        token = {"albumId": string(ALBUM_ID)}
        pages = [{"Items": [{"a": string("1")}], "LastEvaluatedKey": token}, {"Items": [{}]}]
        with patch.object(preview_backfill, "aws_json", side_effect=pages) as aws:
            self.assertEqual(
                len(preview_backfill.scan_all("table", "#status", "profile", "region", {"#status": "status"})),
                2,
            )
        first_call = aws.call_args_list[0].args[0]
        self.assertIn("--expression-attribute-names", first_call)
        self.assertIn("--exclusive-start-key", aws.call_args_list[1].args[0])
        for pages in (
            [{"Items": "malformed"}],
            [{"Items": [], "LastEvaluatedKey": token}, {"Items": [], "LastEvaluatedKey": token}],
        ):
            with self.subTest(pages=pages), patch.object(preview_backfill, "aws_json", side_effect=pages), self.assertRaises(
                RuntimeError
            ):
                preview_backfill.scan_all("table", "albumId", None, None)

        valid = record(albumId=ALBUM_ID, mediaId="media")
        index, duplicates = preview_backfill.metadata_index([valid, valid, record(albumId="", mediaId="media")])
        self.assertEqual(index[(ALBUM_ID, "media")]["albumId"], ALBUM_ID)
        self.assertEqual(duplicates, 2)

    def test_plan_exercises_all_eligibility_and_metadata_states(self):
        canonical = f"albums/{ALBUM_ID}/original/"
        legacy = "albums/legacy/"
        ready_key = canonical + "ready.jpg"
        pending_key = canonical + "pending.jpg"
        conflict_key = canonical + "conflict.jpg"
        new_key = canonical + "new.jpg"
        width_bad_key = canonical + "width-bad.jpg"
        legacy_key = legacy + "old.jpg"
        images = [
            {"rawKey": ready_key, "width": 3000},
            {"rawKey": pending_key, "width": 3000},
            {"rawKey": conflict_key, "width": 3000},
            {"rawKey": new_key, "width": 3000},
            {"rawKey": new_key, "width": 3000},
            {"key": width_bad_key, "width": "not-a-number"},
            {"rawKey": canonical + "small.jpg", "width": 100},
            {"rawKey": canonical + "unsupported.gif", "width": 3000},
            {"rawKey": "albums/other/cross.jpg", "width": 3000},
            {"rawKey": legacy_key, "width": 3000},
            "not-a-manifest",
        ]
        active = record(
            albumId=ALBUM_ID,
            type="photo",
            status="active",
            visibility="private",
            legacyS3Prefix=legacy,
            images=images,
        )
        inactive = record(albumId=SECOND_ID, status="disabled", visibility="public", images=[])
        non_photo = record(albumId=SUBJECT, type="video", visibility="unlisted", images=[])
        malformed = record(albumId="bad", visibility="public", images=[])

        def metadata(raw_key, status, *, version=preview_backfill.PREVIEW_VERSION, keys=None):
            return record(
                albumId=ALBUM_ID,
                mediaId=preview_backfill.media_id_for_key(raw_key),
                status=status,
                previewVersion=version,
                previewKeys=keys or preview_backfill.expected_preview_keys(ALBUM_ID, raw_key),
            )

        metadata_records = [
            metadata(ready_key, "ready"),
            metadata(pending_key, "pending"),
            metadata(conflict_key, "ready", version=1),
        ]
        jobs, counts = preview_backfill.build_backfill_plan(
            [active, inactive, non_photo, malformed], metadata_records
        )
        self.assertEqual(counts["plannedJobCount"], 4)
        self.assertEqual({job["rawKey"] for job in jobs}, {pending_key, new_key, width_bad_key, legacy_key})
        for key in (
            "alreadyCompleteCount",
            "pendingRetryCount",
            "smallSourceSkippedCount",
            "unsupportedSourceSkippedCount",
            "inactiveAlbumSkippedCount",
            "nonPhotoAlbumSkippedCount",
            "malformedAlbumCount",
            "malformedMediaCount",
            "duplicateManifestMediaCount",
            "conflictingMetadataCount",
        ):
            with self.subTest(key=key):
                self.assertGreaterEqual(counts[key], 1)
        self.assertEqual(
            preview_backfill.plan_digest(jobs),
            preview_backfill.plan_digest(list(jobs)),
        )

    def test_source_head_validation_and_dispatch_fail_closed(self):
        keys = ("valid.jpg", "large.jpg", "wrong.jpg", "bad-length.jpg", "error.jpg")
        jobs = [{"albumId": ALBUM_ID, "rawKey": key, "previewVersion": 2} for key in keys]

        def head(arguments, profile, region):
            key = arguments[-1]
            if key == "valid.jpg":
                return {"ContentLength": 10, "ContentType": "IMAGE/JPEG"}
            if key == "large.jpg":
                return {"ContentLength": 101, "ContentType": "image/jpeg"}
            if key == "wrong.jpg":
                return {"ContentLength": 10, "ContentType": "application/octet-stream"}
            if key == "bad-length.jpg":
                return {"ContentLength": "invalid", "ContentType": "image/jpeg"}
            raise RuntimeError("head failed")

        with patch.object(preview_backfill, "aws_json", side_effect=head):
            valid, failures = preview_backfill.validate_source_heads(jobs, "bucket", None, "region", 100)
        self.assertEqual(valid, [jobs[0]])
        self.assertEqual(failures, 4)
        with patch.object(preview_backfill, "aws_json") as aws:
            self.assertEqual(preview_backfill.validate_source_heads([], "bucket", None, None, 100), ([], 0))
        aws.assert_not_called()

        job = jobs[0]
        for response in (
            {"Failed": "malformed"},
            {"Failed": ["bad", {"Code": "Denied"}]},
            {"Failed": [], "Successful": "malformed"},
            {"Failed": [], "Successful": []},
        ):
            with self.subTest(response=response), patch.object(preview_backfill, "aws_json", return_value=response), self.assertRaises(
                RuntimeError
            ):
                preview_backfill.dispatch_jobs([job], "queue", None, None)


class LegacyAndPreviewMainTests(MainMixin, unittest.TestCase):
    def run_legacy(self, *arguments, counts=None, update_error=None):
        selected_counts = {"alreadyApprovedCount": 0} if counts is None else counts

        def aws(arguments, profile, region):
            if arguments[:2] == ["sts", "get-caller-identity"]:
                return {"Account": "123"}
            if arguments[:2] == ["dynamodb", "update-item"]:
                if update_error:
                    raise update_error
                return {}
            raise AssertionError(arguments)

        with patch.object(legacy_backfill, "aws_json", side_effect=aws), patch.object(
            legacy_backfill, "stack_resource", return_value="table"
        ), patch.object(legacy_backfill, "scan_all", return_value=[{}]), patch.object(
            legacy_backfill,
            "build_backfill_plan",
            return_value=([(ALBUM_ID, "albums/legacy/")], selected_counts),
        ):
            return self.invoke(legacy_backfill, "--stack-name", "stack", *arguments)

    def test_legacy_dry_run_guards_success_conflict_and_unsafe(self):
        result, output = self.run_legacy()
        self.assertEqual(result, 0)
        digest = json.loads(output.split("\nDry run", 1)[0])["planDigest"]
        complete = (
            "--apply",
            "--expected-account-id",
            "123",
            "--expected-record-count",
            "1",
            "--expected-plan-digest",
            digest,
            "--confirm-stack-name",
            "stack",
            "--confirm",
            "backfill-legacy-media-prefix",
        )
        guard_sets = (
            ("--apply", "--expected-account-id", "wrong"),
            ("--apply", "--expected-account-id", "123", "--expected-record-count", "0"),
            (
                "--apply", "--expected-account-id", "123", "--expected-record-count", "1",
                "--expected-plan-digest", "wrong",
            ),
            (
                "--apply", "--expected-account-id", "123", "--expected-record-count", "1",
                "--expected-plan-digest", digest, "--confirm-stack-name", "wrong",
            ),
            (
                "--apply", "--expected-account-id", "123", "--expected-record-count", "1",
                "--expected-plan-digest", digest, "--confirm-stack-name", "stack", "--confirm", "wrong",
            ),
        )
        for guards in guard_sets:
            with self.subTest(guards=guards), self.assertRaises(SystemExit):
                self.run_legacy(*guards)
        with self.assertRaisesRegex(SystemExit, "unsafe"):
            self.run_legacy(*complete, counts={"alreadyApprovedCount": 0, "unsafeCount": 1})
        self.assertEqual(self.run_legacy(*complete)[0], 0)
        conflict = subprocess.CalledProcessError(1, ["aws"], stderr="ConditionalCheckFailedException")
        self.assertEqual(self.run_legacy(*complete, update_error=conflict)[0], 1)
        other = subprocess.CalledProcessError(1, ["aws"], stderr="AccessDenied")
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_legacy(*complete, update_error=other)

    def run_preview(self, *arguments):
        counts = {
            "albumRecordCount": 1,
            "previewMetadataRecordCount": 0,
            "plannedJobCount": 1,
        }
        jobs = [{"albumId": ALBUM_ID, "mediaId": "m", "rawKey": f"albums/{ALBUM_ID}/original/a.jpg"}]
        with patch.object(
            preview_backfill, "aws_json", return_value={"Account": "123"}
        ), patch.object(
            preview_backfill,
            "stack_resource",
            side_effect=["albums", "metadata", "bucket", "queue"],
        ), patch.object(preview_backfill, "scan_all", side_effect=[[{}], []]), patch.object(
            preview_backfill, "build_backfill_plan", return_value=(jobs, dict(counts))
        ), patch.object(preview_backfill, "validate_source_heads", return_value=(jobs, 0)), patch.object(
            preview_backfill, "validate_apply_guards"
        ) as guards, patch.object(preview_backfill, "dispatch_jobs", return_value=1) as dispatch:
            result = self.invoke(preview_backfill, "--stack-name", "stack", *arguments)
        return (*result, guards, dispatch)

    def test_preview_main_dry_run_and_guarded_dispatch(self):
        result, output, guards, dispatch = self.run_preview()
        self.assertEqual(result, 0)
        guards.assert_not_called()
        dispatch.assert_not_called()
        result, output, guards, dispatch = self.run_preview("--apply")
        self.assertEqual(result, 0)
        guards.assert_called_once()
        dispatch.assert_called_once()
        self.assertIn('"dispatch": "accepted"', output)


class TagExistingMediaTests(MainMixin, unittest.TestCase):
    def setUp(self):
        self.raw_key = f"albums/{ALBUM_ID}/original/photo.jpg"
        self.orphan_key = "albums/orphan/file.jpg"
        self.album = {
            "albumId": string(ALBUM_ID),
            "visibility": string("public"),
            "images": {"L": [{"M": {"rawKey": string(self.raw_key)}}]},
        }

    def test_sdk_client_decode_keys_classification_and_digest(self):
        with patch.object(tag_existing_media, "boto3", None), patch.object(tag_existing_media, "BotoConfig", None):
            self.assertIsNone(tag_existing_media.create_s3_tag_client(None, "r", 4))
        session = Mock()
        with patch.object(tag_existing_media.boto3, "Session", return_value=session), patch.object(
            tag_existing_media, "BotoConfig", Mock(return_value="config")
        ):
            tag_existing_media.create_s3_tag_client("p", "r", 4)
        session.client.assert_called_once_with("s3", config="config")
        values = (
            ({"S": "x"}, "x"),
            ({"N": "2"}, 2),
            ({"N": "2.5"}, 2.5),
            ({"BOOL": True}, True),
            ({"NULL": True}, None),
            ({"L": [{"S": "x"}]}, ["x"]),
            ({"M": {"x": {"S": "y"}}}, {"x": "y"}),
            ({"X": "raw"}, "raw"),
            ("raw", "raw"),
        )
        for encoded, expected in values:
            self.assertEqual(tag_existing_media.decode(encoded), expected)
        self.assertIsNone(tag_existing_media.object_key(None))
        self.assertEqual(tag_existing_media.object_key("/a/b"), "a/b")
        self.assertEqual(tag_existing_media.object_key("https://bucket.example/a%20b"), "a b")
        plan, orphans, missing = tag_existing_media.classify_existing_objects(
            {"assigned": "public", "missing": "private"}, {"assigned", "orphan"}
        )
        self.assertEqual(plan["orphan"], "quarantined")
        self.assertEqual(orphans, {"orphan"})
        self.assertEqual(missing, {"missing"})
        self.assertEqual(tag_existing_media.classification_digest(plan), tag_existing_media.classification_digest(dict(reversed(list(plan.items())))))

    def list_objects(self, bucket, prefix, profile, region):
        if prefix == "albums/":
            return [self.raw_key, self.orphan_key]
        return [self.raw_key]

    def run_tag(self, *arguments, albums=None, client=None, cli_tags=None):
        selected_albums = [self.album] if albums is None else albums
        calls = []

        def aws(arguments, profile, region):
            calls.append(arguments)
            if arguments[:2] == ["sts", "get-caller-identity"]:
                return {"Account": "123"}
            if arguments[:2] == ["s3api", "get-object-tagging"]:
                return {"TagSet": list((cli_tags or {}).get(arguments[-1], []))}
            if arguments[:2] == ["s3api", "put-object-tagging"]:
                return {}
            raise AssertionError(arguments)

        with patch.object(tag_existing_media, "aws_json", side_effect=aws), patch.object(
            tag_existing_media, "stack_resource", side_effect=["table", "bucket"]
        ), patch.object(tag_existing_media, "scan_all", return_value=selected_albums), patch.object(
            tag_existing_media, "list_objects_all", side_effect=self.list_objects
        ), patch.object(tag_existing_media, "create_s3_tag_client", return_value=client):
            result = self.invoke(tag_existing_media, "--stack-name", "stack", *arguments)
        return (*result, calls)

    def test_dry_run_input_conflict_and_apply_guards(self):
        result, output, calls = self.run_tag("--max-objects", "1")
        self.assertEqual(result, 0)
        report = json.loads(output.split("\nDry run", 1)[0])
        self.assertEqual(report["selectedObjectCount"], 1)
        digest = report["classificationPlanDigest"]
        for workers in ("0", "17"):
            with self.assertRaises(SystemExit):
                self.run_tag("--workers", workers)
        with self.assertRaisesRegex(SystemExit, "diagnostic"):
            self.run_tag("--apply", "--max-objects", "1")
        invalid = [{**self.album, "visibility": string("secret")}]
        with self.assertRaisesRegex(SystemExit, "invalid_visibility"):
            self.run_tag(albums=invalid)
        conflict_album = {
            **self.album,
            "albumId": string(SECOND_ID),
            "visibility": string("private"),
        }
        with self.assertRaisesRegex(SystemExit, "conflicting_keys"):
            self.run_tag(albums=[self.album, conflict_album])

        complete = (
            "--apply",
            "--expected-account-id",
            "123",
            "--expected-record-count",
            "1",
            "--expected-bucket-object-count",
            "2",
            "--expected-plan-digest",
            digest,
            "--confirm",
            "tag-existing-media",
        )
        guard_sets = (
            ("--apply", "--expected-account-id", "wrong"),
            complete[:3] + ("--expected-record-count", "0"),
            complete[:5] + ("--expected-bucket-object-count", "0"),
            complete[:7] + ("--expected-plan-digest", "wrong"),
            complete[:-2] + ("--confirm", "wrong"),
        )
        for guards in guard_sets:
            with self.subTest(guards=guards), self.assertRaises(SystemExit):
                self.run_tag(*guards)

    def test_apply_with_sdk_updates_and_verifies_concurrently(self):
        lock = threading.Lock()
        state = {
            self.raw_key: [{"Key": "visibility", "Value": "public"}],
            self.orphan_key: [{"Key": "retention", "Value": "keep"}],
        }
        client = Mock()

        def get_tags(*, Bucket, Key):
            with lock:
                return {"TagSet": [dict(item) for item in state[Key]]}

        def put_tags(*, Bucket, Key, Tagging):
            with lock:
                state[Key] = [dict(item) for item in Tagging["TagSet"]]

        client.get_object_tagging.side_effect = get_tags
        client.put_object_tagging.side_effect = put_tags
        dry_output = self.run_tag()[1]
        digest = json.loads(dry_output.split("\nDry run", 1)[0])["classificationPlanDigest"]
        result, output, calls = self.run_tag(
            "--apply",
            "--expected-account-id",
            "123",
            "--expected-record-count",
            "1",
            "--expected-bucket-object-count",
            "2",
            "--expected-plan-digest",
            digest,
            "--confirm",
            "tag-existing-media",
            client=client,
        )
        self.assertEqual(result, 0)
        final = json_documents(output)[-1]
        self.assertEqual(final["resultCounts"], {"unchanged": 1, "updated": 1})
        self.assertEqual(final["verificationCounts"], {"classified": 2})

    def test_cli_transport_and_failed_or_too_many_tags_fail_exit(self):
        dry_output = self.run_tag()[1]
        digest = json.loads(dry_output.split("\nDry run", 1)[0])["classificationPlanDigest"]
        base = (
            "--apply",
            "--expected-account-id",
            "123",
            "--expected-record-count",
            "1",
            "--expected-bucket-object-count",
            "2",
            "--expected-plan-digest",
            digest,
            "--confirm",
            "tag-existing-media",
        )
        result, output, calls = self.run_tag(*base, client=None, cli_tags={})
        self.assertEqual(result, 1)  # CLI mock does not mutate; verification fails closed.
        self.assertTrue(any(call[:2] == ["s3api", "put-object-tagging"] for call in calls))

        too_many = Mock()
        too_many.get_object_tagging.return_value = {
            "TagSet": [{"Key": f"k{i}", "Value": "v"} for i in range(10)]
        }
        result, _, _ = self.run_tag(*base, client=too_many)
        self.assertEqual(result, 1)
        too_many.put_object_tagging.assert_not_called()

        failed = Mock()
        failed.get_object_tagging.side_effect = RuntimeError("provider")
        result, _, _ = self.run_tag(*base, client=failed)
        self.assertEqual(result, 1)


if __name__ == "__main__":
    unittest.main()
