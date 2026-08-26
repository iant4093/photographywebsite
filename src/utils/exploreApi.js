import { ApiError, apiFetch } from './api'
import { isSafeCursor, normalizePage } from './apiResponse'

const EXPLORE_CACHE_TTL_MS = 5 * 60_000
const responseCache = new Map()
const pendingRequests = new Map()

function withAbort(promise, signal) {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'))
    return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Request aborted', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
        promise.then(
            value => {
                signal.removeEventListener('abort', abort)
                resolve(value)
            },
            error => {
                signal.removeEventListener('abort', abort)
                reject(error)
            },
        )
    })
}

function cachedRequest(key, loader, signal) {
    const cached = responseCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return withAbort(Promise.resolve(cached.value), signal)
    if (cached) responseCache.delete(key)

    let request = pendingRequests.get(key)
    if (!request) {
        request = loader().then((value) => {
            responseCache.set(key, { value, expiresAt: Date.now() + EXPLORE_CACHE_TTL_MS })
            return value
        }).finally(() => pendingRequests.delete(key))
        pendingRequests.set(key, request)
    }
    return withAbort(request, signal)
}

function normalizeInitialPage(payload) {
    if (!payload?.initialPage || typeof payload.initialPage !== 'object') return null
    const value = typeof payload.initialPage.value === 'string' ? payload.initialPage.value : ''
    if (!value) return null
    return { value, ...normalizePage(payload.initialPage) }
}

export function fetchExplorePhotos(params, options = {}) {
    const mode = params?.mode
    const value = String(params?.value || '').trim()
    if (!['color', 'lens'].includes(mode) || !value) {
        return Promise.reject(new ApiError('Choose an Explore filter first.', { code: 'INVALID_EXPLORE_FILTER' }))
    }
    const query = new URLSearchParams({ mode, value, limit: String(params?.limit || 24) })
    if (params?.cursor) {
        if (!isSafeCursor(params.cursor)) {
            return Promise.reject(new ApiError('The pagination cursor was invalid.', { code: 'BAD_CURSOR' }))
        }
        query.set('cursor', params.cursor)
    }
    const path = `/public/explore?${query}`
    return cachedRequest(path, () => apiFetch(path).then(normalizePage), options.signal)
}

export function fetchExploreLenses(options = {}) {
    const path = '/public/explore?mode=lenses'
    return cachedRequest(path, () => apiFetch(path).then((payload) => ({
        items: Array.isArray(payload?.items)
            ? payload.items.filter(item => (
                typeof item?.name === 'string'
                && item.name
                && Number.isFinite(Number(item.photos))
                && Number(item.photos) > 0
            ))
            : [],
        initialPage: normalizeInitialPage(payload),
    })), options.signal)
}

export function fetchExploreColors(options = {}) {
    const path = '/public/explore?mode=colors'
    return cachedRequest(path, () => apiFetch(path).then((payload) => ({
        items: Array.isArray(payload?.items)
            ? payload.items.filter(item => (
                typeof item?.id === 'string'
                && item.id
                && Number.isFinite(Number(item.photos))
                && Number(item.photos) > 0
            ))
            : [],
        initialPage: normalizeInitialPage(payload),
    })), options.signal)
}

export function prefetchExploreModule(mode) {
    return mode === 'lens' ? fetchExploreLenses() : fetchExploreColors()
}

export function clearExploreCache() {
    responseCache.clear()
    pendingRequests.clear()
}
