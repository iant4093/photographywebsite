import { isSafeCursor, normalizePage } from './apiResponse'
import {
    invalidateCatalogSnapshots,
    recordPublicCatalogDeletion,
    recordPublicCatalogUpsert,
} from './catalogState'
import { annotateMediaExpiry } from './mediaUrls'

// Production uses the single CloudFront front door. An explicit absolute URL
// remains available for local/staged rollback while the migration is canaried.
const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'
const DEFAULT_TIMEOUT_MS = 15_000
const PUBLIC_CATALOG_TTL_MS = 5 * 60_000
const PUBLIC_ALBUM_TTL_MS = 5 * 60_000
const PUBLIC_ALBUM_CACHE_LIMIT = 5
const catalogCache = new Map()
const catalogRequests = new Map()
const publicAlbumCache = new Map()
const publicAlbumRequests = new Map()

export class ApiError extends Error {
    constructor(message, { status = 0, code = 'API_ERROR', retryAfterMs = 0 } = {}) {
        super(message)
        this.name = 'ApiError'
        this.status = status
        this.code = code
        this.retryAfterMs = retryAfterMs
    }
}

function retryAfterMilliseconds(value) {
    if (!value) return 0
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0
}

function authHeaders(token) {
    return token ? { Authorization: `Bearer ${token}` } : {}
}

function userMessageForStatus(status, fallback) {
    if (status === 400) return fallback || 'The request was not valid. Please review it and try again.'
    if (status === 401) return 'Your session has expired. Please sign in again.'
    if (status === 403) return 'You do not have permission to do that.'
    if (status === 404) return fallback || 'The requested item was not found.'
    if (status === 409) return fallback || 'That change conflicts with existing data.'
    if (status === 413) return 'The request is too large.'
    if (status === 429) return 'Too many requests. Please wait and try again.'
    return 'The service is temporarily unavailable. Please try again.'
}

function combineSignals(...signals) {
    const activeSignals = signals.filter(Boolean)
    if (activeSignals.length === 0) return undefined
    if (activeSignals.length === 1) return activeSignals[0]
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(activeSignals)

    const controller = new AbortController()
    const abort = () => controller.abort()
    for (const signal of activeSignals) {
        if (signal.aborted) {
            controller.abort()
            break
        }
        signal.addEventListener('abort', abort, { once: true })
    }
    return controller.signal
}

function wait(delayMs, signal) {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(resolve, delayMs)
        signal?.addEventListener('abort', () => {
            window.clearTimeout(timer)
            reject(new DOMException('Request aborted', 'AbortError'))
        }, { once: true })
    })
}

async function readErrorMessage(response) {
    if (response.status >= 500) return null
    try {
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) return null
        const body = await response.json()
        const candidate = body?.message || body?.error
        return typeof candidate === 'string' && candidate.length <= 200 ? candidate : null
    } catch {
        return null
    }
}

export async function apiFetch(path, options = {}, config = {}) {
    const {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        retries = options.method && options.method !== 'GET' ? 0 : 1,
    } = config
    const url = `${API_BASE}${path}`

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const timeoutController = new AbortController()
        const timeout = timeoutMs > 0
            ? window.setTimeout(() => timeoutController.abort(), timeoutMs)
            : null
        const signal = combineSignals(options.signal, timeoutController.signal)

        try {
            const hasBody = options.body !== undefined && options.body !== null
            const response = await fetch(url, {
                ...options,
                signal,
                headers: {
                    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
                    ...options.headers,
                },
            })

            if (!response.ok) {
                const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status)
                if (retryable && attempt < retries) {
                    await response.text().catch(() => '')
                    await wait(250 * (2 ** attempt) + Math.random() * 150, options.signal)
                    continue
                }
                const safeDetail = await readErrorMessage(response)
                throw new ApiError(userMessageForStatus(response.status, safeDetail), {
                    status: response.status,
                    code: `HTTP_${response.status}`,
                    retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')),
                })
            }
            if (response.status === 204) return null
            return response.json()
        } catch (error) {
            if (error?.name === 'AbortError') {
                if (options.signal?.aborted) throw error
                throw new ApiError('The request timed out. Please check your connection and try again.', {
                    code: 'TIMEOUT',
                })
            }
            const retryableNetworkError = !(error instanceof ApiError)
            if (retryableNetworkError && attempt < retries) {
                await wait(250 * (2 ** attempt) + Math.random() * 150, options.signal)
                continue
            }
            if (error instanceof ApiError) throw error
            throw new ApiError('Unable to reach the service. Please check your connection and try again.', {
                code: 'NETWORK_ERROR',
            })
        } finally {
            if (timeout !== null) window.clearTimeout(timeout)
        }
    }

    throw new ApiError('The request could not be completed.')
}

