import { cdnUrl } from './mediaUrls'

const HERO_VERSION_PATTERN = /^[a-f0-9]{32}$/

export function normalizeHeroManifest(value, heroType = 'photo') {
    if (!['photo', 'video'].includes(heroType)) return null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const version = typeof value.version === 'string' ? value.version.toLowerCase() : ''
    if (value.schemaVersion !== 1 || !HERO_VERSION_PATTERN.test(version)) return null
    const sourceWidth = Number(value.source?.width)
    const sourceHeight = Number(value.source?.height)
    if (!Number.isSafeInteger(sourceWidth) || sourceWidth < 1 || !Number.isSafeInteger(sourceHeight) || sourceHeight < 1) return null

    const formats = { avif: '.avif', webp: '.webp', jpeg: '.jpg' }
    const variants = {}
    try {
        for (const [format, extension] of Object.entries(formats)) {
            const candidates = value.variants?.[format]
            if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 5) return null
            let previousWidth = 0
            variants[format] = candidates.map((candidate) => {
                const width = Number(candidate?.width)
                const height = Number(candidate?.height)
                const key = candidate?.key
                const expectedPrefix = `site/hero/versions/${heroType === 'video' ? 'video/' : ''}v1/${version}/hero-`
                if (
                    !Number.isSafeInteger(width)
                    || width <= previousWidth
                    || width > 2560
                    || !Number.isSafeInteger(height)
                    || height < 1
                    || typeof key !== 'string'
                    || !key.startsWith(expectedPrefix)
                    || !key.endsWith(extension)
                    || key !== `${expectedPrefix}${width}${extension}`
                ) throw new TypeError('Invalid hero manifest')
                previousWidth = width
                return { width, height, url: cdnUrl(key) }
            })
            if (variants[format].some(({ url }) => !url)) return null
        }
    } catch {
        return null
    }
    return {
        version,
        source: { width: sourceWidth, height: sourceHeight },
        variants,
    }
}

