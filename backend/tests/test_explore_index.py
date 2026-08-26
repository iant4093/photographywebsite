import unittest

from explore_index import (
    FACET_RECORD_TYPE,
    INDEX_RECORD_TYPE,
    desired_index_records,
    facet_partition,
    index_entry_keys,
    index_sort_key,
    metadata_facets,
    ready_marker,
    sync_metadata_index,
)


ALBUM_ID = "11111111-1111-4111-8111-111111111111"
MEDIA_ID = "a" * 24


def metadata(**changes):
    record = {
        "albumId": ALBUM_ID,
        "mediaId": MEDIA_ID,
        "status": "ready",
        "exploreVersion": 2,
        "colorFamilies": ["blue", "green", "blue"],
        "lens": "Sigma 18-50mm F2.8",
        "lensKey": "sigma 18-50mm f2.8",
    }
    record.update(changes)
    return record


class Batch:
    def __init__(self):
        self.puts = []
        self.deletes = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def put_item(self, *, Item):
        self.puts.append(Item)

    def delete_item(self, *, Key):
        self.deletes.append(Key)


class Table:
    def __init__(self):
        self.batch = Batch()

    def batch_writer(self, **_kwargs):
        return self.batch


class ExploreIndexTests(unittest.TestCase):
    def test_contract_is_deterministic_and_keeps_only_supported_facets(self):
        record = metadata(colorFamilies=["blue", "chartreuse", "blue"])
        facets = metadata_facets(record)
        self.assertEqual(set(facets.values()), {"blue", "Sigma 18-50mm F2.8"})
        self.assertEqual(index_sort_key(ALBUM_ID, MEDIA_ID), index_sort_key(ALBUM_ID, MEDIA_ID))
        self.assertTrue(index_sort_key(ALBUM_ID, MEDIA_ID).endswith(f"#{ALBUM_ID}#{MEDIA_ID}"))

    def test_public_records_include_sparse_entries_and_one_lens_definition(self):
        records = desired_index_records(metadata(), public=True)
        self.assertEqual(sum(item["recordType"] == INDEX_RECORD_TYPE for item in records), 3)
        definitions = [item for item in records if item["recordType"] == FACET_RECORD_TYPE]
        self.assertEqual(len(definitions), 1)
        self.assertEqual(definitions[0]["name"], "Sigma 18-50mm F2.8")
        self.assertEqual(desired_index_records(metadata(), public=False), [])
        self.assertEqual(ready_marker()["mediaId"], "READY")

    def test_sync_removes_old_entries_and_writes_current_records(self):
        table = Table()
        previous = metadata(colorFamilies=["red"], lens="Old Lens", lensKey="old lens")
        current = metadata(colorFamilies=["blue"], lens="New Lens", lensKey="new lens")
        sync_metadata_index(table, previous, current, public=True)

        deleted_partitions = {item["albumId"] for item in table.batch.deletes}
        self.assertEqual(deleted_partitions, {
            facet_partition("color", "red"),
            facet_partition("lens", "old lens"),
        })
        self.assertEqual(
            {item["albumId"] for item in table.batch.puts if item["recordType"] == INDEX_RECORD_TYPE},
            {facet_partition("color", "blue"), facet_partition("lens", "new lens")},
        )
        self.assertEqual(len(index_entry_keys(current)), 2)

    def test_incomplete_metadata_cannot_enter_the_index(self):
        self.assertEqual(metadata_facets(metadata(status="pending")), {})
        self.assertEqual(metadata_facets(metadata(exploreVersion=1)), {})
        self.assertEqual(metadata_facets(metadata(lensKey="wrong"))[facet_partition("color", "blue")], "blue")


if __name__ == "__main__":
    unittest.main()
