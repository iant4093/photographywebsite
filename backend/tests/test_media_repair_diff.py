"""Exercise complete repair parity and interrupted writes against real boto3 batching."""
import copy
import random
import unittest
from decimal import Decimal
from unittest.mock import patch

import test_support  # noqa: F401
import boto3
from boto3.dynamodb.conditions import Key
from moto import mock_aws
import album_media_store as media
from media_access import media_id_for_key

ALBUM = '11111111-1111-4111-8111-111111111111'
FIELDS = {'thumbKey', 'hlsUrl', 'blurhash', 'width', 'height', 'exif', 'thumbnailTime',
          'mediaConvertJobId', 'originalFilename', 'altText', 'isFavorite', 'captionVtt',
          'captionLanguage', 'transcript', 'scrubFrames'}


def expected(images):
    rows = {}
    for position, image in enumerate(images if isinstance(images, list) else []):
        image = image if isinstance(image, dict) else {'rawKey': image}
        key = image.get('rawKey') or image.get('key') or ''
        identity = media_id_for_key(key)
        rows[identity] = {'albumId': ALBUM, 'mediaId': identity, 'rawKey': key,
                          'orderKey': f'{position:012d}#{identity}', 'recordType': 'albumMedia',
                          'schemaVersion': 1, **{k: v for k, v in image.items() if k in FIELDS}}
    return rows


def images(count):
    return [{'rawKey': f'albums/{ALBUM}/original/{i}.jpg', 'width': 1600,
             'height': 1000, 'altText': f'Photo {i}', 'isFavorite': False} for i in range(count)]