function normalizeCatalogParams(params = {}) {
    const normalized = {}
    for (const key of ['visibility', 'ownerEmail', 'type', 'limit', 'cursor']) {
        const value = params[key]
        if (value !== undefined && value !== null && value !== '') normalized[key] = String(value)
    }
    if (!isSafeCursor(normalized.cursor)) throw new ApiError('The pagination cursor was invalid.', { code: 'BAD_CURSOR' })
    return normalized
}

function catalogKey(params) {
    return new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))).toString()
}

function normalizeLegacyCatalogPage(payload, params) {
    let items = payload
    if (params.visibility && params.visibility !== 'all') {
        items = items.filter((album) => album?.visibility === params.visibility)
    }
    if (params.ownerEmail) items = items.filter((album) => album?.ownerEmail === params.ownerEmail)
    if (params.type) {
        items = items.filter((album) => (
            params.type === 'video' ? album?.type === 'video' : album?.type !== 'video'
        ))
    }

    const offset = params.cursor?.startsWith('legacy:')
        ? Number.parseInt(params.cursor.slice('legacy:'.length), 10) || 0
        : 0
    const limit = Math.max(1, Math.min(Number.parseInt(params.limit, 10) || items.length, 100))
    const pageItems = items.slice(offset, offset + limit)
    const nextOffset = offset + pageItems.length
    return {
        items: pageItems,
        nextCursor: nextOffset < items.length ? `legacy:${nextOffset}` : null,
    }
}

function subscribeToCatalogRequest(record, signal) {
    record.subscribers += 1
    return new Promise((resolve, reject) => {
        let settled = false
        const finish = (callback, value) => {
            if (settled) return
            settled = true
            signal?.removeEventListener('abort', onAbort)
            record.subscribers -= 1
            callback(value)
        }
        const onAbort = () => {
            finish(reject, new DOMException('Request aborted', 'AbortError'))
            if (record.subscribers === 0) record.controller.abort()
        }

        if (signal?.aborted) {
            onAbort()
            return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        record.promise.then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error),
        )
    })
}

export function clearApiCache() {
    catalogCache.clear()
    for (const record of catalogRequests.values()) record.controller.abort()
    catalogRequests.clear()
    publicAlbumCache.clear()
    for (const record of publicAlbumRequests.values()) record.controller.abort()
    publicAlbumRequests.clear()
}

function invalidateAlbumCatalog({ album, deletedAlbumId } = {}) {
    clearApiCache()
    if (album?.albumId) {
        recordPublicCatalogUpsert(album)
    } else if (deletedAlbumId) {
        recordPublicCatalogDeletion(deletedAlbumId)
    } else {
        invalidateCatalogSnapshots()
    }
}

export function readCachedAlbumsPage(params = {}) {
    const normalized = normalizeCatalogParams(params)
    const cached = catalogCache.get(`public:${catalogKey(normalized)}`)
    return cached && cached.expiresAt > Date.now() ? cached.value : null
}

