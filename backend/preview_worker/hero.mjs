const VERSION_PATTERN = /^[a-f0-9]{32}$/

export const HERO_TYPES = Object.freeze(['photo', 'video'])
const HERO_PATHS = Object.freeze({
    photo: Object.freeze({
        pending: 'temp-zips/hero-pending',
        home: 'site/hero/home',
        original: 'site/hero/original',
        manifest: 'site/hero/manifest.json',
        versions: 'site/hero/versions/v1',
        current: 'site/hero/current',
    }),
    video: Object.freeze({
        pending: 'temp-zips/video-hero-pending',
        home: 'site/hero/video/home',
        original: 'site/hero/video/original',
        manifest: 'site/hero/video/manifest.json',
        versions: 'site/hero/versions/video/v1',
        current: 'site/hero/video/current',
    }),
})

export const HERO_DERIVATIVE_VERSION = 1
export const HERO_WIDTHS = Object.freeze([640, 960, 1280, 1920, 2560])
export const HERO_FORMATS = Object.freeze(['avif', 'webp', 'jpeg'])
export const HERO_CURRENT_PREFIX = 'site/hero/current'
export const HERO_CONTENT_TYPES = Object.freeze({
    avif: 'image/avif',
    webp: 'image/webp',
    jpeg: 'image/jpeg',
})

export function heroPaths(heroType = 'photo') {
    if (!HERO_TYPES.includes(heroType)) throw new Error('Invalid hero type')
    return HERO_PATHS[heroType]
}

export function parseHeroJob(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'hero') {
        throw new Error('Invalid hero derivative job')
    }
    const heroType = String(value.heroType || 'photo').trim().toLowerCase()
    const paths = heroPaths(heroType)
    const version = String(value.version || '').trim().toLowerCase()
    const sourceKey = String(value.sourceKey || '').trim()
    if (!VERSION_PATTERN.test(version)) throw new Error('Invalid hero derivative version')
    if (![paths.pending, paths.home, paths.original].includes(sourceKey)) throw new Error('Invalid hero source key')
    return { kind: 'hero', heroType, version, sourceKey }
}

export function heroWidthsFor(sourceWidth) {
    if (!Number.isSafeInteger(sourceWidth) || sourceWidth < 1 || sourceWidth > 100_000) {
        throw new Error('Invalid hero source width')
    }
    const maximum = Math.min(sourceWidth, HERO_WIDTHS.at(-1))
    return [...new Set([
        ...HERO_WIDTHS.filter((width) => width < maximum),
        maximum,
    ])]
}

export function heroDerivativeKey(version, width, format, heroType = 'photo') {
    const paths = heroPaths(heroType)
    const parsed = parseHeroJob({ kind: 'hero', heroType, sourceKey: paths.pending, version })
    if (!Number.isSafeInteger(width) || width < 1 || width > HERO_WIDTHS.at(-1)) {
        throw new Error('Invalid hero derivative width')
    }
    if (!HERO_FORMATS.includes(format)) throw new Error('Invalid hero derivative format')
    const extension = format === 'jpeg' ? 'jpg' : format
    return `${paths.versions}/${parsed.version}/hero-${width}.${extension}`
}

export function heroCurrentKey(width, format, heroType = 'photo') {
    if (!Number.isSafeInteger(width) || width < 1 || width > HERO_WIDTHS.at(-1)) {
        throw new Error('Invalid current hero width')
    }
    if (!HERO_FORMATS.includes(format)) throw new Error('Invalid current hero format')
    const extension = format === 'jpeg' ? 'jpg' : format
    return `${heroPaths(heroType).current}/hero-${width}.${extension}`
}

export function heroCurrentFallbackKey(format = 'jpeg', heroType = 'photo') {
    if (!HERO_FORMATS.includes(format)) throw new Error('Invalid current hero format')
    const extension = format === 'jpeg' ? 'jpg' : format
    return `${heroPaths(heroType).current}/hero.${extension}`
}

export function heroOutputFormatMatches(requestedFormat, detectedFormat) {
    if (!HERO_FORMATS.includes(requestedFormat) || typeof detectedFormat !== 'string') return false
    return detectedFormat === (requestedFormat === 'avif' ? 'heif' : requestedFormat)
}

export function buildHeroManifest({ version, sourceWidth, sourceHeight, outputs, heroType = 'photo' }) {
    const paths = heroPaths(heroType)
    parseHeroJob({ kind: 'hero', heroType, sourceKey: paths.pending, version })
    if (!Number.isSafeInteger(sourceWidth) || sourceWidth < 1 || !Number.isSafeInteger(sourceHeight) || sourceHeight < 1) {
        throw new Error('Invalid hero source dimensions')
    }
    const variants = Object.fromEntries(HERO_FORMATS.map((format) => [format, []]))
    for (const output of outputs || []) {
        if (!output || !HERO_FORMATS.includes(output.format)) throw new Error('Invalid hero output')
        if (!Number.isSafeInteger(output.width) || output.width < 1 || !Number.isSafeInteger(output.height) || output.height < 1) {
            throw new Error('Invalid hero output dimensions')
        }
        const expectedKey = heroDerivativeKey(version, output.width, output.format, heroType)
        if (output.key !== expectedKey) throw new Error('Invalid hero output key')
        variants[output.format].push({
            width: output.width,
            height: output.height,
            key: output.key,
        })
    }
    const expectedWidths = heroWidthsFor(sourceWidth)
    for (const format of HERO_FORMATS) {
        variants[format].sort((left, right) => left.width - right.width)
        if (
            variants[format].length !== expectedWidths.length
            || variants[format].some((item, index) => item.width !== expectedWidths[index])
        ) {
            throw new Error('Incomplete hero derivative set')
        }
    }
    return {
        schemaVersion: HERO_DERIVATIVE_VERSION,
        version,
        source: { width: sourceWidth, height: sourceHeight },
        variants,
        fallbackKey: variants.jpeg.at(-1).key,
    }
}