class MediaRepairDiffTests(unittest.TestCase):
    def setUp(self):
        self.aws = mock_aws(); self.aws.start()
        self.table = boto3.resource('dynamodb', region_name='us-west-2').create_table(
            TableName='repair-media', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'albumId', 'KeyType': 'HASH'}, {'AttributeName': 'mediaId', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'albumId', 'AttributeType': 'S'}, {'AttributeName': 'mediaId', 'AttributeType': 'S'}])
        self.source = patch.object(media, '_table', return_value=self.table); self.source.start()

    def tearDown(self):
        self.source.stop(); self.aws.stop()

    def rows(self):
        result = {}; cursor = None
        while True:
            params = {'KeyConditionExpression': Key('albumId').eq(ALBUM), 'ConsistentRead': True}
            if cursor: params['ExclusiveStartKey'] = cursor
            response = self.table.query(**params)
            result.update((r['mediaId'], r) for r in response['Items'])
            cursor = response.get('LastEvaluatedKey')
            if not cursor: return result

    def seed(self, rows):
        with self.table.batch_writer() as batch:
            for row in self.rows().values(): batch.delete_item(Key={'albumId': ALBUM, 'mediaId': row['mediaId']})
        with self.table.batch_writer() as batch:
            for row in rows.values(): batch.put_item(Item=row)
        self.assertEqual(self.rows(), rows)

    def test_randomized_differential_snapshots_preserve_all_fields_and_last_duplicate(self):
        rng = random.Random(771298)
        corpus = [None, [], [f'albums/{ALBUM}/legacy.jpg'],
                  [{'key': 'legacy', 'thumbnailTime': Decimal('0'), 'transcript': None, 'isFavorite': False}],
                  [{'rawKey': 'repeated', 'altText': 'first'}, {'rawKey': 'repeated', 'altText': 'last'}]]
        for _ in range(60):
            values = images(rng.randrange(1, 60)); rng.shuffle(values)
            for value in values:
                for field in FIELDS:
                    if rng.randrange(4) == 0: value[field] = {'width': Decimal('20'), 'thumbnailTime': Decimal('0'), 'isFavorite': False, 'exif': {'nested': [Decimal('1'), None]}, 'scrubFrames': {'columns': 6}}.get(field, None if rng.randrange(2) else 'synthetic')
            corpus.append(values)
        for values in corpus:
            with self.subTest(count=len(values or [])):
                old = expected(images(65)); next(iter(old.values()))['unknownLegacyField'] = 'remove'
                self.seed(old); self.assertTrue(media.replace_album_media(ALBUM, values)); self.assertEqual(self.rows(), expected(values))

    def test_actual_wire_counts_for_unchanged_caption_reorder_and_delete(self):
        for count in (1, 24, 25, 26, 100, 500):
            for operation in ('unchanged', 'caption', 'reverse', 'remove-first'):
                before = images(count); after = copy.deepcopy(before)
                if operation == 'caption': after[-1]['altText'] = 'Changed'
                if operation == 'reverse': after.reverse()
                if operation == 'remove-first': after = after[1:]
                self.seed(expected(before)); calls = []; send = self.table.meta.client.batch_write_item
                def capture(**kwargs):
                    calls.extend(copy.deepcopy(kwargs['RequestItems'][self.table.name])); return send(**kwargs)
                with self.subTest(count=count, operation=operation), patch.object(self.table.meta.client, 'batch_write_item', side_effect=capture):
                    media.replace_album_media(ALBUM, after)
                    old, new = expected(before), expected(after)
                    self.assertEqual(sum('DeleteRequest' in r for r in calls), len(old.keys() - new.keys()))
                    self.assertEqual(sum('PutRequest' in r for r in calls), sum(old.get(k) != v for k, v in new.items()))
                    self.assertEqual(self.rows(), new)
                    if operation == 'unchanged': self.assertEqual(calls, [])
                    if operation == 'caption': self.assertEqual(len(calls), 1)

    def test_all_pages_are_consistent_and_no_writes_start_before_complete_read(self):
        target = images(100); self.seed(expected(target)); query = self.table.query
        def small_pages(**kwargs):
            self.assertTrue(kwargs['ConsistentRead']); self.assertNotIn('IndexName', kwargs)
            self.assertNotIn('ProjectionExpression', kwargs)
            return query(**kwargs, Limit=7)
        with patch.object(self.table, 'query', side_effect=small_pages) as pages, patch.object(self.table, 'batch_writer') as writer:
            self.assertTrue(media.replace_album_media(ALBUM, target)); self.assertGreater(pages.call_count, 10); writer.assert_not_called()
        with patch.object(self.table, 'query', side_effect=[query(KeyConditionExpression=Key('albumId').eq(ALBUM), Limit=7), RuntimeError('read outage')]), patch.object(self.table, 'batch_writer') as writer:
            with self.assertRaises(RuntimeError): media.replace_album_media(ALBUM, target)
            writer.assert_not_called()

    def test_repeated_cursor_and_foreign_partition_fail_before_writing(self):
        for response in ({'Items': [], 'LastEvaluatedKey': {'albumId': ALBUM, 'mediaId': 'same'}},
                         {'Items': [{'albumId': 'other', 'mediaId': 'x'}]}):
            with self.subTest(response=response), patch.object(self.table, 'query', return_value=response), patch.object(self.table, 'batch_writer') as writer:
                with self.assertRaises(RuntimeError): media.replace_album_media(ALBUM, images(1))
                writer.assert_not_called()

    def test_every_batch_interruption_converges_with_new_or_legacy_restart(self):
        # Simulate an acknowledged partial batch, then loss of the next reply.
        before, after = expected(images(75)), list(reversed(images(75)))
        send = self.table.meta.client.batch_write_item
        for failed_batch in (1, 2, 3):
            for restart in ('diff', 'legacy'):
                self.seed(before); count = 0
                def fail_after_side_effect(**kwargs):
                    nonlocal count
                    count += 1; result = send(**kwargs)
                    if count == failed_batch: raise RuntimeError('lost provider reply')
                    return result
                with self.subTest(batch=failed_batch, restart=restart), patch.object(self.table.meta.client, 'batch_write_item', side_effect=fail_after_side_effect):
                    with self.assertRaises(RuntimeError): media.replace_album_media(ALBUM, after)
                if restart == 'legacy':
                    # Frozen legacy delete-all/put-all batch algorithm, unchanged schema.
                    with self.table.batch_writer(overwrite_by_pkeys=['albumId', 'mediaId']) as batch:
                        for row in self.rows().values(): batch.delete_item(Key={'albumId': ALBUM, 'mediaId': row['mediaId']})
                        for row in expected(after).values(): batch.put_item(Item=row)
                else: media.replace_album_media(ALBUM, after)
                self.assertEqual(self.rows(), expected(after))

    def test_unprocessed_items_are_retried_by_the_real_batch_writer(self):
        send = self.table.meta.client.batch_write_item; remaining = None
        def partial(**kwargs):
            nonlocal remaining
            if remaining is None:
                requests = kwargs['RequestItems'][self.table.name]; remaining = requests[-3:]
                send(RequestItems={self.table.name: requests[:-3]})
                return {'UnprocessedItems': {self.table.name: remaining}}
            return send(**kwargs)
        with patch.object(self.table.meta.client, 'batch_write_item', side_effect=partial) as calls:
            media.replace_album_media(ALBUM, images(25))
        self.assertEqual(calls.call_count, 2); self.assertEqual(self.rows(), expected(images(25)))

    def test_no_configured_table_preserves_legacy_fallback(self):
        with patch.object(media, '_table', return_value=None): self.assertFalse(media.replace_album_media(ALBUM, images(1)))

    def test_boolean_and_number_remain_distinct_in_nested_attributes(self):
        before = [{'rawKey': 'typed', 'exif': {'flag': Decimal('0')}, 'isFavorite': Decimal('0')}]
        after = [{'rawKey': 'typed', 'exif': {'flag': False}, 'isFavorite': False}]
        self.seed(expected(before)); media.replace_album_media(ALBUM, after)
        row = next(iter(self.rows().values()))
        self.assertIs(row['isFavorite'], False); self.assertIs(row['exif']['flag'], False)

    def test_decimal_scale_is_equal_and_invalid_floats_still_fail(self):
        before = [{'rawKey': 'typed', 'width': Decimal('20.00'), 'exif': {'set': {Decimal('1.0'), Decimal('2.0')}}}]
        self.seed(expected(before))
        with patch.object(self.table, 'batch_writer') as writes:
            media.replace_album_media(ALBUM, [{'rawKey': 'typed', 'width': 20, 'exif': {'set': {1, 2}}}]); writes.assert_not_called()
        with self.assertRaises(TypeError): media.replace_album_media(ALBUM, [{'rawKey': 'typed', 'width': 20.0}])

    def test_interrupted_legacy_write_restarts_under_diff_without_resurrection(self):
        old, target = images(60), images(40)
        send = self.table.meta.client.batch_write_item
        for boundary in (1, 2, 3, 4):
            self.seed(expected(old)); count = 0
            def fail(**kwargs):
                nonlocal count
                count += 1; response = send(**kwargs)
                if count == boundary: raise RuntimeError('legacy interruption')
                return response
            with self.subTest(boundary=boundary), patch.object(self.table.meta.client, 'batch_write_item', side_effect=fail):
                with self.assertRaises(RuntimeError):
                    with self.table.batch_writer(overwrite_by_pkeys=['albumId', 'mediaId']) as batch:
                        for row in self.rows().values(): batch.delete_item(Key={'albumId': ALBUM, 'mediaId': row['mediaId']})
                        for row in expected(target).values(): batch.put_item(Item=row)
            media.replace_album_media(ALBUM, target)
            self.assertEqual(self.rows(), expected(target))
