import { cdnDomain, cdnUrl, PREVIEW_VERSION, PREVIEW_WIDTHS } from './mediaUrls'

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


const ALBUM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const coverPreviewSets = new Map()
const MAX_COVER_PREVIEW_SETS = 256

export async function albumCoverPreviewSrcSet(album) {
    const albumId = typeof album?.albumId === 'string' ? album.albumId.toLowerCase() : ''
    if (!ALBUM_ID_PATTERN.test(albumId) || !globalThis.crypto?.subtle) return ''
    const cover = album?.coverImageUrl
    if (typeof cover !== 'string' || !cover.startsWith('https://')) return ''
    let rawKey
    try {
        const parsed = new URL(cover)
        if (cdnDomain && parsed.hostname !== cdnDomain) return ''
        rawKey = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    } catch {
        return ''
    }
    if (!rawKey.startsWith('albums/') || rawKey.includes('\\') || rawKey.split('/').some((part) => !part || part === '.' || part === '..')) return ''
    const key = `${albumId}\n${cover}`
    let result = coverPreviewSets.get(key)
    if (result) coverPreviewSets.delete(key)
    else {
        result = globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey)).then(digest => {
            const mediaId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24)
            return PREVIEW_WIDTHS
                .map((width) => `${cdnUrl(`public-previews/${albumId}/v${PREVIEW_VERSION}/${mediaId}-w${width}.webp`)} ${width}w`)
                .join(', ')
        }).catch(error => {
            if (coverPreviewSets.get(key) === result) coverPreviewSets.delete(key)
            throw error
        })
    }
    coverPreviewSets.set(key, result)
    if (coverPreviewSets.size > MAX_COVER_PREVIEW_SETS) coverPreviewSets.delete(coverPreviewSets.keys().next().value)
    return result
}

