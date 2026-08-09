import { createHash } from 'node:crypto'

export const PREVIEW_VERSION = 3
export const PREVIEW_WIDTHS = Object.freeze([640, 960, 1440, 1920])
export const PREVIOUS_PREVIEW_VERSION = 2
export const PREVIOUS_PREVIEW_WIDTHS = Object.freeze([480, 640, 1280])
export const PREVIEW_QUALITY = 84
export const ALLOWED_VISIBILITIES = new Set(['public', 'private', 'unlisted'])
export const SUPPORTED_SOURCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
export const PREVIEW_FAILURE_REASON_CODES = Object.freeze([
    'job_contract_invalid',
    'metadata_read_failed',
    'existing_preview_invalid',
    'metadata_pending_failed',
    'source_read_failed',
    'source_type_invalid',
    'source_transform_failed',
    'preview_object_write_failed',
    'visibility_tag_failed',
    'metadata_commit_failed',
    'unexpected_failure',
])

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const LEGACY_PREFIX_PATTERN = /^albums\/[a-z0-9](?:[a-z0-9._-]{0,198}[a-z0-9])?\/$/

export function normalizeAlbumId(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (!UUID_PATTERN.test(normalized)) throw new Error('Invalid albumId')
    return normalized
}

export function normalizeObjectKey(value) {
    if (typeof value !== 'string' || !value || value.length > 1024 || value !== value.trim()) {
        throw new Error('Invalid media key')
    }
    if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
        throw new Error('Invalid media key')
    }
    const parts = value.split('/')
    if (parts.some((part) => part === '' || part === '.' || part === '..')) {
        throw new Error('Invalid media key')
    }
    return value
}

export function mediaIdForKey(rawKey) {
    return createHash('sha256').update(normalizeObjectKey(rawKey), 'utf8').digest('hex').slice(0, 24)
}

function previewKeysForVersion(albumId, rawKey, version, widths) {
    const normalizedAlbumId = normalizeAlbumId(albumId)
    const mediaId = mediaIdForKey(rawKey)
    return Object.fromEntries(widths.map((width) => [
        String(width),
        `albums/${normalizedAlbumId}/preview/v${version}/${mediaId}-w${width}.webp`,
    ]))
}

export function previewKeysFor(albumId, rawKey) {
    return previewKeysForVersion(albumId, rawKey, PREVIEW_VERSION, PREVIEW_WIDTHS)
}

export function previousPreviewKeysFor(albumId, rawKey) {
    return previewKeysForVersion(albumId, rawKey, PREVIOUS_PREVIEW_VERSION, PREVIOUS_PREVIEW_WIDTHS)
}

export function parseJob(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preview job')
    if (Number(value.previewVersion) !== PREVIEW_VERSION) throw new Error('Unsupported preview version')
    return {
        albumId: normalizeAlbumId(value.albumId),
        rawKey: normalizeObjectKey(value.rawKey),
        previewVersion: PREVIEW_VERSION,
    }
}

function allowedPrefixes(album) {
    const albumId = normalizeAlbumId(album?.albumId)
    const prefixes = [`albums/${albumId}/`]
    const legacy = album?.legacyS3Prefix
    if (typeof legacy === 'string' && LEGACY_PREFIX_PATTERN.test(legacy)) prefixes.push(legacy)
    return prefixes
}

export function resolveManifestImage(album, jobValue) {
    const job = parseJob(jobValue)
    if (!album || typeof album !== 'object' || normalizeAlbumId(album.albumId) !== job.albumId) {
        throw new Error('Preview job does not match album')
    }
    if (album.status && album.status !== 'active') throw new Error('Album is not active')
    if (album.type && album.type !== 'photo') throw new Error('Album is not a photo album')
    if (!ALLOWED_VISIBILITIES.has(album.visibility)) throw new Error('Album visibility is invalid')
    if (!allowedPrefixes(album).some((prefix) => job.rawKey.startsWith(prefix))) {
        throw new Error('Media key is outside the album namespace')
    }
    if (!Array.isArray(album.images)) throw new Error('Album manifest is invalid')
    const index = album.images.findIndex((image) => {
        if (!image || typeof image !== 'object') return false
        return (image.rawKey || image.key) === job.rawKey
    })
    if (index < 0) throw new Error('Media is no longer in the album manifest')
    return {
        job,
        index,
        image: album.images[index],
        visibility: album.visibility,
        previewKeys: previewKeysFor(job.albumId, job.rawKey),
    }
}

export function isCompletePreview(image, expectedKeys) {
    if (!image || Number(image.previewVersion) !== PREVIEW_VERSION) return false
    if (!image.previewKeys || typeof image.previewKeys !== 'object') return false
    return PREVIEW_WIDTHS.every((width) => image.previewKeys[String(width)] === expectedKeys[String(width)])
}

export function previewJobId(jobValue) {
    const job = parseJob(jobValue)
    return createHash('sha256')
        .update(`${job.albumId}\0${job.rawKey}\0${PREVIEW_VERSION}`, 'utf8')
        .digest('hex')
        .slice(0, 32)
}

export function parsePositiveLimit(value, fallback, maximum) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback
}

export function safePreviewFailureReason(error) {
    const reasonCode = error && typeof error === 'object' ? error.reasonCode : null
    return PREVIEW_FAILURE_REASON_CODES.includes(reasonCode) ? reasonCode : 'unexpected_failure'
}
