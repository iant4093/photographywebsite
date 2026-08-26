import assert from 'node:assert/strict'
import test from 'node:test'

import {
    EXPLORE_FACET_RECORD_TYPE,
    EXPLORE_INDEX_RECORD_TYPE,
    desiredIndexRecords,
    facetPartition,
    indexSortKey,
    metadataFacets,
    syncExploreIndex,
} from './explore-index.mjs'

const albumId = '11111111-1111-4111-8111-111111111111'
const mediaId = 'a'.repeat(24)

function metadata(changes = {}) {
    return {
        albumId,
        mediaId,
        status: 'ready',
        exploreVersion: 2,
        colorFamilies: ['blue', 'green'],
        lens: 'Sigma 18-50mm F2.8',
        lensKey: 'sigma 18-50mm f2.8',
        ...changes,
    }
}

test('builds deterministic sparse entries and a lens definition', () => {
    assert.equal(indexSortKey(albumId, mediaId), indexSortKey(albumId, mediaId))
    assert.equal(metadataFacets(metadata()).size, 3)
    const records = desiredIndexRecords(metadata(), true)
    assert.equal(records.filter(item => item.recordType === EXPLORE_INDEX_RECORD_TYPE).length, 3)
    assert.equal(records.filter(item => item.recordType === EXPLORE_FACET_RECORD_TYPE).length, 1)
    assert.deepEqual(desiredIndexRecords(metadata(), false), [])
    assert.throws(() => facetPartition('color', 'chartreuse'), /Unsupported/)
})

test('reconciles stale rows and retries unprocessed writes', async () => {
    const calls = []
    const client = {
        async send(command) {
            const requests = command.input.RequestItems.previews
            calls.push(requests)
            if (calls.length === 1) return { UnprocessedItems: { previews: requests.slice(0, 1) } }
            return { UnprocessedItems: {} }
        },
    }
    await syncExploreIndex(
        client,
        'previews',
        metadata({ colorFamilies: ['red'], lens: 'Old Lens', lensKey: 'old lens' }),
        metadata({ colorFamilies: ['blue'], lens: 'New Lens', lensKey: 'new lens' }),
        'public',
        input => ({ input }),
    )
    assert.ok(calls.length >= 2)
    assert.ok(calls[0].some(item => item.DeleteRequest))
    assert.ok(calls[0].some(item => item.PutRequest))
})

test('rejects malformed metadata and a permanently unprocessed batch', async () => {
    assert.equal(metadataFacets(metadata({ status: 'pending' })).size, 0)
    const client = {
        async send(command) {
            return { UnprocessedItems: command.input.RequestItems }
        },
    }
    await assert.rejects(
        syncExploreIndex(client, 'previews', null, metadata(), 'public', input => ({ input })),
        /remained unprocessed/,
    )
})
