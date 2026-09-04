const cdnDomain = import.meta.env.VITE_CLOUDFRONT_DOMAIN

const DISPLAY_URL_FIELDS = [
    'url',
    'thumbnailUrl',
    'hlsUrl',
    'coverImageUrl',
    'coverThumbnailUrl',
]

const PREVIEW_VERSION = 3
const PREVIEW_WIDTHS = [640, 960, 1440, 1920]
export const HERO_COVER_KEY = 'site/hero/home'
export const HERO_MANIFEST_KEY = 'site/hero/manifest.json'
export const HERO_CURRENT_PREFIX = 'site/hero/current'
export const HERO_CURRENT_WIDTHS = Object.freeze([640, 960, 1280, 1920, 2560])
const HERO_VERSION_PATTERN = /^[a-f0-9]{32}$/
const ALBUM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function safePreviewUrl(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\s,]/.test(value)) return ''
    try {
        const parsed = new URL(value)
        return parsed.protocol === 'https:' ? value : ''
    } catch {
        return ''
    }
}

export function mediaPreviewCandidates(media) {
    if (!media || typeof media !== 'object' || !Array.isArray(media.previewSrcSet)) return []
    if (media.previewSrcSet.length !== PREVIEW_WIDTHS.length) return []

    const candidates = media.previewSrcSet
        .map((candidate) => ({
            width: Number(candidate?.width),
            url: safePreviewUrl(candidate?.url),
        }))
        .sort((left, right) => left.width - right.width)

    const complete = candidates.every((candidate, index) => (
        candidate.width === PREVIEW_WIDTHS[index] && candidate.url
    ))
    return complete ? candidates : []
}

export function mediaPreviewSrcSet(media) {
    const candidates = mediaPreviewCandidates(media)
    return candidates.length === PREVIEW_WIDTHS.length
        ? candidates.map(({ width, url }) => `${url} ${width}w`).join(', ')
        : ''
}

export function uploadOriginalFilename(value) {
    if (typeof value !== 'string') return ''
    const filename = Array.from(value.replace(/\\/g, '/').split('/').pop())
        .filter((character) => {
            const code = character.codePointAt(0)
            return code > 31 && (code < 127 || code > 159)
        }).join('').trim().slice(0, 255)
    return filename === '.' || filename === '..' ? '' : filename
}

export function mediaBeforeCandidates(media) {
    const before = media?.before
    if (before?.status !== 'ready' || !Array.isArray(before.srcSet) || before.srcSet.length > 4) return []
    const candidates = before.srcSet.map((candidate) => ({
        width: Number(candidate?.width),
        url: safePreviewUrl(candidate?.url),
    })).sort((left, right) => left.width - right.width)
    return candidates.every(({ width, url }, index) => (
        Number.isSafeInteger(width) && width > 0 && width <= 1920 && url
        && (index === 0 || width > candidates[index - 1].width)
    )) ? candidates : []
}

export function mediaBeforeSrcSet(media) {
    return mediaBeforeCandidates(media).map(({ width, url }) => `${url} ${width}w`).join(', ')
}

export function mediaBeforeDisplayUrl(media) {
    return media?.before?.status === 'ready' ? safePreviewUrl(media.before.url) : ''
}

function parseAwsDate(value) {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value || '')
    if (!match) return null
    const [, year, month, day, hour, minute, second] = match
    const timestamp = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
    )
    return Number.isFinite(timestamp) ? timestamp : null
}

export function signedUrlExpiresAt(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null
    try {
        const url = new URL(value)
        const issuedAt = parseAwsDate(url.searchParams.get('X-Amz-Date') || url.searchParams.get('x-amz-date'))
        const expiresIn = Number(url.searchParams.get('X-Amz-Expires') || url.searchParams.get('x-amz-expires'))
        if (!issuedAt || !Number.isFinite(expiresIn) || expiresIn <= 0) return null
        return issuedAt + (expiresIn * 1000)
    } catch {
        return null
    }
}

export function mediaExpiresAt(media) {
    if (typeof media === 'string') return signedUrlExpiresAt(media)
    if (!media || typeof media !== 'object') return null

    const explicitValue = media.mediaExpiresAt || media.expiresAt
    const numericExpiry = Number(explicitValue)
    let explicitExpiry = null
    if (Number.isFinite(numericExpiry) && numericExpiry > 0) {
        explicitExpiry = numericExpiry < 1_000_000_000_000 ? numericExpiry * 1000 : numericExpiry
    }
    const datedExpiry = typeof explicitValue === 'string' ? Date.parse(explicitValue) : Number.NaN
    if (Number.isFinite(datedExpiry) && datedExpiry > 0) explicitExpiry = datedExpiry

    const candidateUrls = mediaPreviewCandidates(media).map(({ url }) => url)
    const expiries = [...DISPLAY_URL_FIELDS.map((field) => media[field]), ...candidateUrls]
        .map(signedUrlExpiresAt)
        .filter(Number.isFinite)
    if (explicitExpiry) expiries.push(explicitExpiry)
    if (media.before?.status === 'ready') {
        const beforeExpiry = mediaExpiresAt({
            url: mediaBeforeDisplayUrl(media),
            expiresAt: media.before.expiresAt,
        })
        if (beforeExpiry) expiries.push(beforeExpiry)
        expiries.push(...mediaBeforeCandidates(media).map(({ url }) => signedUrlExpiresAt(url)).filter(Number.isFinite))
    }
    return expiries.length > 0 ? Math.min(...expiries) : null
}

