import assert from 'node:assert/strict'
import test from 'node:test'

import {
    PREVIEW_QUALITY,
    PREVIEW_VERSION,
    PREVIEW_WIDTHS,
    PREVIEW_FAILURE_REASON_CODES,
    isCompletePreview,
    mediaIdForKey,
    normalizeAlbumId,
    normalizeObjectKey,
    parseJob,
    parsePositiveLimit,
    previousPreviewKeysFor,
    previewJobId,
    previewKeysFor,
    resolveManifestImage,
    safePreviewFailureReason,
} from './contract.mjs'

const albumId = '11111111-1111-4111-8111-111111111111'
const rawKey = `albums/${albumId}/original/photo.jpg`

test('derives deterministic versioned keys', () => {
    const mediaId = mediaIdForKey(rawKey)
    assert.equal(mediaId.length, 24)
    assert.deepEqual(previewKeysFor(albumId, rawKey), {
        640: `albums/${albumId}/preview/v3/${mediaId}-w640.webp`,
        960: `albums/${albumId}/preview/v3/${mediaId}-w960.webp`,
        1440: `albums/${albumId}/preview/v3/${mediaId}-w1440.webp`,
        1920: `albums/${albumId}/preview/v3/${mediaId}-w1920.webp`,
    })
    assert.deepEqual(PREVIEW_WIDTHS, [640, 960, 1440, 1920])
    assert.equal(PREVIEW_QUALITY, 84)
    assert.deepEqual(previousPreviewKeysFor(albumId, rawKey), {
        480: `albums/${albumId}/preview/v2/${mediaId}-w480.webp`,
        640: `albums/${albumId}/preview/v2/${mediaId}-w640.webp`,
        1280: `albums/${albumId}/preview/v2/${mediaId}-w1280.webp`,
    })
    assert.equal(previewJobId({ albumId, rawKey, previewVersion: 3 }), previewJobId({ albumId, rawKey, previewVersion: 3 }))
})

test('rejects malformed, cross-album, and obsolete jobs', () => {
    assert.throws(() => parseJob({ albumId, rawKey, previewVersion: 1 }), /Unsupported/)
    assert.throws(() => parseJob({ albumId, rawKey: '../secret', previewVersion: 3 }), /Invalid/)
    assert.throws(() => resolveManifestImage({
        albumId,
        type: 'photo',
        status: 'active',
        visibility: 'public',
        images: [{ rawKey: 'albums/another/photo.jpg' }],
    }, { albumId, rawKey: 'albums/another/photo.jpg', previewVersion: 3 }), /namespace/)
})

test('normalizes identifiers and rejects unsafe object-key shapes', () => {
    assert.equal(normalizeAlbumId(`  ${albumId.toUpperCase()}  `), albumId)
    for (const value of [undefined, null, 12, '', 'not-a-uuid']) {
        assert.throws(() => normalizeAlbumId(value), /Invalid albumId/)
    }

    assert.equal(normalizeObjectKey(rawKey), rawKey)
    for (const value of [
        undefined,
        '',
        12,
        ' albums/photo.jpg',
        'a'.repeat(1025),
        '/albums/photo.jpg',
        'albums\\photo.jpg',
        'albums/photo.jpg\0suffix',
        'albums//photo.jpg',
        'albums/./photo.jpg',
        'albums/../photo.jpg',
    ]) {
        assert.throws(() => normalizeObjectKey(value), /Invalid media key/)
    }
})

test('parses only object jobs for preview v3', () => {
    assert.deepEqual(parseJob({
        albumId: albumId.toUpperCase(),
        rawKey,
        previewVersion: '3',
        ignored: 'field',
    }), { albumId, rawKey, previewVersion: 3 })
    for (const value of [null, [], 'job']) {
        assert.throws(() => parseJob(value), /Invalid preview job/)
    }
})

test('resolves only an active photo manifest entry and detects completion', () => {
    const album = {
        albumId,
        type: 'photo',
        status: 'active',
        visibility: 'private',
        images: [{ rawKey }],
    }
    const resolved = resolveManifestImage(album, { albumId, rawKey, previewVersion: PREVIEW_VERSION })
    assert.equal(resolved.index, 0)
    assert.equal(resolved.visibility, 'private')
    assert.equal(isCompletePreview({
        previewVersion: 3,
        previewKeys: resolved.previewKeys,
    }, resolved.previewKeys), true)
    assert.equal(isCompletePreview({
        previewVersion: 3,
        previewKeys: { 640: resolved.previewKeys['640'] },
    }, resolved.previewKeys), false)
})

test('supports a separately approved single-segment legacy prefix', () => {
    const legacyRaw = 'albums/summer-portraits-a1b2c3d4/original/photo.jpg'
    const resolved = resolveManifestImage({
        albumId,
        legacyS3Prefix: 'albums/summer-portraits-a1b2c3d4/',
        visibility: 'unlisted',
        images: [{ rawKey: legacyRaw }],
    }, { albumId, rawKey: legacyRaw, previewVersion: 3 })
    assert.equal(resolved.previewKeys['640'].startsWith(`albums/${albumId}/preview/v3/`), true)
})

test('rejects inactive, non-photo, malformed, and stale manifest entries', () => {
    const job = { albumId, rawKey, previewVersion: 3 }
    const base = { albumId, visibility: 'public', images: [{ rawKey }] }
    const cases = [
        [null, /does not match album/],
        [{ ...base, albumId: '22222222-2222-4222-8222-222222222222' }, /does not match album/],
        [{ ...base, status: 'archived' }, /not active/],
        [{ ...base, type: 'video' }, /not a photo album/],
        [{ ...base, visibility: 'pending' }, /visibility is invalid/],
        [{ ...base, images: null }, /manifest is invalid/],
        [{ ...base, images: [null, 'bad', { rawKey: `${rawKey}.other` }] }, /no longer/],
    ]
    for (const [album, pattern] of cases) {
        assert.throws(() => resolveManifestImage(album, job), pattern)
    }
})

test('detects incomplete preview shapes and parses bounded limits', () => {
    const expectedKeys = previewKeysFor(albumId, rawKey)
    for (const image of [
        null,
        { previewVersion: 1, previewKeys: expectedKeys },
        { previewVersion: 3 },
        { previewVersion: 3, previewKeys: 'not-an-object' },
        { previewVersion: 3, previewKeys: { ...expectedKeys, 1920: 'wrong' } },
    ]) {
        assert.equal(isCompletePreview(image, expectedKeys), false)
    }
    assert.equal(parsePositiveLimit('1280', 640, 4096), 1280)
    for (const value of [undefined, 'invalid', 0, -1, 1.5, 4097]) {
        assert.equal(parsePositiveLimit(value, 640, 4096), 640)
    }
})

test('failure telemetry permits only fixed privacy-safe reason codes', () => {
    assert.equal(new Set(PREVIEW_FAILURE_REASON_CODES).size, PREVIEW_FAILURE_REASON_CODES.length)
    for (const reasonCode of PREVIEW_FAILURE_REASON_CODES) {
        assert.match(reasonCode, /^[a-z][a-z_]+$/)
        assert.equal(safePreviewFailureReason({ reasonCode }), reasonCode)
    }
    assert.equal(safePreviewFailureReason({ reasonCode: 'albums/private/client-name.jpg' }), 'unexpected_failure')
    assert.equal(safePreviewFailureReason(new Error('albums/private/client-name.jpg')), 'unexpected_failure')
    assert.equal(safePreviewFailureReason(null), 'unexpected_failure')
})
