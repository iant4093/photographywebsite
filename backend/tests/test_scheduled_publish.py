"""Scheduling link-only albums to publish to the main gallery."""

import datetime
import json
import os
import unittest
from unittest.mock import Mock, call, patch

import boto3
from botocore.exceptions import ClientError

import test_support  # noqa: F401  (adds backend/functions to sys.path)
import test_publication_recovery as publication
from test_album_write_branch_coverage import ALBUM_ID, album, create_body, event
import test_album_write_branch_coverage as album_writes
from test_publication_recovery import ALBUM, CONTEXT, RAW, RECORD

import create_album
import media_access
import scheduled_publish
import update_album
from validation_helpers import ValidationError


NOW = datetime.datetime(2026, 10, 5, 12, 0, tzinfo=datetime.timezone.utc)
SOON = "2026-10-06T17:30:00Z"
INDEX_KEY = {"settingId": "scheduled-publishing"}


def client_error(code):
    return ClientError({"Error": {"Code": code, "Message": code}}, "UpdateItem")


class ScheduleIndexTests(unittest.TestCase):
    def setUp(self):
        self.settings = Mock()
        patcher = patch.object(scheduled_publish, "_table", self.settings)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_times_are_normalized_to_utc_and_bounded(self):
        self.assertEqual(scheduled_publish.validate_publish_at("2026-10-06T10:30:00.250-07:00", NOW), SOON)
        # Past times are accepted: an upload can finish after its time.
        self.assertEqual(scheduled_publish.validate_publish_at("2026-10-01T00:00:00Z", NOW), "2026-10-01T00:00:00Z")
        for value in ("2027-10-07T00:00:00Z", "2026-10-06T10:30:00", "tomorrow", 5, None, "x" * 41):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                scheduled_publish.validate_publish_at(value, NOW)
        with patch.object(scheduled_publish, "_now", return_value=NOW):
            self.assertEqual(scheduled_publish.validate_publish_at(SOON), SOON)
        self.assertTrue(scheduled_publish._now().tzinfo)

    def test_record_and_forget_touch_one_entry(self):
        scheduled_publish.record(ALBUM_ID, SOON)
        first, second = self.settings.update_item.call_args_list
        self.assertEqual(first.kwargs["UpdateExpression"], "SET albums = if_not_exists(albums, :empty)")
        self.assertEqual(second.kwargs["ExpressionAttributeNames"], {"#album": ALBUM_ID})
        self.assertEqual(second.kwargs["ExpressionAttributeValues"], {":at": SOON})

        self.settings.reset_mock()
        scheduled_publish.forget(ALBUM_ID, SOON)
        self.assertEqual(self.settings.update_item.call_args.kwargs["ConditionExpression"], "albums.#album = :at")
        scheduled_publish.forget(ALBUM_ID)
        self.assertNotIn("ExpressionAttributeValues", self.settings.update_item.call_args.kwargs)

        self.settings.update_item.side_effect = client_error("ConditionalCheckFailedException")
        scheduled_publish.forget(ALBUM_ID, SOON)
        self.settings.update_item.side_effect = client_error("ProvisionedThroughputExceededException")
        with self.assertRaises(ClientError):
            scheduled_publish.forget(ALBUM_ID, SOON)

    def test_due_lists_passed_times_earliest_first(self):
        self.settings.get_item.return_value = {"Item": {"albums": {
            "late": "2026-10-05T11:59:00Z", "early": "2026-10-04T09:00:00Z", "future": "2026-10-05T12:00:01Z",
            "exact": "2026-10-05T12:00:00Z", "broken": 5,
        }}}
        self.assertEqual(scheduled_publish.due(NOW), [
            ("early", "2026-10-04T09:00:00Z"), ("late", "2026-10-05T11:59:00Z"), ("exact", "2026-10-05T12:00:00Z"),
        ])
        self.settings.get_item.return_value = {}
        self.assertEqual(scheduled_publish.due(NOW), [])

    def test_table_is_created_lazily(self):
        with patch.object(scheduled_publish, "_table", None), patch.object(scheduled_publish.boto3, "resource") as resource, \
                patch.dict(os.environ, {"GALLERY_SETTINGS_TABLE": "settings"}):
            self.assertIs(scheduled_publish._settings(), resource.return_value.Table.return_value)
            resource.return_value.Table.assert_called_once_with("settings")


