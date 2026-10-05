"""Recently Deleted: a 30-day bin in front of permanent album deletion."""

import datetime
import os
import unittest
from unittest.mock import Mock, call, patch

import boto3

import test_support  # noqa: F401  (adds backend/functions to sys.path)
import test_publication_recovery as publication
from test_album_write_branch_coverage import ALBUM_ID, album, event
from test_publication_recovery import ALBUM, CONTEXT, RAW, RECORD, SUB

import delete_album
import media_access
import scheduled_publish
import trash_bin
import update_album
import user_deletion
from validation_helpers import ValidationError


NOW = datetime.datetime(2026, 10, 5, 12, 0, tzinfo=datetime.timezone.utc)
STAMP = "2026-10-05T12:00:00Z"
INDEX_KEY = {"settingId": "recently-deleted"}


class BinRulesTests(unittest.TestCase):
    def test_binning_hides_the_album_and_remembers_its_access(self):
        public = trash_bin.trashed(album(publishAt="2026-11-01T00:00:00Z"), NOW)
        self.assertEqual((public["visibility"], public["isShared"], public["trashedAt"]), ("unlisted", False, STAMP))
        self.assertEqual(public["trashedFrom"], {"visibility": "public"})
        self.assertNotIn("publishAt", public)

        private = trash_bin.trashed(album(visibility="private", ownerEmail="c@example.com", ownerSub=SUB), NOW)
        self.assertEqual(private["trashedFrom"], {"visibility": "private", "ownerEmail": "c@example.com", "ownerSub": SUB})
        self.assertEqual(private["ownerEmail"], "")
        self.assertNotIn("ownerSub", private)

        shared = trash_bin.trashed(album(visibility="unlisted", isShared=True, shareCode="code"), NOW)
        self.assertEqual(shared["trashedFrom"], {"visibility": "unlisted", "isShared": True, "shareCode": "code"})
        self.assertNotIn("shareCode", shared)
        self.assertNotIn("ownerEmail", shared)
        # Binning twice changes nothing, so a retried request is harmless.
        self.assertEqual(trash_bin.trashed(shared, NOW + datetime.timedelta(days=1)), shared)
        self.assertRegex(trash_bin.trashed(album())["trashedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

    def test_restoring_returns_the_previous_access(self):
        never = Mock(side_effect=AssertionError("no new share code"))
        cases = [
            ({"visibility": "public"}, {"visibility": "public", "isShared": False}),
            ({"visibility": "private", "ownerEmail": "c@example.com", "ownerSub": SUB},
             {"visibility": "private", "ownerEmail": "c@example.com", "ownerSub": SUB}),
            ({"visibility": "unlisted", "isShared": True, "shareCode": "code"},
             {"visibility": "unlisted", "isShared": True, "shareCode": "code"}),
            ({"visibility": "private", "ownerEmail": "c@example.com"}, {"visibility": "unlisted", "isShared": False}),
            ({"visibility": "secret"}, {"visibility": "unlisted", "isShared": False}),
        ]
        for snapshot, expected in cases:
            with self.subTest(snapshot=snapshot):
                binned = album(visibility="unlisted", isShared=False, trashedAt=STAMP, trashedFrom=snapshot)
                restored = trash_bin.restored(binned, never)
                self.assertNotIn("trashedAt", restored)
                self.assertNotIn("trashedFrom", restored)
                self.assertEqual({key: restored.get(key) for key in expected}, expected)
                if expected["visibility"] != "unlisted" or not expected.get("isShared"):
                    self.assertNotIn("shareCode", restored)
        fresh = trash_bin.restored(album(visibility="unlisted", trashedAt=STAMP, trashedFrom={"visibility": "unlisted", "isShared": True}), lambda: "new")
        self.assertEqual(fresh["shareCode"], "new")
        broken = trash_bin.restored(album(visibility="unlisted", trashedAt=STAMP, trashedFrom="bad"), never)
        self.assertEqual(broken["visibility"], "unlisted")
        self.assertEqual(trash_bin.restored(album(), never), album())

    def test_the_index_and_retention_window(self):
        with patch.object(scheduled_publish, "record") as record, patch.object(scheduled_publish, "forget") as forget, \
                patch.object(scheduled_publish, "due", return_value=[("a", STAMP)]) as due:
            trash_bin.record("a", STAMP)
            trash_bin.forget("a", STAMP)
            self.assertEqual(trash_bin.expired(NOW), [("a", STAMP)])
            trash_bin.expired()
        record.assert_called_once_with("a", STAMP, index=INDEX_KEY)
        forget.assert_called_once_with("a", STAMP, index=INDEX_KEY)
        self.assertEqual(due.call_args_list[0], call(NOW - datetime.timedelta(days=30), index=INDEX_KEY))
        self.assertEqual(trash_bin.purge_after(STAMP), "2026-11-04T12:00:00Z")

    def test_bin_operations_are_whole_album_requests(self):
        for body in ({"trash": True, "title": "x"}, {"trash": False}, {"restore": "yes"}, {"trash": True, "restore": True}):
            with self.subTest(body=body), self.assertRaises(ValidationError):
                update_album._updated_album(album(), body)
        with self.assertRaises(ValidationError):
            update_album._updated_album(album(trashedAt=STAMP, trashedFrom={}), {"title": "x"})
        self.assertEqual(update_album._updated_album(album(), {"trash": True})["visibility"], "unlisted")

    def test_admin_summaries_describe_binned_albums(self):
        binned = album(visibility="unlisted", isShared=False, trashedAt=STAMP,
                       trashedFrom={"visibility": "private", "ownerEmail": "c@example.com", "ownerSub": SUB})
        with patch.object(media_access, "media_url", return_value="https://media.example/x"), \
                patch.object(media_access, "url_expiry_metadata", return_value={}):
            summary = media_access.serialize_album_summary(binned, include_admin=True)
            self.assertEqual(summary["trashedFrom"], {"visibility": "private", "ownerEmail": "c@example.com", "isShared": False})
            odd = media_access.serialize_album_summary({**binned, "trashedFrom": {"visibility": "odd", "ownerEmail": "x"}}, include_admin=True)
            self.assertEqual(odd["trashedFrom"], {"visibility": "unlisted", "ownerEmail": "", "isShared": False})
            self.assertNotIn("trashedAt", media_access.serialize_album_summary(binned))

    def test_a_clients_binned_album_is_deleted_with_their_account(self):
        pending = {"subject": SUB, "email": "c@example.com"}
        self.assertTrue(user_deletion.owns({"trashedFrom": {"ownerSub": SUB}}, pending))
        self.assertFalse(user_deletion.owns({"trashedFrom": {"ownerSub": "someone-else"}}, pending))
        self.assertFalse(user_deletion.owns({"trashedFrom": "bad", "ownerSub": "someone-else"}, pending))
        self.assertFalse(user_deletion.owns(None, pending))


class BinIndexOrderTests(unittest.TestCase):
    def _call(self, body, record):
        table = Mock()
        table.get_item.return_value = {"Item": record}
        order = Mock()
        table.update_item.side_effect = lambda **kwargs: (order.commit(kwargs), {})[1]
        with patch.object(update_album, "require_admin", return_value=None), patch.object(update_album, "table", table), \
                patch.object(update_album, "_reconcile_album_qr", return_value=None), patch.object(update_album, "_audit"), \
                patch.object(trash_bin, "record", side_effect=lambda *args: order.record(*args)), \
                patch.object(trash_bin, "forget", side_effect=lambda *args: order.forget(*args)):
            response = update_album.handler(event(body), None)
        return response, [entry[0] for entry in order.mock_calls], order

    def test_binning_indexes_first_and_restoring_cleans_up_after(self):
        hidden = album(visibility="unlisted", isShared=False)
        response, steps, order = self._call({"trash": True}, hidden)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(steps, ["record", "commit"])
        self.assertEqual(order.record.call_args.args[0], ALBUM_ID)

        binned = album(visibility="unlisted", isShared=False, trashedAt=STAMP, trashedFrom={"visibility": "unlisted"})
        response, steps, order = self._call({"restore": True}, binned)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(steps, ["commit", "forget"])
        order.forget.assert_called_once_with(ALBUM_ID, STAMP)

        # Repeats are no-ops.
        self.assertEqual(self._call({"trash": True}, binned)[1], [])
        self.assertEqual(self._call({"restore": True}, hidden)[1], [])


class PurgeTests(unittest.TestCase):
    def run_purge(self, entries, albums, outcomes=None, remaining=60_000):
        table = Mock()
        table.get_item.side_effect = lambda Key, **_: {"Item": albums[Key["albumId"]]} if Key["albumId"] in albums else {}
        outcomes = dict(outcomes or {})

        def delete(album, context):
            outcome = outcomes.get(album["albumId"])
            if outcome:
                raise outcome
            return 3

        context = Mock(get_remaining_time_in_millis=Mock(return_value=remaining))
        with patch.object(delete_album, "table", table), patch.object(delete_album, "delete_album_record", side_effect=delete) as deleted, \
                patch.object(trash_bin, "expired", return_value=entries) as expired, \
                patch.object(trash_bin, "forget") as forget, patch.object(trash_bin, "record") as record:
            result = delete_album.purge_expired(context, now=NOW)
        expired.assert_called_once_with(NOW)
        return result, deleted, forget, record

    def binned(self, name, at=STAMP, **extra):
        return album(albumId=name, visibility="unlisted", trashedAt=at, trashedFrom={"visibility": "public"}, **extra)

    def test_expired_albums_are_deleted_and_leave_the_index(self):
        albums = {name: self.binned(name) for name in ("done", "pending", "busy", "large", "backup")}
        outcomes = {
            "pending": delete_album.DeletionPending(),
            "busy": delete_album.DeletionConflict("busy"),
            "large": delete_album.DeletionTooLargeError("large"),
            "backup": delete_album.drive_backup_jobs.DriveBackupBusy("backup"),
        }
        entries = [(name, STAMP) for name in ("done", "pending", "busy")]
        result, deleted, forget, _ = self.run_purge(entries, albums, outcomes)
        self.assertEqual(result, {"purged": 1, "waiting": 2})
        self.assertEqual([entry.args[0]["albumId"] for entry in deleted.call_args_list], ["done", "pending", "busy"])
        forget.assert_called_once_with("done", STAMP)
        result, _, _, _ = self.run_purge([("large", STAMP), ("backup", STAMP)], albums, outcomes)
        self.assertEqual(result, {"purged": 0, "waiting": 2})

    def test_stale_entries_are_repaired_or_dropped(self):
        albums = {
            "moved": self.binned("moved", "2026-09-30T00:00:00Z"),
            "restored": album(albumId="restored"),
            "updating": self.binned("updating", status="updating"),
            "deleting": self.binned("deleting", status="deleting"),
        }
        entries = [("gone", STAMP), ("moved", STAMP), ("restored", STAMP), ("updating", STAMP), ("deleting", STAMP)]
        result, deleted, forget, record = self.run_purge(entries, albums)
        self.assertEqual(result, {"purged": 1, "waiting": 1})
        self.assertEqual([entry.args[0]["albumId"] for entry in deleted.call_args_list], ["deleting"])
        record.assert_called_once_with("moved", "2026-09-30T00:00:00Z")
        self.assertEqual(forget.call_args_list, [call("gone", STAMP), call("restored", STAMP), call("deleting", STAMP)])

    def test_a_run_is_bounded(self):
        names = [f"album-{index}" for index in range(delete_album.PURGE_BATCH + 2)]
        albums = {name: self.binned(name) for name in names}
        result, _, _, _ = self.run_purge([(name, STAMP) for name in names], albums)
        self.assertEqual(result["purged"], delete_album.PURGE_BATCH)
        result, deleted, _, _ = self.run_purge([(name, STAMP) for name in names], albums, remaining=1000)
        deleted.assert_not_called()

    def test_the_schedule_event_runs_the_purge(self):
        with patch.object(delete_album, "purge_expired", return_value={"purged": 0}) as purge, \
                patch.object(delete_album, "verify_front_door_request") as front_door:
            self.assertEqual(delete_album.handler({"source": "trash-purge"}, CONTEXT), {"purged": 0})
        purge.assert_called_once_with(CONTEXT)
        front_door.assert_not_called()


class BinRoundTripTests(unittest.TestCase):
    """Bin and restore through the durable privacy transition, on emulated AWS."""

    setUp = publication.PublicationRecoveryTests.setUp
    put = publication.PublicationRecoveryTests.put
    album = publication.PublicationRecoveryTests.album
    object = publication.PublicationRecoveryTests.object
    tag = publication.PublicationRecoveryTests.tag

    def request(self, body):
        return update_album.handler({"pathParameters": {"albumId": ALBUM}, "body": __import__("json").dumps(body)}, CONTEXT)

    def test_a_public_album_is_hidden_then_restored(self):
        settings = boto3.resource("dynamodb", region_name="us-west-2").create_table(
            TableName="settings-test", KeySchema=[{"AttributeName": "settingId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "settingId", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST",
        )
        self.object(RAW, "public")
        with patch.object(scheduled_publish, "_table", settings):
            response = self.request({"trash": True})
            self.assertEqual(response["statusCode"], 200, response)
            binned = self.album()
            self.assertEqual((binned["visibility"], binned["status"], binned["trashedFrom"]), ("unlisted", "active", {"visibility": "public"}))
            self.assertEqual(self.tag(RAW), "unlisted")
            index = settings.get_item(Key=INDEX_KEY)["Item"]["albums"]
            self.assertEqual(index, {ALBUM: binned["trashedAt"]})
            # A retried request is a no-op.
            self.assertEqual(self.request({"trash": True})["statusCode"], 200)

            response = self.request({"restore": True})
            self.assertEqual(response["statusCode"], 200, response)
            restored = self.album()
            self.assertEqual(restored["visibility"], "public")
            self.assertNotIn("trashedAt", restored)
            self.assertNotIn("trashedFrom", restored)
            self.assertEqual(self.tag(RAW), "public")
            self.assertEqual(settings.get_item(Key=INDEX_KEY)["Item"]["albums"], {})


if __name__ == "__main__":
    unittest.main()
