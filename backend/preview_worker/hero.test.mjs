import assert from 'node:assert/strict'
import test from 'node:test'

import {
    HERO_DERIVATIVE_VERSION,
    HERO_FORMATS,
    buildHeroManifest,
    heroDerivativeKey,
    heroWidthsFor,
    parseHeroJob,
} from './hero.mjs'

const version = '0123456789abcdef0123456789abcdef'

test('accepts only fixed hero sources and opaque version identifiers', () => {
    assert.deepEqual(parseHeroJob({ kind: 'hero', sourceKey: 'temp-zips/hero-pending', version }), {
        kind: 'hero',
        sourceKey: 'temp-zips/hero-pending',
        version,
    })
    assert.equal(parseHeroJob({ kind: 'hero', sourceKey: 'site/hero/home', version }).sourceKey, 'site/hero/home')
    for (const value of [
        null,
        [],
        { kind: 'preview', sourceKey: 'temp-zips/hero-pending', version },
        { kind: 'hero', sourceKey: '../secret', version },
        { kind: 'hero', sourceKey: 'temp-zips/hero-pending', version: 'unsafe/path' },
    ]) {
        assert.throws(() => parseHeroJob(value), /Invalid hero/)
    }
})

test('uses bounded no-upscale widths and deterministic immutable keys', () => {
    assert.deepEqual(heroWidthsFor(6960), [640, 960, 1280, 1920, 2560])
    assert.deepEqual(heroWidthsFor(1500), [640, 960, 1280, 1500])
    assert.deepEqual(heroWidthsFor(500), [500])
    assert.equal(
        heroDerivativeKey(version, 1280, 'webp'),
        `site/hero/versions/v${HERO_DERIVATIVE_VERSION}/${version}/hero-1280.webp`,
    )
    assert.throws(() => heroWidthsFor(0), /source width/)
    assert.throws(() => heroDerivativeKey(version, 640, 'gif'), /format/)
})

test('builds a complete responsive manifest and rejects partial output', () => {
    const widths = heroWidthsFor(1920)
    const outputs = HERO_FORMATS.flatMap((format) => widths.map((width) => ({
        format,
        width,
        height: Math.round(width * 0.6),
        key: heroDerivativeKey(version, width, format),
    })))
    const manifest = buildHeroManifest({
        version,
        sourceWidth: 1920,
        sourceHeight: 1152,
        outputs,
    })
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.variants.avif.length, 4)
    assert.equal(manifest.fallbackKey.endsWith('/hero-1920.jpg'), true)
    assert.throws(() => buildHeroManifest({
        version,
        sourceWidth: 1920,
        sourceHeight: 1152,
        outputs: outputs.slice(1),
    }), /Incomplete/)
})