class CreateScheduledAlbumTests(unittest.TestCase):
    _run_success = album_writes.CreateAlbumBranchTests._run_success

    def test_a_scheduled_upload_is_indexed_before_the_album_is_saved(self):
        order = Mock()
        record = patch.object(scheduled_publish, "record", side_effect=lambda *args: order.record(*args))
        response, table, _ = self._run_success(
            create_body(visibility="unlisted", isShared=False, publishAt="2026-10-06T10:30:00-07:00"), record=record,
        )
        self.assertEqual(response["statusCode"], 201)
        item = table.put_item.call_args.kwargs["Item"]
        self.assertEqual((item["visibility"], item["isShared"], item["publishAt"]), ("unlisted", False, SOON))
        self.assertNotIn("shareCode", item)
        order.record.assert_called_once_with(ALBUM_ID, SOON)

    def test_only_link_only_albums_can_be_scheduled(self):
        with patch.object(scheduled_publish, "record") as record:
            response, table, _ = self._run_success(create_body(publishAt=SOON))
            self.assertEqual(response["statusCode"], 400)
            response, table, _ = self._run_success(create_body(visibility="unlisted", publishAt="soon"))
            self.assertEqual(response["statusCode"], 400)
            response, table, _ = self._run_success(create_body(visibility="unlisted", publishAt=""))
            self.assertEqual(response["statusCode"], 201)
            self.assertNotIn("publishAt", table.put_item.call_args.kwargs["Item"])
        record.assert_not_called()


