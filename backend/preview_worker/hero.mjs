import sharp from 'sharp'

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

export async function prepareHeroSource(bytes, contentType) {
    const source = sharp(bytes, { failOn: 'warning', limitInputPixels: 100_000_000 })
    const metadata = await source.metadata()
    // Sharp identifies AVIF containers as HEIF; require AV1 to exclude HEIC.
    const supported = ['jpeg', 'png', 'webp'].includes(metadata.format)
        || (metadata.format === 'heif' && metadata.compression === 'av1')
    if (!supported || (contentType && !Object.values(HERO_CONTENT_TYPES).includes(contentType.toLowerCase()) && contentType.toLowerCase() !== 'image/png')) {
        throw new Error('Unsupported hero source image')
    }
    // Decode, orient and convert the master once, instead of repeating this
    // expensive work for all fifteen encodes. Keep the original pixels intact.
    const { data, info } = await source.rotate().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
    return { data, raw: { width: info.width, height: info.height, channels: info.channels } }
}

export async function generateHeroOutput(source, width, format, maximumBytes) {
    if (!HERO_FORMATS.includes(format)) throw new Error('Invalid hero derivative format')
    const image = sharp(source.data, { raw: source.raw }).resize({ width, withoutEnlargement: true })
    if (format === 'avif') image.avif({ quality: 74, effort: 4 })
    else if (format === 'webp') image.webp({ quality: 86, effort: 4 })
    else image.jpeg({ quality: 90, progressive: true, mozjpeg: true })
    const bytes = await image.toBuffer()
    if (bytes.length < 1 || bytes.length > maximumBytes) throw new Error('Generated hero size is invalid')
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    if (!heroOutputFormatMatches(format, metadata.format) || metadata.width !== width || !metadata.height) {
        throw new Error('Generated hero failed validation')
    }
    return { bytes, width, height: metadata.height, format }
}

export async function mapHeroTasks(items, process, concurrency = 2) {
    const results = []
    // Wait for the entire bounded batch even on failure; no uploads can keep
    // running after a failed job is handed back to SQS for retry.
    for (let index = 0; index < items.length; index += concurrency) {
        const batch = await Promise.allSettled(items.slice(index, index + concurrency).map(process))
        const failure = batch.find(({ status }) => status === 'rejected')
        if (failure) throw failure.reason
        results.push(...batch.map(({ value }) => value))
    }
    return results
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
