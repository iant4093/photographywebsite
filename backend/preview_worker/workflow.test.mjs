import assert from 'node:assert/strict'
import test from 'node:test'

import { previewKeysFor } from './contract.mjs'
import {
    isPreviousPreviewContract,
    readyPreviewDescriptor,
    validateReadyOrMarkPending,
} from './workflow.mjs'

const albumId = '11111111-1111-4111-8111-111111111111'
const rawKey = `albums/${albumId}/original/photo.jpg`
const keys = previewKeysFor(albumId, rawKey)
const metadata = {
    status: 'ready',
    previewVersion: 2,
    previewKeys: keys,
    sourceSha256: 'a'.repeat(64),
    dimensions: {
        480: { width: 480, height: 320 },
        640: { width: 640, height: 427 },
        1280: { width: 1280, height: 853 },
    },
}

test('accepts a ready row only after every object validates and is retagged', async () => {
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
    assert.deepEqual(validated, [keys['480'], keys['640'], keys['1280']])
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

test('rejects every incomplete ready-metadata contract boundary', () => {
    const invalid = [
        null,
        { ...metadata, status: 'pending' },
        { ...metadata, previewVersion: 1 },
        { ...metadata, previewKeys: null },
        { ...metadata, previewKeys: { ...keys, 1280: 'wrong' } },
        { ...metadata, sourceSha256: null },
        { ...metadata, sourceSha256: 'g'.repeat(64) },
        { ...metadata, dimensions: null },
        { ...metadata, dimensions: 'invalid' },
        { ...metadata, dimensions: { ...metadata.dimensions, 640: null } },
        { ...metadata, dimensions: { ...metadata.dimensions, 640: { width: 639, height: 427 } } },
        { ...metadata, dimensions: { ...metadata.dimensions, 640: { width: 640, height: 1.5 } } },
        { ...metadata, dimensions: { ...metadata.dimensions, 640: { width: 640, height: 0 } } },
    ]
    for (const value of invalid) assert.equal(readyPreviewDescriptor(value, keys), null)
    assert.deepEqual(readyPreviewDescriptor(metadata, keys), {
        sourceDigest: 'a'.repeat(64),
        outputs: {
            480: { width: 480, height: 320 },
            640: { width: 640, height: 427 },
            1280: { width: 1280, height: 853 },
        },
    })
})

test('recognizes only the exact previous ready contract for additive upgrades', () => {
    const previousKeys = { 640: keys['640'], 1280: keys['1280'] }
    assert.equal(isPreviousPreviewContract({
        ...metadata,
        previewKeys: previousKeys,
        dimensions: {
            640: metadata.dimensions['640'],
            1280: metadata.dimensions['1280'],
        },
    }, keys), true)
    for (const value of [
        null,
        { ...metadata, previewKeys: previousKeys, status: 'pending' },
        { ...metadata, previewKeys: previousKeys, previewVersion: 1 },
        { ...metadata, previewKeys: { ...previousKeys, 480: keys['480'] } },
        { ...metadata, previewKeys: { ...previousKeys, 640: 'wrong' } },
    ]) {
        assert.equal(isPreviousPreviewContract(value, keys), false)
    }
})

test('non-ready rows require neither validation nor a pending repair', async () => {
    const accepted = await validateReadyOrMarkPending({
        metadata: { ...metadata, status: 'pending' },
        expectedKeys: keys,
        validateObject: async () => assert.fail('must not validate pending metadata'),
        tagObject: async () => assert.fail('must not tag pending metadata'),
        visibility: 'private',
        markPending: async () => assert.fail('must not repair pending metadata'),
    })
    assert.equal(accepted, false)
})

test('a tagging failure repairs metadata and a repair failure remains visible', async () => {
    const actions = []
    const accepted = await validateReadyOrMarkPending({
        metadata,
        expectedKeys: keys,
        validateObject: async () => actions.push('validated'),
        tagObject: async () => { throw new Error('tag failed') },
        visibility: 'public',
        markPending: async () => actions.push('pending'),
    })
    assert.equal(accepted, false)
    assert.deepEqual(actions, ['validated', 'pending'])

    await assert.rejects(validateReadyOrMarkPending({
        metadata,
        expectedKeys: keys,
        validateObject: async () => { throw new Error('missing') },
        tagObject: async () => {},
        visibility: 'public',
        markPending: async () => { throw new Error('repair failed') },
    }), /repair failed/)
})