class UpdateScheduleTests(unittest.TestCase):
    def updated(self, body, record=None):
        return update_album._updated_album(record or album(visibility="unlisted", isShared=False), body)

    def test_schedules_belong_to_link_only_albums(self):
        self.assertEqual(self.updated({"publishAt": SOON})["publishAt"], SOON)
        scheduled = album(visibility="unlisted", isShared=False, publishAt=SOON)
        self.assertEqual(self.updated({"title": "New"}, scheduled)["publishAt"], SOON)
        self.assertNotIn("publishAt", self.updated({"publishAt": None}, scheduled))
        self.assertNotIn("publishAt", self.updated({"publishAt": ""}, scheduled))
        published = self.updated({"visibility": "public"}, {**scheduled, "shareCode": "code", "isShared": True})
        self.assertNotIn("publishAt", published)
        self.assertNotIn("shareCode", published)
        with patch.object(update_album, "_resolve_owner", return_value=("owner@example.com", ALBUM_ID)):
            self.assertNotIn("publishAt", self.updated({"visibility": "private", "ownerEmail": "owner@example.com"}, scheduled))
        for body in ({"visibility": "public", "publishAt": SOON}, {"publishAt": "later"}):
            with self.subTest(body=body), self.assertRaises(ValidationError):
                self.updated(body)

    def _call(self, body, record, *, record_error=None):
        table = Mock()
        table.get_item.return_value = {"Item": record}
        table.update_item.return_value = {}
        order = Mock()
        table.update_item.side_effect = lambda **kwargs: (order.commit(kwargs), {})[1]
        with patch.object(update_album, "require_admin", return_value=None), patch.object(update_album, "table", table), \
                patch.object(update_album, "_reconcile_album_qr", return_value=None), patch.object(update_album, "_audit"), \
                patch.object(scheduled_publish, "record", side_effect=record_error or (lambda *args: order.record(*args))), \
                patch.object(scheduled_publish, "forget", side_effect=lambda *args: order.forget(*args)):
            response = update_album.handler(event(body), None)
        return response, [entry[0] for entry in order.mock_calls], order

    def test_a_new_time_is_indexed_before_the_album_changes(self):
        response, steps, order = self._call({"publishAt": SOON}, album(visibility="unlisted", isShared=False))
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(steps, ["record", "commit"])
        order.record.assert_called_once_with(ALBUM_ID, SOON)
        self.assertIn("publishAt", json.dumps(order.commit.call_args.args[0]["ExpressionAttributeNames"]))

    def test_clearing_a_time_drops_its_entry_after_the_album_changes(self):
        scheduled = album(visibility="unlisted", isShared=False, publishAt=SOON)
        response, steps, order = self._call({"publishAt": None}, scheduled)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(steps, ["commit", "forget"])
        order.forget.assert_called_once_with(ALBUM_ID, SOON)
        # An unchanged time writes nothing to the index.
        response, steps, _ = self._call({"publishAt": SOON, "title": "New"}, scheduled)
        self.assertEqual(steps, ["commit"])

    def test_an_index_failure_leaves_the_album_unchanged(self):
        response, steps, _ = self._call(
            {"publishAt": SOON}, album(visibility="unlisted", isShared=False), record_error=RuntimeError("ddb"),
        )
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(steps, [])

    def test_a_failed_cleanup_does_not_fail_the_edit(self):
        with patch.object(scheduled_publish, "forget", side_effect=RuntimeError("ddb")):
            update_album._forget_schedule({"albumId": ALBUM_ID, "publishAt": SOON}, {})
        with patch.object(scheduled_publish, "forget") as forget:
            update_album._forget_schedule({"albumId": ALBUM_ID}, {})
            update_album._forget_schedule({"albumId": ALBUM_ID, "publishAt": SOON}, {"publishAt": SOON})
        forget.assert_not_called()

    def test_admin_summaries_carry_the_time_of_link_only_albums(self):
        scheduled = album(visibility="unlisted", isShared=False, publishAt=SOON)
        with patch.object(media_access, "media_url", return_value="https://media.example/x"), \
                patch.object(media_access, "url_expiry_metadata", return_value={}):
            self.assertEqual(media_access.serialize_album_summary(scheduled, include_admin=True)["publishAt"], SOON)
            self.assertNotIn("publishAt", media_access.serialize_album_summary(scheduled))
            self.assertNotIn("publishAt", media_access.serialize_album_summary({**scheduled, "visibility": "public"}, include_admin=True))


