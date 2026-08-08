const VERSION_PATTERN = /^[a-f0-9]{32}$/
const SOURCE_KEY_PATTERN = /^(?:temp-zips\/hero-pending|site\/hero\/(?:home|original))$/

export const HERO_DERIVATIVE_VERSION = 1
export const HERO_WIDTHS = Object.freeze([640, 960, 1280, 1920, 2560])
export const HERO_FORMATS = Object.freeze(['avif', 'webp', 'jpeg'])
export const HERO_CURRENT_PREFIX = 'site/hero/current'
export const HERO_CONTENT_TYPES = Object.freeze({
    avif: 'image/avif',
    webp: 'image/webp',
    jpeg: 'image/jpeg',
})

export function parseHeroJob(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'hero') {
        throw new Error('Invalid hero derivative job')
    }
    const version = String(value.version || '').trim().toLowerCase()
    const sourceKey = String(value.sourceKey || '').trim()
    if (!VERSION_PATTERN.test(version)) throw new Error('Invalid hero derivative version')
    if (!SOURCE_KEY_PATTERN.test(sourceKey)) throw new Error('Invalid hero source key')
    return { kind: 'hero', version, sourceKey }
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

export function heroDerivativeKey(version, width, format) {
    const parsed = parseHeroJob({ kind: 'hero', sourceKey: 'temp-zips/hero-pending', version })
    if (!Number.isSafeInteger(width) || width < 1 || width > HERO_WIDTHS.at(-1)) {
        throw new Error('Invalid hero derivative width')
    }
    if (!HERO_FORMATS.includes(format)) throw new Error('Invalid hero derivative format')
    const extension = format === 'jpeg' ? 'jpg' : format
    return `site/hero/versions/v${HERO_DERIVATIVE_VERSION}/${parsed.version}/hero-${width}.${extension}`
}

export function heroCurrentKey(width, format) {
    if (!Number.isSafeInteger(width) || width < 1 || width > HERO_WIDTHS.at(-1)) {
        throw new Error('Invalid current hero width')
    }
    if (!HERO_FORMATS.includes(format)) throw new Error('Invalid current hero format')
    const extension = format === 'jpeg' ? 'jpg' : format
    return `${HERO_CURRENT_PREFIX}/hero-${width}.${extension}`
}

export function heroCurrentFallbackKey(format = 'jpeg') {
    if (!HERO_FORMATS.includes(format)) throw new Error('Invalid current hero format')
    const extension = format === 'jpeg' ? 'jpg' : format
    return `${HERO_CURRENT_PREFIX}/hero.${extension}`
}

export function heroOutputFormatMatches(requestedFormat, detectedFormat) {
    if (!HERO_FORMATS.includes(requestedFormat) || typeof detectedFormat !== 'string') return false
    return detectedFormat === (requestedFormat === 'avif' ? 'heif' : requestedFormat)
}

export function buildHeroManifest({ version, sourceWidth, sourceHeight, outputs }) {
    parseHeroJob({ kind: 'hero', sourceKey: 'temp-zips/hero-pending', version })
    if (!Number.isSafeInteger(sourceWidth) || sourceWidth < 1 || !Number.isSafeInteger(sourceHeight) || sourceHeight < 1) {
        throw new Error('Invalid hero source dimensions')
    }
    const variants = Object.fromEntries(HERO_FORMATS.map((format) => [format, []]))
    for (const output of outputs || []) {
        if (!output || !HERO_FORMATS.includes(output.format)) throw new Error('Invalid hero output')
        if (!Number.isSafeInteger(output.width) || output.width < 1 || !Number.isSafeInteger(output.height) || output.height < 1) {
            throw new Error('Invalid hero output dimensions')
        }
        const expectedKey = heroDerivativeKey(version, output.width, output.format)
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
