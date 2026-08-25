import assert from 'node:assert/strict'
import test from 'node:test'

import {
    EXPLORE_VERSION,
    MANUAL_LENS_FALLBACK,
    analyzePixels,
    isCompleteExploreMetadata,
    lensKey,
    normalizeLens,
} from './explore.mjs'

function pixels(colors) {
    return Uint8Array.from(colors.flat())
}

test('normalizes stored lenses and applies the manual-lens fallback', () => {
    assert.equal(normalizeLens('  Sigma   18-50mm F2.8  '), 'Sigma 18-50mm F2.8')
    assert.equal(normalizeLens(''), MANUAL_LENS_FALLBACK)
    assert.equal(lensKey('SIGMA 18-50MM'), 'sigma 18-50mm')
})

test('extracts a deterministic palette and multiple prominent color families', () => {
    const sample = pixels([
        ...Array.from({ length: 12 }, () => [20, 80, 220]),
        ...Array.from({ length: 8 }, () => [25, 165, 70]),
        ...Array.from({ length: 4 }, () => [230, 120, 25]),
    ])
    const result = analyzePixels(sample)
    assert.equal(result.palette.length, 3)
    assert.deepEqual(result.colorFamilies, ['blue', 'green', 'orange'])
    assert.match(result.palette[0], /^#[0-9a-f]{6}$/)
})

test('does not classify a small warm accent as an orange photograph', () => {
    const sample = pixels([
        ...Array.from({ length: 18 }, () => [30, 92, 185]),
        ...Array.from({ length: 10 }, () => [112, 116, 121]),
        ...Array.from({ length: 2 }, () => [226, 112, 30]),
    ])
    const result = analyzePixels(sample)
    assert.ok(result.colorFamilies.includes('blue'))
    assert.ok(!result.colorFamilies.includes('orange'))
})

test('keeps orange when it occupies a meaningful part of the photograph', () => {
    const sample = pixels([
        ...Array.from({ length: 16 }, () => [32, 88, 182]),
        ...Array.from({ length: 8 }, () => [226, 112, 30]),
    ])
    const result = analyzePixels(sample)
    assert.ok(result.colorFamilies.includes('orange'))
})

test('uses the strongest hue instead of monochrome for a broadly colorful photograph', () => {
    const result = analyzePixels(pixels([
        ...Array.from({ length: 4 }, () => [225, 50, 40]),
        ...Array.from({ length: 4 }, () => [230, 135, 35]),
        ...Array.from({ length: 4 }, () => [210, 205, 35]),
        ...Array.from({ length: 4 }, () => [45, 175, 75]),
        ...Array.from({ length: 4 }, () => [35, 165, 175]),
        ...Array.from({ length: 4 }, () => [45, 90, 205]),
        ...Array.from({ length: 4 }, () => [135, 70, 190]),
        ...Array.from({ length: 4 }, () => [205, 85, 145]),
    ]))
    assert.ok(!result.colorFamilies.includes('monochrome'))
    assert.ok(result.colorFamilies.length >= 1)
})

test('caps diverse palettes after the distance pass already selects five colors', () => {
    const sample = pixels([
        [240, 20, 20],
        [20, 240, 20],
        [20, 20, 240],
        [240, 240, 20],
        [240, 20, 240],
        [20, 240, 240],
        [140, 70, 20],
        [70, 20, 140],
    ])
    const result = analyzePixels(sample)
    assert.equal(result.palette.length, 5)
    assert.equal(new Set(result.palette).size, 5)
})

test('classifies neutral photographs as monochrome and validates complete metadata', () => {
    const result = analyzePixels(pixels([
        ...Array.from({ length: 12 }, () => [40, 40, 40]),
        ...Array.from({ length: 12 }, () => [210, 210, 210]),
    ]))
    assert.deepEqual(result.colorFamilies, ['monochrome'])
    const metadata = {
        exploreVersion: EXPLORE_VERSION,
        ...result,
        lens: MANUAL_LENS_FALLBACK,
        lensKey: lensKey(MANUAL_LENS_FALLBACK),
    }
    assert.equal(isCompleteExploreMetadata(metadata), true)
    assert.equal(isCompleteExploreMetadata({ ...metadata, palette: ['invalid'] }), false)
})

test('rejects malformed pixel buffers', () => {
    assert.throws(() => analyzePixels(new Uint8Array()), /invalid/)
    assert.throws(() => analyzePixels(new Uint8Array([1, 2, 3]), 2), /invalid/)
})
