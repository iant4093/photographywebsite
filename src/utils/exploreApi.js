import { ApiError, apiFetch } from './api'
import { isSafeCursor, normalizePage } from './apiResponse'

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
    return apiFetch(`/public/explore?${query}`, { signal: options.signal }).then(normalizePage)
}

export function fetchExploreLenses(options = {}) {
    return apiFetch('/public/explore?mode=lenses', { signal: options.signal }).then((payload) => ({
        items: Array.isArray(payload?.items)
            ? payload.items.filter(item => (
                typeof item?.name === 'string'
                && item.name
                && Number.isFinite(Number(item.photos))
                && Number(item.photos) > 0
            ))
            : [],
    }))
}