export function annotateMediaExpiry(media) {
    if (!media || typeof media !== 'object') return media
    const expiry = mediaExpiresAt(media)
    if (!expiry || media.mediaExpiresAt === expiry) return media
    return { ...media, mediaExpiresAt: expiry }
}

export function cdnUrl(key) {
    if (!key) return ''
    if (/^https?:\/\//i.test(key)) return key
    return cdnDomain ? `https://${cdnDomain}/${String(key).replace(/^\/+/, '')}` : ''
}

export function heroCoverUrl() {
    return cdnUrl(HERO_COVER_KEY)
}

export function currentHeroUrl(format = 'jpeg') {
    const extension = format === 'jpeg' ? 'jpg' : format
    if (!['avif', 'webp', 'jpg'].includes(extension)) return ''
    return cdnUrl(`${HERO_CURRENT_PREFIX}/hero.${extension}`)
}

export function currentHeroSrcSet(format = 'jpeg') {
    const extension = format === 'jpeg' ? 'jpg' : format
    if (!['avif', 'webp', 'jpg'].includes(extension)) return ''
    return HERO_CURRENT_WIDTHS
        .map((width) => `${cdnUrl(`${HERO_CURRENT_PREFIX}/hero-${width}.${extension}`)} ${width}w`)
        .join(', ')
}

export function heroManifestUrl() {
    return cdnUrl(HERO_MANIFEST_KEY)
}

export function normalizeHeroManifest(value) {
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
                const expectedPrefix = `site/hero/versions/v1/${version}/hero-`
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

export async function fetchHeroManifest({ signal } = {}) {
    const url = heroManifestUrl()
    if (!url) return null
    const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-cache',
        signal,
    })
    if (!response.ok) return null
    try {
        return normalizeHeroManifest(await response.json())
    } catch {
        return null
    }
}

export function heroManifestSrcSet(manifest, format) {
    const candidates = manifest?.variants?.[format]
    return Array.isArray(candidates)
        ? candidates.map(({ width, url }) => `${url} ${width}w`).join(', ')
        : ''
}

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
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey))
    const mediaId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24)
    return PREVIEW_WIDTHS
        .map((width) => `${cdnUrl(`public-previews/${albumId}/v${PREVIEW_VERSION}/${mediaId}-w${width}.webp`)} ${width}w`)
        .join(', ')
}

export function albumCoverUrl(album) {
    return album?.coverThumbnailUrl
        || cdnUrl(album?.coverThumbKey)
        || album?.coverImageUrl
        || ''
}

export function mediaThumbnailUrl(media) {
    if (typeof media === 'string') return media
    return media?.thumbnailUrl
        || cdnUrl(media?.thumbKey)
        || media?.url
        || cdnUrl(media?.key)
        || ''
}

export function mediaDisplayUrl(media) {
    if (typeof media === 'string') return media
    return media?.url
        || cdnUrl(media?.rawKey)
        || cdnUrl(media?.key)
        || ''
}

export function mediaHlsUrl(media) {
    if (!media?.hlsUrl) return ''
    return cdnUrl(media.hlsUrl)
}

export function mediaId(media) {
    if (typeof media === 'string') return media
    return media?.id || media?.rawKey || media?.key || ''
}

export function mediaFileName(media, fallback = 'download') {
    const identifier = mediaId(media)
    try {
        const parsed = new URL(identifier)
        return parsed.pathname.split('/').filter(Boolean).pop() || fallback
    } catch {
        return String(identifier).split('/').filter(Boolean).pop() || fallback
    }
}

// Deployment bridge: remove the 404 branch after every environment exposes the
// dedicated download-url routes. Other failures must never reuse a stale URL.
export async function resolveMediaDownloadUrl(request, media) {
    try {
        const response = await request()
        const url = response?.downloadUrl || response?.url
        if (!url) throw new Error('No download URL was returned')
        return url
    } catch (error) {
        if (error?.status !== 404) throw error
        const legacyUrl = media && typeof media === 'object' && media.downloadUrl
            ? media.downloadUrl
            : mediaDisplayUrl(media)
        if (!legacyUrl) throw error
        return legacyUrl
    }
}

export function startBrowserDownload(url, fileName) {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
}
