import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from botocore.exceptions import ClientError

import test_support  # noqa: F401  (sets the function environment)
import album_slugs
import get_public_album
import media_access
import update_album


TRIP = "11111111-1111-4111-8111-111111111111"
TRIP_TOO = "22222222-2222-4222-8222-222222222222"
WALK = "33333333-3333-4333-8333-333333333333"


def conditional_failure():
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "no"}}, "UpdateItem")


class FakeSettings:
    """GallerySettingsTable: slug claims and the albumId -> slug map."""

    def __init__(self):
        self.items = {}

    def get_item(self, Key):
        item = self.items.get(Key["settingId"])
        return {"Item": item} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues=None, ConditionExpression=None, ExpressionAttributeNames=None):
        key = Key["settingId"]
        item = self.items.setdefault(key, {"settingId": key}) if not ConditionExpression else self.items.get(key)
        if UpdateExpression == "SET albumId = :album":
            album_id = ExpressionAttributeValues[":album"]
            if item is not None and item.get("albumId") not in (None, album_id):
                raise conditional_failure()
            self.items[key] = {"settingId": key, "albumId": album_id}
        elif UpdateExpression.startswith("SET albums = if_not_exists"):
            item.setdefault("albums", {})
        else:
            item["albums"][ExpressionAttributeNames["#album"]] = ExpressionAttributeValues[":slug"]


class FakeAlbums:
    def __init__(self, albums):
        self.albums = {album["albumId"]: dict(album) for album in albums}
        self.queries = []

    def get_item(self, Key, **_):
        album = self.albums.get(Key["albumId"])
        return {"Item": dict(album)} if album else {}

    def update_item(self, Key, UpdateExpression, ConditionExpression, ExpressionAttributeValues):
        album = self.albums.get(Key["albumId"])
        if not album or "slug" in album:
            raise conditional_failure()
        album["slug"] = ExpressionAttributeValues[":slug"]

    def query(self, **arguments):
        self.queries.append(arguments)
        public = sorted((album for album in self.albums.values() if album.get("visibility") == "public"), key=lambda album: album["createdAt"])
        items = [{key: album[key] for key in ("albumId", "title", "status") if key in album} for album in public]
        start = arguments.get("ExclusiveStartKey")
        offset = start["offset"] if start else 0
        page = items[offset:offset + 2]
        return {"Items": page, **({"LastEvaluatedKey": {"offset": offset + 2}} if offset + 2 < len(items) else {})}


def album(album_id, title, created, **extra):
    return {"albumId": album_id, "title": title, "createdAt": created, "visibility": "public", "status": "active", **extra}


class SlugifyTests(unittest.TestCase):
    def test_titles_become_short_readable_slugs(self):
        cases = {
            "Day 2 - Prague Castle, Walkaround, & Sunset": "day-2-prague-castle-walkaround-sunset",
            "Mary's Peak Meteor Shower 4-25": "marys-peak-meteor-shower-4-25",
            "  Café  Đà Lạt  ": "cafe-a-lat",
            "東京": "album",
            "": "album",
            None: "album",
            "11111111-1111-4111-8111-111111111111": "11111111-1111-4111-8111-111111111111-album",
        }
        for title, slug in cases.items():
            with self.subTest(title=title):
                self.assertEqual(album_slugs.slugify(title), slug)
                self.assertTrue(album_slugs.is_slug(slug))
        long = album_slugs.slugify("A very long album title that keeps going well past what fits in a tidy web address")
        self.assertLessEqual(len(long), album_slugs.MAX_LENGTH)
        self.assertFalse(long.endswith("-"))
        self.assertEqual(album_slugs.slugify("x" * 80), "x" * 60)

    def test_only_lowercase_hyphenated_words_and_never_an_id(self):
        for value in ("Prague", "prague--2026", "-prague", "prague 2026", TRIP, "", None, 5, "a" * 80):
            with self.subTest(value=value):
                self.assertFalse(album_slugs.is_slug(value))
        self.assertTrue(album_slugs.is_slug("prague-2026"))

    def test_duplicate_names_fall_back_to_numbers_then_the_id(self):
        names = list(album_slugs.candidates("Prague", TRIP))
        self.assertEqual(names[:3], ["prague", "prague-2", "prague-3"])
        self.assertEqual(names[-1], "prague-11111111")


