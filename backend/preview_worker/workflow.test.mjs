import assert from 'node:assert/strict'
import test from 'node:test'

import { previewKeysFor } from './contract.mjs'
import { validateReadyOrMarkPending } from './workflow.mjs'

const albumId = '11111111-1111-4111-8111-111111111111'
const rawKey = `albums/${albumId}/original/photo.jpg`
const keys = previewKeysFor(albumId, rawKey)
const metadata = {
    status: 'ready',
    previewVersion: 2,
    previewKeys: keys,
    sourceSha256: 'a'.repeat(64),
    dimensions: {
        640: { width: 640, height: 427 },
        1280: { width: 1280, height: 853 },
    },
}

test('accepts a ready row only after both objects validate and are retagged', async () => {
    const validated = []
    const tagged = []
    const accepted = await validateReadyOrMarkPending({
        metadata,
        expectedKeys: keys,
        validateObject: async (key) => validated.push(key),
        tagObject: async (key) => tagged.push(key),
        visibility: 'private',
        markPending: async () => assert.fail('must not mark valid metadata pending'),
    })
    assert.equal(accepted, true)
    assert.deepEqual(validated, [keys['640'], keys['1280']])
    assert.deepEqual(tagged, validated)
})

test('missing stored object marks a ready row pending before regeneration', async () => {
    let markedPending = 0
    const accepted = await validateReadyOrMarkPending({
        metadata,
        expectedKeys: keys,
        validateObject: async () => { throw new Error('NoSuchKey') },
        tagObject: async () => {},
        visibility: 'public',
        markPending: async () => { markedPending += 1 },
    })
    assert.equal(accepted, false)
    assert.equal(markedPending, 1)
})

test('corrupt ready metadata is hidden by marking it pending', async () => {
    let markedPending = 0
    const accepted = await validateReadyOrMarkPending({
        metadata: { ...metadata, sourceSha256: 'invalid' },
        expectedKeys: keys,
        validateObject: async () => assert.fail('must reject before object validation'),
        tagObject: async () => {},
        visibility: 'unlisted',
        markPending: async () => { markedPending += 1 },
    })
    assert.equal(accepted, false)
    assert.equal(markedPending, 1)
})