export function fetchAlbumsPage(params = {}, options = {}) {
    if (options.signal?.aborted) {
        return Promise.reject(options.signal.reason || new DOMException('Request aborted', 'AbortError'))
    }

    const normalized = normalizeCatalogParams(params)
    const isPublic = !options.token
    const key = `${isPublic ? 'public' : `auth:${normalized.ownerEmail || 'admin'}`}:${catalogKey(normalized)}`
    const cached = catalogCache.get(key)
    if (!options.force && isPublic && cached?.expiresAt > Date.now()) {
        return Promise.resolve(cached.value)
    }

    const existing = catalogRequests.get(key)
    if (!options.force && existing && !existing.controller.signal.aborted) {
        return subscribeToCatalogRequest(existing, options.signal)
    }
    if (existing?.controller.signal.aborted && catalogRequests.get(key) === existing) {
        catalogRequests.delete(key)
    }

    const controller = new AbortController()
    // The anonymous route has an intentionally narrow cache key and never
    // receives visibility/owner selectors, even if a caller supplies them.
    const wireParams = isPublic
        ? Object.fromEntries(
            Object.entries(normalized).filter(([name]) => ['type', 'limit', 'cursor'].includes(name)),
        )
        : normalized
    const query = new URLSearchParams(wireParams).toString()
    const record = { controller, subscribers: 0, promise: null }
    const catalogPath = isPublic ? '/public/albums' : '/albums'
    record.promise = apiFetch(`${catalogPath}${query ? `?${query}` : ''}`, {
        headers: authHeaders(options.token),
        signal: controller.signal,
    }).then((payload) => {
        const page = Array.isArray(payload)
            ? normalizeLegacyCatalogPage(payload, normalized)
            : normalizePage(payload)
        if (!isSafeCursor(page.nextCursor)) {
            throw new ApiError('The service returned an invalid pagination cursor.', {
                code: 'BAD_CURSOR',
            })
        }
        page.items = page.items.map(annotateMediaExpiry)
        if (isPublic) {
            catalogCache.set(key, { value: page, expiresAt: Date.now() + PUBLIC_CATALOG_TTL_MS })
        }
        return page
    }).finally(() => {
        if (catalogRequests.get(key) === record) catalogRequests.delete(key)
    })
    record.promise.catch(() => {})
    catalogRequests.set(key, record)
    return subscribeToCatalogRequest(record, options.signal)
}

export async function fetchAllAlbums(params = {}, options = {}) {
    const allItems = []
    const seenCursors = new Set()
    let cursor = null
    do {
        const page = await fetchAlbumsPage({ ...params, cursor }, options)
        allItems.push(...page.items)
        cursor = page.nextCursor
        if (cursor && seenCursors.has(cursor)) {
            throw new ApiError('The service returned an invalid pagination sequence.', {
                code: 'REPEATED_CURSOR',
            })
        }
        if (cursor) seenCursors.add(cursor)
    } while (cursor)
    return allItems
}

export function fetchAlbums(options = {}) {
    return fetchAllAlbums({ visibility: 'public' }, options)
}

export function fetchRandomPhotos(options = {}) {
    const category = typeof options.category === 'string' ? options.category.trim() : ''
    const query = category
        ? `?${new URLSearchParams({ mode: 'category', value: category })}`
        : ''
    return apiFetch(`/public/random-photos${query}`, { signal: options.signal }, { timeoutMs: 30_000 })
        .then((payload) => ({
            ...payload,
            images: Array.isArray(payload?.images)
                ? payload.images.map(annotateMediaExpiry)
                : [],
        }))
}

export function fetchAlbumsFiltered(params = {}, token = null, options = {}) {
    return fetchAllAlbums(params, { ...options, token })
}

function normalizeAlbumDetail(data) {
        if (!data || Array.isArray(data)) return data
        const mediaItems = Array.isArray(data.images)
            ? data.images
            : Array.isArray(data.media)
                ? data.media
                : data.media?.items
        return Array.isArray(mediaItems)
            ? { ...data, images: mediaItems.map(annotateMediaExpiry) }
            : data
}