class AssignTests(unittest.TestCase):
    def setUp(self):
        self.settings = FakeSettings()
        patcher = patch.object(album_slugs, "_settings", return_value=self.settings)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_same_titled_albums_get_unique_slugs_that_resolve_to_each(self):
        albums = FakeAlbums([album(TRIP, "Prague", "2026-01-01"), album(TRIP_TOO, "Prague", "2026-02-01")])
        self.assertEqual(album_slugs.assign(albums, albums.albums[TRIP]), "prague")
        self.assertEqual(album_slugs.assign(albums, albums.albums[TRIP_TOO]), "prague-2")
        self.assertEqual(album_slugs.resolve("prague"), TRIP)
        self.assertEqual(album_slugs.resolve("prague-2"), TRIP_TOO)
        self.assertIsNone(album_slugs.resolve("prague-3"))
        self.assertIsNone(album_slugs.resolve("Not A Slug"))
        self.assertEqual(self.settings.items["album-slugs"]["albums"], {TRIP: "prague", TRIP_TOO: "prague-2"})
        # Assigning again is a no-op, and a renamed album keeps its URL.
        albums.albums[TRIP]["title"] = "Prague, renamed"
        self.assertEqual(album_slugs.assign(albums, albums.albums[TRIP]), "prague")

    def test_a_race_keeps_the_slug_the_album_record_holds(self):
        albums = FakeAlbums([album(TRIP, "Prague", "2026-01-01")])
        stale = dict(albums.albums[TRIP])
        albums.albums[TRIP]["slug"] = "prague-castle"
        self.assertEqual(album_slugs.assign(albums, stale), "prague-castle")
        # The claim it made still leads to the album, which redirects to its own slug.
        self.assertEqual(album_slugs.resolve("prague"), TRIP)
        self.assertIsNone(album_slugs.assign(albums, {"title": "No id"}))

    def test_a_deleted_album_gets_nothing_and_other_errors_surface(self):
        albums = FakeAlbums([])
        self.assertIsNone(album_slugs.assign(albums, album(WALK, "Walk", "2026-01-01")))
        failing = FakeSettings()
        failing.update_item = lambda **_: (_ for _ in ()).throw(ClientError({"Error": {"Code": "ThrottlingException"}}, "UpdateItem"))
        with patch.object(album_slugs, "_settings", return_value=failing), self.assertRaises(ClientError):
            album_slugs.assign(FakeAlbums([album(WALK, "Walk", "2026-01-01")]), album(WALK, "Walk", "2026-01-01"))

        class Exploding(FakeAlbums):
            def update_item(self, **_):
                raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException"}}, "UpdateItem")

        with self.assertRaises(ClientError):
            album_slugs.assign(Exploding([album(WALK, "Walk", "2026-01-01")]), album(WALK, "Walk", "2026-01-01"))

    def test_every_suffix_taken_gives_up(self):
        albums = FakeAlbums([album(WALK, "Walk", "2026-01-01")])
        with patch.object(album_slugs, "_claim", return_value=False):
            self.assertIsNone(album_slugs.assign(albums, albums.albums[WALK]))

    def test_quiet_assignment_only_names_active_public_albums_and_never_raises(self):
        albums = FakeAlbums([album(WALK, "Walk", "2026-01-01")])
        self.assertIsNone(album_slugs.assign_quietly(albums, {**albums.albums[WALK], "visibility": "unlisted"}))
        self.assertIsNone(album_slugs.assign_quietly(albums, {**albums.albums[WALK], "status": "deleting"}))
        self.assertIsNone(album_slugs.assign_quietly(albums, None))
        with patch.object(album_slugs, "assign", side_effect=RuntimeError("down")):
            self.assertIsNone(album_slugs.assign_quietly(albums, albums.albums[WALK]))
        self.assertEqual(album_slugs.assign_quietly(albums, albums.albums[WALK]), "walk")


