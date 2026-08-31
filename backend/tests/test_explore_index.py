import hashlib
import unittest

from explore_index import (
    FACET_RECORD_TYPE,
    INDEX_RECORD_TYPE,
    desired_index_records,
    exposure_buckets,
    exposure_ready_marker,
    facet_partition,
    index_entry_keys,
    index_sort_key,
    metadata_facets,
    ready_marker,
    sync_album_index,
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
        "exposureBuckets": ["aperture:middle", "shutter:handheld", "iso:clean", "focal:normal"],
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
        self.assertEqual(set(facets.values()), {
            "blue", "Sigma 18-50mm F2.8", "aperture:middle",
            "shutter:handheld", "iso:clean", "focal:normal",
        })
        self.assertEqual(index_sort_key(ALBUM_ID, MEDIA_ID), index_sort_key(ALBUM_ID, MEDIA_ID))
        self.assertTrue(index_sort_key(ALBUM_ID, MEDIA_ID).endswith(f"#{ALBUM_ID}#{MEDIA_ID}"))

    def test_public_records_include_sparse_entries_and_one_lens_definition(self):
        records = desired_index_records(metadata(), public=True)
        self.assertEqual(sum(item["recordType"] == INDEX_RECORD_TYPE for item in records), 7)
        definitions = [item for item in records if item["recordType"] == FACET_RECORD_TYPE]
        self.assertEqual(len(definitions), 1)
        self.assertEqual(definitions[0]["name"], "Sigma 18-50mm F2.8")
        self.assertEqual(desired_index_records(metadata(), public=False), [])
        self.assertEqual(ready_marker()["mediaId"], "READY")
        self.assertEqual(exposure_ready_marker()["mediaId"], "EXPOSURE_READY")

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
            {
                facet_partition("color", "blue"), facet_partition("lens", "new lens"),
                facet_partition("exposure", "aperture:middle"),
                facet_partition("exposure", "shutter:handheld"),
                facet_partition("exposure", "iso:clean"),
                facet_partition("exposure", "focal:normal"),
            },
        )
        self.assertEqual(len(index_entry_keys(current)), 6)

    def test_legacy_metadata_probes_every_exposure_partition_for_safe_cleanup(self):
        record = metadata()
        record.pop("exposureBuckets")
        self.assertEqual(len(index_entry_keys(record)), 15)

    def test_album_visibility_sync_derives_exposure_buckets_from_the_manifest(self):
        table = Table()
        record = metadata()
        record.pop("exposureBuckets")
        album = {
            "albumId": ALBUM_ID,
            "status": "active",
            "visibility": "public",
            "type": "photo",
            "images": [{
                "rawKey": "albums/example/photo.jpg",
                "exif": {
                    "focalRatio": "f/2.8", "shutterSpeed": "1/500s",
                    "iso": "ISO 400", "focalLength": "400mm",
                },
            }],
        }
        derived_media_id = hashlib.sha256(
            album["images"][0]["rawKey"].encode("utf-8")
        ).hexdigest()[:24]
        record["mediaId"] = derived_media_id

        sync_album_index(table, album, {derived_media_id: record})

        partitions = {item["albumId"] for item in table.batch.puts}
        self.assertIn(facet_partition("exposure", "aperture:wide"), partitions)
        self.assertIn(facet_partition("exposure", "shutter:frozen"), partitions)
        self.assertIn(facet_partition("exposure", "iso:available"), partitions)
        self.assertIn(facet_partition("exposure", "focal:telephoto"), partitions)

    def test_incomplete_metadata_cannot_enter_the_index(self):
        self.assertEqual(metadata_facets(metadata(status="pending")), {})
        self.assertEqual(metadata_facets(metadata(exploreVersion=1)), {})
        self.assertEqual(metadata_facets(metadata(lensKey="wrong"))[facet_partition("color", "blue")], "blue")
        self.assertEqual(
            exposure_buckets({
                "focalRatio": "f/8", "shutterSpeed": "1/30s",
                "iso": "ISO 1600", "focalLength": "400mm",
            }),
            ["aperture:deep", "shutter:motion", "iso:low", "focal:telephoto"],
        )


if __name__ == "__main__":
    unittest.main()
