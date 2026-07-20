const cdnDomain = import.meta.env.VITE_CLOUDFRONT_DOMAIN

const DISPLAY_URL_FIELDS = [
    'url',
    'thumbnailUrl',
    'hlsUrl',
    'coverImageUrl',
    'coverThumbnailUrl',
]

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
    if (Number.isFinite(numericExpiry) && numericExpiry > 0) {
        return numericExpiry < 1_000_000_000_000 ? numericExpiry * 1000 : numericExpiry
    }
    const datedExpiry = typeof explicitValue === 'string' ? Date.parse(explicitValue) : Number.NaN
    if (Number.isFinite(datedExpiry) && datedExpiry > 0) return datedExpiry

    const expiries = DISPLAY_URL_FIELDS
        .map((field) => signedUrlExpiresAt(media[field]))
        .filter(Number.isFinite)
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
