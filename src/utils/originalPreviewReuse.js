import { annotateMediaExpiry, mediaBeforeCandidates, mediaId, signedUrlExpiresAt } from './mediaUrls'

const REUSE_HEADROOM_MS = 60_000
const SIGNING_PARAMETERS = new Set([
    'X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires',
    'X-Amz-SignedHeaders', 'X-Amz-Signature', 'X-Amz-Security-Token',
])

function assetIdentity(value) {
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null
        const contentParameters = [...url.searchParams].filter(([key]) => !SIGNING_PARAMETERS.has(key))
        // Stable sorting preserves the order of repeated content parameters.
        contentParameters.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        return JSON.stringify([url.origin, url.pathname, contentParameters])
    } catch {
        return null
    }
}

function descriptor(media) {
    const before = media?.before
    if (before?.status !== 'ready' || !Number.isSafeInteger(before.expiresAt)) return null
    if (![before.width, before.height].every(value => Number.isSafeInteger(value) && value > 0)) return null
    const candidates = mediaBeforeCandidates(media)
    if (!candidates.length || candidates.length !== before.srcSet.length) return null
    const urls = [before.url, ...candidates.map(candidate => candidate.url)]
    const assets = urls.map(assetIdentity)
    const expiries = urls.map(signedUrlExpiresAt)
    if (assets.some(asset => !asset) || expiries.some(expiry => !Number.isFinite(expiry))) return null
    return {
        identity: JSON.stringify([before.width, before.height, assets[0], candidates.map(({ width }, index) => [width, assets[index + 1]])]),
        expiresAt: Math.min(before.expiresAt, ...expiries),
    }
}

// Keep browser cache identity only after a fresh response confirms the same
// assets. Reusing this descriptor retains its original authorization deadline.
export function reuseOriginalPreview(previous, next, { albumId, now = Date.now() } = {}) {
    const previousAlbum = previous?.albumId || albumId
    const nextAlbum = next?.albumId || albumId
    if (!Number.isFinite(now) || !previousAlbum || previousAlbum !== nextAlbum || !mediaId(previous) || mediaId(previous) !== mediaId(next)) return next
    const oldDescriptor = descriptor(previous)
    const newDescriptor = descriptor(next)
    if (!oldDescriptor || !newDescriptor || oldDescriptor.identity !== newDescriptor.identity
        || oldDescriptor.expiresAt <= now + REUSE_HEADROOM_MS
        || oldDescriptor.expiresAt > newDescriptor.expiresAt) return next
    return annotateMediaExpiry({ ...next, before: previous.before })
}

export function reuseOriginalPreviews(previous, next, options) {
    const priorById = new Map(previous.map(image => [mediaId(image), image]))
    return next.map(image => reuseOriginalPreview(priorById.get(mediaId(image)), image, options))
}