function setCachedPublicAlbum(albumId, value) {
    publicAlbumCache.delete(albumId)
    publicAlbumCache.set(albumId, { value, expiresAt: Date.now() + PUBLIC_ALBUM_TTL_MS })
    while (publicAlbumCache.size > PUBLIC_ALBUM_CACHE_LIMIT) {
        publicAlbumCache.delete(publicAlbumCache.keys().next().value)
    }
}

export function readCachedPublicAlbum(albumId) {
    const key = String(albumId || '')
    const cached = publicAlbumCache.get(key)
    if (!cached || cached.expiresAt <= Date.now()) {
        publicAlbumCache.delete(key)
        return null
    }
    // Refresh LRU recency without extending the freshness contract.
    publicAlbumCache.delete(key)
    publicAlbumCache.set(key, cached)
    return cached.value
}

export function fetchAlbum(albumId, token = null, options = {}) {
    const key = String(albumId || '')
    const albumPath = token ? '/albums' : '/public/albums'
    if (token) {
        return apiFetch(`${albumPath}/${encodeURIComponent(key)}`, {
            headers: authHeaders(token),
            signal: options.signal,
        }).then(normalizeAlbumDetail)
    }

    if (!options.force) {
        const cached = readCachedPublicAlbum(key)
        if (cached) return Promise.resolve(cached)
        const existing = publicAlbumRequests.get(key)
        if (existing && !existing.controller.signal.aborted) {
            return subscribeToCatalogRequest(existing, options.signal)
        }
    }

    const prior = publicAlbumRequests.get(key)
    if (prior?.controller.signal.aborted) publicAlbumRequests.delete(key)
    const controller = new AbortController()
    const record = { controller, subscribers: 0, promise: null }
    record.promise = apiFetch(`${albumPath}/${encodeURIComponent(key)}`, {
        signal: controller.signal,
    }).then(normalizeAlbumDetail).then((data) => {
        setCachedPublicAlbum(key, data)
        return data
    }).finally(() => {
        if (publicAlbumRequests.get(key) === record) publicAlbumRequests.delete(key)
    })
    record.promise.catch(() => {})
    publicAlbumRequests.set(key, record)
    return subscribeToCatalogRequest(record, options.signal)
}

export function prefetchPublicAlbum(albumId) {
    return fetchAlbum(albumId).catch(() => null)
}

export function requestAlbumZip(albumId, token = null, options = {}) {
    return apiFetch(`/albums/${encodeURIComponent(albumId)}/zip`, {
        method: 'POST',
        headers: authHeaders(token),
        signal: options.signal,
    })
}

export function fetchSharedAlbum(shareCode, turnstileToken, options = {}) {
    return apiFetch(`/shared/${encodeURIComponent(shareCode)}`, {
        headers: { 'X-Turnstile-Token': turnstileToken || '' },
        signal: options.signal,
    }).then((data) => (
        data && Array.isArray(data.images)
            ? { ...data, images: data.images.map(annotateMediaExpiry) }
            : data
    ))
}

export function sendContactMessage(data, options = {}) {
    return apiFetch('/contact', {
        method: 'POST',
        body: JSON.stringify(data),
        signal: options.signal,
    })
}

export function requestSharedAlbumZip(shareCode, options = {}) {
    return apiFetch(`/shared/${encodeURIComponent(shareCode)}/zip`, {
        method: 'POST',
        signal: options.signal,
    })
}

export function requestAlbumMediaDownload(albumId, mediaId, token = null, options = {}) {
    return apiFetch(`/albums/${encodeURIComponent(albumId)}/download-url`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ mediaId }),
        signal: options.signal,
    })
}

export function requestSharedMediaDownload(shareCode, mediaId, options = {}) {
    return apiFetch(`/shared/${encodeURIComponent(shareCode)}/download-url`, {
        method: 'POST',
        body: JSON.stringify({ mediaId }),
        signal: options.signal,
    })
}

