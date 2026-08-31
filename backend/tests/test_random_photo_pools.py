import datetime as dt
import unittest
from unittest.mock import MagicMock

from random_photo_pools import (
    POOL_PARTITION,
    POOL_RECORD_TYPE,
    POOL_SCHEMA_VERSION,
    POOL_SHARD_RECORD_TYPE,
    POOL_SHARD_SIZE,
    build_reference_pools,
    load_pool_references,
    metadata_sort_key,
    pool_id,
    replace_materialized_pools,
    shard_sort_key,
)


ALBUM_ID = "11111111-1111-4111-8111-111111111111"


class NoShuffle:
    def shuffle(self, values):
        return None


class RandomPhotoPoolTests(unittest.TestCase):
    def test_builds_global_and_category_decks_from_public_photos_only(self):
        albums = [
            {
                "albumId": ALBUM_ID,
                "visibility": "public",
                "status": "active",
                "type": "photo",
                "category": "Birding",
                "images": [
                    {"rawKey": f"albums/{ALBUM_ID}/original/one.jpg"},
                    {"rawKey": f"albums/{ALBUM_ID}/original/two.jpg"},
                ],
            },
            {
                "albumId": "22222222-2222-4222-8222-222222222222",
                "visibility": "private",
                "status": "active",
                "type": "photo",
                "images": [{"rawKey": "albums/private/original/no.jpg"}],
            },
            {
                "albumId": "33333333-3333-4333-8333-333333333333",
                "visibility": "public",
                "status": "active",
                "type": "video",
                "images": [{"rawKey": "albums/video/original/no.mp4"}],
            },
        ]

        pools = build_reference_pools(albums, randomizer=NoShuffle())

        self.assertEqual(len(pools[None]), 2)
        self.assertEqual(pools["Birding"], pools[None])
        self.assertNotIn("Uncategorized", pools)

    def test_legacy_loader_and_uncategorized_pool_are_supported(self):
        album = {
            "albumId": ALBUM_ID,
            "visibility": "public",
            "status": "active",
            "images": [],
        }
        legacy_loader = MagicMock(
            return_value=[{"rawKey": f"albums/{ALBUM_ID}/original/legacy.jpg"}]
        )

        pools = build_reference_pools(
            [album], legacy_loader=legacy_loader, randomizer=NoShuffle()
        )

        self.assertEqual(pools["Uncategorized"], pools[None])
        legacy_loader.assert_called_once_with(album)

    def test_load_reads_only_shards_needed_for_the_current_window(self):
        generation = "0123456789abcdef"
        identifier = pool_id(None)
        references = [f"{ALBUM_ID}:{index:024x}" for index in range(300)]
        metadata = {
            "albumId": POOL_PARTITION,
            "mediaId": metadata_sort_key(None),
            "recordType": POOL_RECORD_TYPE,
            "schemaVersion": POOL_SCHEMA_VERSION,
            "poolId": identifier,
            "generation": generation,
            "category": "",
            "totalPhotos": len(references),
            "shardSize": POOL_SHARD_SIZE,
            "shardCount": 2,
            "generatedAt": "2026-08-31T00:00:00Z",
        }
        table = MagicMock()
        table.name = "preview-table"
        table.get_item.return_value = {"Item": metadata}
        resource = MagicMock()

        def batch_get(*, RequestItems):
            items = []
            for key in RequestItems[table.name]["Keys"]:
                index = int(key["mediaId"].rsplit("#", 1)[-1])
                items.append({
                    "albumId": POOL_PARTITION,
                    "mediaId": key["mediaId"],
                    "recordType": POOL_SHARD_RECORD_TYPE,
                    "schemaVersion": POOL_SCHEMA_VERSION,
                    "poolId": identifier,
                    "generation": generation,
                    "shardIndex": index,
                    "references": references[
                        index * POOL_SHARD_SIZE:(index + 1) * POOL_SHARD_SIZE
                    ],
                })
            return {"Responses": {table.name: items}}

        resource.batch_get_item.side_effect = batch_get
        result = load_pool_references(
            table,
            resource,
            now=dt.datetime(2026, 8, 31, tzinfo=dt.timezone.utc),
        )

        self.assertEqual(result["totalPhotos"], 300)
        self.assertEqual(len(result["references"]), 80)
        self.assertLessEqual(
            len(resource.batch_get_item.call_args.kwargs["RequestItems"][table.name]["Keys"]),
            2,
        )

    def test_replace_publishes_shards_and_metadata_then_removes_stale_records(self):
        generation = "0123456789abcdef"
        references = [f"{ALBUM_ID}:{index:024x}" for index in range(300)]
        stale_key = shard_sort_key(pool_id(None), "fedcba9876543210", 0)
        table = MagicMock()
        batch = MagicMock()
        table.batch_writer.return_value.__enter__.return_value = batch
        table.query.return_value = {
            "Items": [
                {"mediaId": metadata_sort_key(None)},
                {"mediaId": stale_key},
            ]
        }

        result = replace_materialized_pools(
            table,
            {None: references},
            generation=generation,
            generated_at=dt.datetime(2026, 8, 31, tzinfo=dt.timezone.utc),
        )

        self.assertEqual(
            result,
            {"generation": generation, "poolCount": 1, "totalPhotos": 300},
        )
        self.assertEqual(batch.put_item.call_count, 2)
        metadata = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(metadata["generation"], generation)
        self.assertEqual(metadata["shardCount"], 2)
        batch.delete_item.assert_called_once_with(
            Key={"albumId": POOL_PARTITION, "mediaId": stale_key}
        )

    def test_unknown_category_is_empty_after_global_pool_is_ready(self):
        ready = {
            "recordType": POOL_RECORD_TYPE,
            "schemaVersion": POOL_SCHEMA_VERSION,
            "poolId": pool_id(None),
            "generation": "0123456789abcdef",
            "category": "",
            "totalPhotos": 0,
            "shardSize": POOL_SHARD_SIZE,
            "shardCount": 0,
            "generatedAt": "2026-08-31T00:00:00Z",
        }
        table = MagicMock()
        table.get_item.side_effect = [{}, {"Item": ready}]

        result = load_pool_references(table, MagicMock(), "Not a category")

        self.assertEqual(result["references"], [])
        self.assertEqual(result["totalPhotos"], 0)


if __name__ == "__main__":
    unittest.main()
