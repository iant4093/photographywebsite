import { ApiError, apiFetch, fetchRandomPhotos } from './api'
import { isSafeCursor, normalizePage } from './apiResponse'
import { cachedExploreRequest, clearExploreResponseCache } from './exploreState'

const EXPLORE_SEED_PATTERN = /^[0-9a-f]{16}$/

function normalizeExplorePage(payload) {
    const page = normalizePage(payload)
    if (typeof payload?.seed === 'string' && EXPLORE_SEED_PATTERN.test(payload.seed)) {
        page.seed = payload.seed
    }
    return page
}

function normalizeInitialPage(payload) {
    if (!payload?.initialPage || typeof payload.initialPage !== 'object') return null
    const value = typeof payload.initialPage.value === 'string' ? payload.initialPage.value : ''
    if (!value) return null
    return { value, ...normalizeExplorePage(payload.initialPage) }
}

export function fetchExplorePhotos(params, options = {}) {
    const mode = params?.mode
    const value = String(params?.value || '').trim()
    if (!['color', 'lens', 'exposure', 'time', 'season'].includes(mode) || !value) {
        return Promise.reject(new ApiError('Choose an Explore filter first.', { code: 'INVALID_EXPLORE_FILTER' }))
    }
    const query = new URLSearchParams({ mode, value, limit: String(params?.limit || 24) })
    if (params?.seed) {
        if (params?.cursor || !EXPLORE_SEED_PATTERN.test(params.seed)) {
            return Promise.reject(new ApiError('The shuffle session was invalid.', { code: 'BAD_EXPLORE_SEED' }))
        }
        query.set('seed', params.seed)
    }
    if (params?.cursor) {
        if (!isSafeCursor(params.cursor)) {
            return Promise.reject(new ApiError('The pagination cursor was invalid.', { code: 'BAD_CURSOR' }))
        }
        query.set('cursor', params.cursor)
    }
    const path = `/public/explore?${query}`
    return cachedExploreRequest(path, () => apiFetch(path).then(normalizeExplorePage), options.signal)
}

export function createExploreSeed() {
    const values = new Uint32Array(2)
    if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(values)
    } else {
        values[0] = Math.floor(Math.random() * 0x1_0000_0000)
        values[1] = Math.floor(Math.random() * 0x1_0000_0000)
    }
    return [...values].map(value => value.toString(16).padStart(8, '0')).join('')
}

export function fetchExploreLenses(options = {}) {
    const path = '/public/explore?mode=lenses'
    return cachedExploreRequest(path, () => apiFetch(path).then((payload) => ({
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
    return cachedExploreRequest(path, () => apiFetch(path).then((payload) => ({
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

export function fetchExploreExposures(options = {}) {
    const path = '/public/explore?mode=exposures'
    return cachedExploreRequest(path, () => apiFetch(path).then((payload) => ({
        items: Array.isArray(payload?.items)
            ? payload.items.filter(group => (
                typeof group?.id === 'string'
                && group.id
                && Array.isArray(group.options)
            )).map(group => ({
                id: group.id,
                options: group.options.filter(option => (
                    typeof option?.id === 'string'
                    && Number.isFinite(Number(option.photos))
                    && Number(option.photos) >= 0
                )).map(option => ({ ...option, photos: Number(option.photos) })),
            }))
            : [],
        initialPage: normalizeInitialPage(payload),
    })), options.signal)
}

function normalizeTemporalOptions(payload) {
    return {
        items: Array.isArray(payload?.items)
            ? payload.items.filter(item => (
                typeof item?.id === 'string'
                && item.id
                && Number.isFinite(Number(item.photos))
                && Number(item.photos) >= 0
            )).map(item => ({ id: item.id, photos: Number(item.photos) }))
            : [],
        initialPage: normalizeInitialPage(payload),
    }
}

export function fetchExploreTimes(options = {}) {
    const path = '/public/explore?mode=times'
    return cachedExploreRequest(path, () => apiFetch(path).then(normalizeTemporalOptions), options.signal)
}

export function fetchExploreSeasons(options = {}) {
    const path = '/public/explore?mode=seasons'
    return cachedExploreRequest(path, () => apiFetch(path).then(normalizeTemporalOptions), options.signal)
}

export function prefetchExploreModule(mode) {
    if (mode === 'sample') return fetchExploreSample()
    if (mode === 'exposure') return fetchExploreExposures()
    if (mode === 'lens') return fetchExploreLenses()
    if (mode === 'color') return fetchExploreColors()
    if (mode === 'time') return fetchExploreTimes()
    if (mode === 'season') return fetchExploreSeasons()
    return Promise.reject(new ApiError('Unsupported Explore module.', { code: 'INVALID_EXPLORE_MODE' }))
}

export function fetchExploreSample(options = {}) {
    const key = '/public/random-photos:explore-sample'
    return cachedExploreRequest(key, () => fetchRandomPhotos(), options.signal)
}

export function clearExploreCache() {
    clearExploreResponseCache()
}