export function requestAlbumPrintSession(albumId, mediaId, token = null, options = {}) {
    return apiFetch(`/albums/${encodeURIComponent(albumId)}/print`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ mediaId }),
        signal: options.signal,
    })
}

export function requestSharedPrintSession(shareCode, mediaId, options = {}) {
    return apiFetch(`/shared/${encodeURIComponent(shareCode)}/print`, {
        method: 'POST',
        body: JSON.stringify({ mediaId }),
        signal: options.signal,
    })
}

export function redeemPrintSession(sessionToken, options = {}) {
    return apiFetch('/print/session', {
        method: 'POST',
        body: JSON.stringify({ sessionToken }),
        signal: options.signal,
    })
}

export function requestUploadUrl(token, albumId, filename, contentType, size, kind, options = {}) {
    return apiFetch('/upload-url', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ albumId, filename, contentType, size, kind }),
        signal: options.signal,
    })
}

export function requestHeroUploadUrl(token, file, options = {}) {
    return apiFetch('/admin/hero/upload-url', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            size: file.size,
        }),
        signal: options.signal,
    })
}

export function completeHeroUpload(token, etag, options = {}) {
    return apiFetch('/admin/hero/complete', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ etag }),
        signal: options.signal,
    })
}

export async function uploadFileToS3(presignedUrl, file, requiredHeaders = {}, options = {}) {
    const uploadHeaders = Object.keys(requiredHeaders).length > 0
        ? requiredHeaders
        : { 'Content-Type': file.type }
    const retries = Math.max(0, Math.min(options.retries ?? 1, 2))

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        let response
        try {
            response = await fetch(presignedUrl, {
                method: 'PUT',
                headers: uploadHeaders,
                body: file,
                signal: options.signal,
            })
        } catch (error) {
            if (error?.name === 'AbortError') throw error
            if (attempt < retries) {
                await wait(400 * (2 ** attempt) + Math.random() * 200, options.signal)
                continue
            }
            throw new ApiError('The upload was interrupted. Please try again.', { code: 'UPLOAD_NETWORK_ERROR' })
        }

        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status)
        if (retryable && attempt < retries) {
            await response.text().catch(() => '')
            await wait(400 * (2 ** attempt) + Math.random() * 200, options.signal)
            continue
        }
        if (!response.ok) throw new ApiError('The upload could not be completed. Please try again.', {
            status: response.status,
            code: 'UPLOAD_FAILED',
        })
        return response
    }

    throw new ApiError('The upload could not be completed. Please try again.', { code: 'UPLOAD_FAILED' })
}

export async function createAlbum(token, albumData, options = {}) {
    const album = await apiFetch('/albums', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(albumData),
        signal: options.signal,
    }, { timeoutMs: 60_000 })
    invalidateAlbumCatalog({ album })
    return album
}

export async function updateAlbum(token, albumId, data, options = {}) {
    const album = await apiFetch(`/albums/${encodeURIComponent(albumId)}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(data),
        signal: options.signal,
    })
    invalidateAlbumCatalog({ album })
    return album
}

export async function updateGalleryOrder(token, ordering, options = {}) {
    const result = await apiFetch('/admin/gallery-order', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(ordering),
        signal: options.signal,
    })
    clearApiCache()
    invalidateCatalogSnapshots()
    return result
}

export async function addImagesToAlbum(token, albumId, images, options = {}) {
    const result = await apiFetch(`/albums/${encodeURIComponent(albumId)}/images`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ images }),
        signal: options.signal,
    }, { timeoutMs: 60_000 })
    invalidateAlbumCatalog()
    return result
}

export async function deleteAlbum(token, albumId, options = {}) {
    const result = await apiFetch(`/albums/${encodeURIComponent(albumId)}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        signal: options.signal,
    }, { timeoutMs: 60_000 })
    invalidateAlbumCatalog({ deletedAlbumId: albumId })
    return result
}