class SweepTests(unittest.TestCase):
    def setUp(self):
        self.settings = FakeSettings()
        patcher = patch.object(album_slugs, "_settings", return_value=self.settings)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_names_public_albums_oldest_first_within_a_limit(self):
        albums = FakeAlbums([
            album(TRIP_TOO, "Prague", "2026-02-01"),
            album(TRIP, "Prague", "2026-01-01"),
            album(WALK, "Walk", "2026-03-01", slug="morning-walk"),
            {**album("44444444-4444-4444-8444-444444444444", "Private", "2026-01-15"), "visibility": "unlisted"},
            album("55555555-5555-4555-8555-555555555555", "Deleting", "2026-01-20", status="deleting"),
        ])
        with patch.dict("os.environ", {"PUBLIC_SUMMARY_INDEX": "VisibilityCreatedAtSummaryIndex"}):
            self.assertEqual(album_slugs.sweep(albums, limit=1), 1)
            self.assertEqual(albums.albums[TRIP]["slug"], "prague")
            self.assertNotIn("slug", albums.albums[TRIP_TOO])
            self.assertEqual(album_slugs.sweep(albums), 2)
            self.assertEqual(albums.albums[TRIP_TOO]["slug"], "prague-2")
            self.assertEqual(self.settings.items["album-slugs"]["albums"][WALK], "morning-walk")
            # Everything is named: the next run reads the index and the map, nothing else.
            self.assertEqual(album_slugs.sweep(albums), 0)
        query = albums.queries[0]
        self.assertEqual(query["IndexName"], "VisibilityCreatedAtSummaryIndex")
        self.assertTrue(query["ScanIndexForward"])

    def test_skips_albums_that_left_the_gallery_and_needs_the_index(self):
        albums = FakeAlbums([album(TRIP, "Prague", "2026-01-01")])
        with patch.dict("os.environ", {"PUBLIC_SUMMARY_INDEX": ""}):
            self.assertEqual(album_slugs.sweep(albums), 0)
        query = albums.query

        def stale_index(**arguments):
            page = query(**arguments)
            albums.albums[TRIP]["visibility"] = "unlisted"
            return page

        albums.query = stale_index
        with patch.dict("os.environ", {"PUBLIC_SUMMARY_INDEX": "Index"}):
            self.assertEqual(album_slugs.sweep(albums), 0)
        self.assertNotIn("slug", albums.albums[TRIP])


class ApiTests(unittest.TestCase):
    def test_summaries_carry_only_valid_public_slugs(self):
        base = {"albumId": TRIP, "type": "video", "title": "Prague", "visibility": "public"}
        self.assertEqual(media_access.serialize_album_summary({**base, "slug": "prague"})["slug"], "prague")
        for value in ("Prague!", None, 5):
            with self.subTest(value=value):
                self.assertNotIn("slug", media_access.serialize_album_summary({**base, "slug": value}))
        self.assertNotIn("slug", media_access.serialize_album_summary({**base, "visibility": "unlisted", "slug": "prague"}))

    def test_public_detail_and_link_previews_resolve_slugs(self):
        record = {**album(TRIP, "Prague", "2026-01-01"), "slug": "prague", "type": "photo",
                  "images": [{"rawKey": f"albums/{TRIP}/original/photo.jpg"}]}
        with patch.object(get_public_album, "verify_front_door_request", return_value=None), \
                patch.object(get_public_album.album_slugs, "resolve", return_value=TRIP) as resolve, \
                patch.object(get_public_album, "serialize_images", return_value=[]), \
                patch.object(get_public_album.table, "get_item", return_value={"Item": record}) as get_item:
            response = get_public_album.handler({"pathParameters": {"albumId": "prague"}}, None)
            self.assertEqual(response["statusCode"], 200)
            self.assertEqual(json.loads(response["body"])["album"]["slug"], "prague")
            resolve.assert_called_once_with("prague")
            get_item.assert_called_with(Key={"albumId": TRIP})
            self.assertEqual(get_public_album._route_album_id(TRIP), TRIP)
            metadata = get_public_album._social_album({"pathParameters": {"albumType": "album", "albumId": "prague"}})
        self.assertEqual(metadata["url"], f"{get_public_album.SITE_ORIGIN}/album/prague")


class UpdateAlbumNamingTests(unittest.TestCase):
    def test_public_commits_get_named_and_the_scheduled_run_sweeps(self):
        committed = album(TRIP, "Prague", "2026-01-01")
        with patch.object(update_album.album_slugs, "assign_quietly", return_value="prague") as assign:
            update_album._name_public_album(committed)
        assign.assert_called_once_with(update_album.table, committed)
        self.assertEqual(committed["slug"], "prague")
        unnamed = album(WALK, "Walk", "2026-01-01")
        with patch.object(update_album.album_slugs, "assign_quietly", return_value=None):
            update_album._name_public_album(unnamed)
        self.assertNotIn("slug", unnamed)

        context = SimpleNamespace(get_remaining_time_in_millis=lambda: 60000)
        with patch.object(update_album.scheduled_publish, "due", return_value=[]), \
                patch.object(update_album.album_slugs, "sweep", return_value=3) as sweep:
            self.assertEqual(update_album._publish_due(context), {"published": 0, "waiting": 0, "named": 3})
        sweep.assert_called_once_with(update_album.table)
        with patch.object(update_album.scheduled_publish, "due", return_value=[]), \
                patch.object(update_album.album_slugs, "sweep", side_effect=RuntimeError("down")):
            self.assertEqual(update_album._publish_due(context)["named"], 0)
        late = SimpleNamespace(get_remaining_time_in_millis=lambda: 5000)
        with patch.object(update_album.scheduled_publish, "due", return_value=[]), \
                patch.object(update_album.album_slugs, "sweep") as sweep:
            update_album._publish_due(late)
        sweep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
