import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'

import {
    HERO_DERIVATIVE_VERSION,
    HERO_FORMATS,
    buildHeroManifest,
    heroCurrentFallbackKey,
    heroCurrentKey,
    heroDerivativeKey,
    heroOutputFormatMatches,
    heroWidthsFor,
    parseHeroJob,
    prepareHeroSource,
    generateHeroOutput,
    mapHeroTasks,
} from './hero.mjs'

const version = '0123456789abcdef0123456789abcdef'

test('decodes and orients once, then renders all formats without enlarging the source', async () => {
    const bytes = await sharp({ create: { width: 60, height: 90, channels: 3, background: 'red' } })
        .withMetadata({ orientation: 6 }).jpeg().toBuffer()
    const source = await prepareHeroSource(bytes, 'image/jpeg')
    assert.equal(source.raw.width, 90)
    assert.equal(source.raw.height, 60)
    for (const format of HERO_FORMATS) {
        const output = await generateHeroOutput(source, 45, format, 1024 * 1024)
        assert.equal(output.width, 45)
        assert.equal(output.height, 30)
        assert.equal(heroOutputFormatMatches(format, (await sharp(output.bytes).metadata()).format), true)
    }
    await assert.rejects(generateHeroOutput(source, 100, 'jpeg', 1024 * 1024), /failed validation/)
    await assert.rejects(generateHeroOutput(source, 45, 'jpeg', 1), /size is invalid/)
    await assert.rejects(generateHeroOutput(source, 45, 'gif', 1024 * 1024), /format/)
})

test('accepts real AVIF inputs as well as JPEG, PNG and WebP, while rejecting other formats', async () => {
    for (const format of [...HERO_FORMATS, 'png']) {
        const image = sharp({ create: { width: 12, height: 8, channels: 3, background: 'blue' } })
        const bytes = await image.toFormat(format).toBuffer()
        assert.equal((await prepareHeroSource(bytes, `image/${format}`)).raw.width, 12)
        await assert.rejects(prepareHeroSource(bytes, 'text/html'), /Unsupported/)
    }
    const gif = await sharp({ create: { width: 12, height: 8, channels: 3, background: 'blue' } }).gif().toBuffer()
    await assert.rejects(prepareHeroSource(gif), /Unsupported/)
})

test('bounds concurrent hero tasks and drains running work before returning a failure', async () => {
    let running = 0
    let maximum = 0
    const result = await mapHeroTasks([1, 2, 3, 4, 5], async (value) => {
        maximum = Math.max(maximum, ++running)
        await new Promise((resolve) => setImmediate(resolve))
        running--
        return value * 2
    })
    assert.deepEqual(result, [2, 4, 6, 8, 10])
    assert.equal(maximum, 2)
    let drained = false
    await assert.rejects(mapHeroTasks([1, 2, 3], async (value) => {
        if (value === 1) throw new Error('failed')
        await new Promise((resolve) => setImmediate(resolve))
        drained = true
    }), /failed/)
    assert.equal(drained, true)
})

test('accepts only fixed hero sources and opaque version identifiers', () => {
    assert.deepEqual(parseHeroJob({ kind: 'hero', sourceKey: 'temp-zips/hero-pending', version }), {
        kind: 'hero',
        heroType: 'photo',
        sourceKey: 'temp-zips/hero-pending',
        version,
    })
    assert.equal(parseHeroJob({ kind: 'hero', sourceKey: 'site/hero/home', version }).sourceKey, 'site/hero/home')
    assert.deepEqual(parseHeroJob({
        kind: 'hero',
        heroType: 'video',
        sourceKey: 'temp-zips/video-hero-pending',
        version,
    }), {
        kind: 'hero',
        heroType: 'video',
        sourceKey: 'temp-zips/video-hero-pending',
        version,
    })
    for (const value of [
        null,
        [],
        { kind: 'preview', sourceKey: 'temp-zips/hero-pending', version },
        { kind: 'hero', sourceKey: '../secret', version },
        { kind: 'hero', heroType: 'video', sourceKey: 'temp-zips/hero-pending', version },
        { kind: 'hero', heroType: 'unknown', sourceKey: 'temp-zips/hero-pending', version },
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
    assert.equal(heroCurrentKey(960, 'avif'), 'site/hero/current/hero-960.avif')
    assert.equal(heroCurrentFallbackKey('jpeg'), 'site/hero/current/hero.jpg')
    assert.equal(
        heroDerivativeKey(version, 1280, 'webp', 'video'),
        `site/hero/versions/video/v${HERO_DERIVATIVE_VERSION}/${version}/hero-1280.webp`,
    )
    assert.equal(heroCurrentKey(960, 'avif', 'video'), 'site/hero/video/current/hero-960.avif')
    assert.equal(heroCurrentFallbackKey('jpeg', 'video'), 'site/hero/video/current/hero.jpg')
    assert.throws(() => heroWidthsFor(0), /source width/)
    assert.throws(() => heroDerivativeKey(version, 640, 'gif'), /format/)
    assert.throws(() => heroCurrentKey(0, 'avif'), /current hero width/)
    assert.throws(() => heroCurrentFallbackKey('gif'), /current hero format/)
    assert.equal(heroOutputFormatMatches('avif', 'heif'), true)
    assert.equal(heroOutputFormatMatches('webp', 'webp'), true)
    assert.equal(heroOutputFormatMatches('jpeg', 'jpeg'), true)
    assert.equal(heroOutputFormatMatches('avif', 'avif'), false)
    assert.equal(heroOutputFormatMatches('gif', 'gif'), false)
})

test('builds video hero manifests in the isolated video namespace', () => {
    const widths = heroWidthsFor(1280)
    const outputs = HERO_FORMATS.flatMap((format) => widths.map((width) => ({
        format,
        width,
        height: Math.round(width * 0.6),
        key: heroDerivativeKey(version, width, format, 'video'),
    })))
    const manifest = buildHeroManifest({
        version,
        sourceWidth: 1280,
        sourceHeight: 768,
        outputs,
        heroType: 'video',
    })
    assert.equal(manifest.fallbackKey, `site/hero/versions/video/v1/${version}/hero-1280.jpg`)
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