class PublisherTests(unittest.TestCase):
    def run_publisher(self, entries, albums, responses=None, remaining=60_000):
        table = Mock()
        table.get_item.side_effect = lambda Key, **_: {"Item": albums[Key["albumId"]]} if Key["albumId"] in albums else {}
        responses = dict(responses or {})
        update = Mock(side_effect=lambda event, context, album_id, body: {"statusCode": responses.get(album_id, 200)})
        context = Mock(get_remaining_time_in_millis=Mock(return_value=remaining))
        with patch.object(update_album, "table", table), patch.object(update_album, "_update", update), \
                patch.object(scheduled_publish, "due", return_value=entries) as due, \
                patch.object(scheduled_publish, "forget") as forget, patch.object(scheduled_publish, "record") as record:
            result = update_album._publish_due(context, now=NOW)
        due.assert_called_once_with(NOW)
        return result, update, forget, record

    def test_due_albums_are_published_and_leave_the_index(self):
        at = "2026-10-05T11:55:00Z"
        albums = {name: album(albumId=name, visibility="unlisted", isShared=False, publishAt=at) for name in ("a", "b")}
        result, update, forget, _ = self.run_publisher([("a", at), ("b", at)], albums, {"b": 409})
        self.assertEqual(result, {"published": 1, "waiting": 1})
        self.assertEqual(update.call_args_list, [
            call(None, update.call_args.args[1], album_id=name, body={"visibility": "public"}) for name in ("a", "b")
        ])
        forget.assert_called_once_with("a", at)

    def test_stale_entries_are_repaired_or_dropped(self):
        at = "2026-10-05T11:55:00Z"
        albums = {
            "moved": album(albumId="moved", visibility="unlisted", publishAt="2026-10-09T00:00:00Z"),
            "cleared": album(albumId="cleared", visibility="unlisted"),
            "published": album(albumId="published", visibility="public", publishAt=at),
            "uploading": album(albumId="uploading", visibility="unlisted", publishAt=at, status="pending"),
        }
        entries = [("moved", at), ("cleared", at), ("published", at), ("uploading", at),
                   ("new", at), ("abandoned", "2026-10-04T11:00:00Z")]
        result, update, forget, record = self.run_publisher(entries, albums)
        self.assertEqual(result, {"published": 0, "waiting": 1})
        update.assert_not_called()
        record.assert_called_once_with("moved", "2026-10-09T00:00:00Z")
        self.assertEqual(forget.call_args_list, [
            call("cleared", at), call("published", at), call("abandoned", "2026-10-04T11:00:00Z"),
        ])

    def test_a_run_is_bounded(self):
        at = "2026-10-05T11:55:00Z"
        names = [f"album-{index}" for index in range(update_album.PUBLISH_BATCH + 2)]
        albums = {name: album(albumId=name, visibility="unlisted", publishAt=at) for name in names}
        result, update, _, _ = self.run_publisher([(name, at) for name in names], albums)
        self.assertEqual(result["published"], update_album.PUBLISH_BATCH)
        result, update, _, _ = self.run_publisher([(name, at) for name in names], albums, remaining=1000)
        self.assertEqual(result, {"published": 0, "waiting": 0})

    def test_the_schedule_event_runs_the_publisher_without_api_checks(self):
        with patch.object(update_album, "_publish_due", return_value={"published": 0}) as publish, \
                patch.object(update_album, "verify_front_door_request") as front_door:
            self.assertEqual(update_album.handler({"source": "scheduled-publish"}, CONTEXT), {"published": 0})
        publish.assert_called_once_with(CONTEXT)
        front_door.assert_not_called()


class ScheduledPublicationTests(unittest.TestCase):
    """End to end through the durable privacy transition, on emulated AWS."""

    setUp = publication.PublicationRecoveryTests.setUp
    put = publication.PublicationRecoveryTests.put
    album = publication.PublicationRecoveryTests.album
    object = publication.PublicationRecoveryTests.object
    tag = publication.PublicationRecoveryTests.tag

    def test_a_due_album_is_published_and_its_schedule_cleared(self):
        settings = boto3.resource("dynamodb", region_name="us-west-2").create_table(
            TableName="settings-test", KeySchema=[{"AttributeName": "settingId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "settingId", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST",
        )
        with patch.object(scheduled_publish, "_table", settings):
            at = "2026-10-05T11:55:00Z"
            self.put({**RECORD, "visibility": "unlisted", "isShared": False, "publishAt": at})
            self.object(RAW, "unlisted")
            scheduled_publish.record(ALBUM, at)
            scheduled_publish.record("33333333-3333-4333-8333-333333333333", "2026-12-01T00:00:00Z")

            result = update_album._publish_due(CONTEXT, now=NOW)

            self.assertEqual(result, {"published": 1, "waiting": 0})
            published = self.album()
            self.assertEqual((published["visibility"], published["status"]), ("public", "active"))
            self.assertNotIn("publishAt", published)
            self.assertNotIn("pendingVisibilityChange", published)
            self.assertEqual(self.tag(RAW), "public")
            index = settings.get_item(Key=INDEX_KEY)["Item"]["albums"]
            self.assertEqual(index, {"33333333-3333-4333-8333-333333333333": "2026-12-01T00:00:00Z"})


if __name__ == "__main__":
    unittest.main()