export async function deleteImages(token, albumId, keys, options = {}) {
    const result = await apiFetch(`/albums/${encodeURIComponent(albumId)}/delete-images`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ keys }),
        signal: options.signal,
    }, { timeoutMs: 60_000 })
    invalidateAlbumCatalog()
    return result
}

export async function updateImageThumbnail(token, albumId, rawKey, data, options = {}) {
    const result = await apiFetch(`/albums/${encodeURIComponent(albumId)}/images`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ rawKey, ...data }),
        signal: options.signal,
    })
    invalidateAlbumCatalog()
    return result
}

export function createUser(token, email, options = {}) {
    return apiFetch('/users', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ email }),
        signal: options.signal,
    })
}

export async function listUsers(token, options = {}) {
    const users = []
    const seenCursors = new Set()
    let cursor = null
    do {
        const query = cursor ? `?paginationToken=${encodeURIComponent(cursor)}` : ''
        const payload = await apiFetch(`/users${query}`, {
            headers: authHeaders(token),
            signal: options.signal,
        })
        if (Array.isArray(payload)) {
            users.push(...payload)
            cursor = null
        } else {
            users.push(...(payload?.users || []))
            cursor = payload?.paginationToken || payload?.nextCursor || null
            if (cursor && seenCursors.has(cursor)) {
                throw new ApiError('The service returned an invalid pagination sequence.', {
                    code: 'REPEATED_CURSOR',
                })
            }
            if (cursor) seenCursors.add(cursor)
        }
    } while (cursor)
    return users
}

export function deleteUser(token, email, options = {}) {
    return apiFetch(`/users/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        signal: options.signal,
    }, { timeoutMs: 60_000 })
}

export function editUser(token, email, data, options = {}) {
    return apiFetch(`/users/${encodeURIComponent(email)}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(data),
        signal: options.signal,
    })
}

export function fetchCostReport(token, options = {}) {
    return apiFetch('/admin/costs', {
        headers: authHeaders(token),
        signal: options.signal,
    }, { timeoutMs: 30_000, retries: 0 })
}

export function fetchAnalyticsReport(token, range = 30, options = {}) {
    return apiFetch(`/admin/analytics?range=${encodeURIComponent(range)}`, {
        headers: authHeaders(token),
        signal: options.signal,
    }, { timeoutMs: 30_000, retries: 0 })
}

export function sendAnalyticsEvents(events) {
    return apiFetch('/analytics/events', {
        method: 'POST',
        credentials: 'omit',
        keepalive: true,
        body: JSON.stringify({ events }),
    }, { timeoutMs: 8_000, retries: 0 })
}

export function fetchGoogleDriveUsage(token, options = {}) {
    return apiFetch('/admin/drive-usage', {
        headers: authHeaders(token),
        signal: options.signal,
    }, { timeoutMs: 60_000, retries: 0 })
}

export function fetchGitHubAnalytics(token, options = {}) {
    return apiFetch('/admin/github-analytics', {
        headers: authHeaders(token),
        signal: options.signal,
    }, { timeoutMs: 30_000, retries: 0 })
}

export function fetchSiteHealth(token, options = {}) {
    return apiFetch('/admin/site-health', {
        headers: authHeaders(token),
        signal: options.signal,
    }, { timeoutMs: 20_000, retries: 0 })
}

export function fetchAuditLog(token, days = 7, options = {}) {
    return apiFetch(`/admin/audit-log?days=${encodeURIComponent(days)}`, {
        headers: authHeaders(token),
        signal: options.signal,
    }, { timeoutMs: 20_000, retries: 0 })
}

export function fetchPhotographyStats(options = {}) {
    return apiFetch('/public/stats', {
        signal: options.signal,
    }, { timeoutMs: 15_000, retries: 1 })
}
