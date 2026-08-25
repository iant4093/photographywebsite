import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    clearApiCache,
    fetchAlbum,
    fetchAlbumsPage,
    fetchRandomPhotos,
    prefetchPublicAlbum,
    readCachedPublicAlbum,
} from './api'
import { fetchExploreLenses, fetchExplorePhotos } from './exploreApi'

function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })
}

describe('fetchAlbumsPage cancellation', () => {
    beforeEach(() => {
        clearApiCache()
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        })
    })

    afterEach(() => {
        clearApiCache()
        vi.unstubAllGlobals()
    })

    it('rejects an already-aborted request before reading cache or making a request', async () => {
        const request = vi.fn()
        vi.stubGlobal('fetch', request)
        const controller = new AbortController()
        controller.abort()

        await expect(fetchAlbumsPage({ limit: 24 }, { signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' })
        expect(request).not.toHaveBeenCalled()
    })

    it('replaces an aborted in-flight request instead of subscribing to it', async () => {
        let requestCount = 0
        vi.stubGlobal('fetch', vi.fn((_url, { signal }) => {
            requestCount += 1
            if (requestCount === 1) {
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
                })
            }
            return Promise.resolve(new Response(JSON.stringify({
                items: [{ albumId: 'replacement-request' }],
                nextCursor: null,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        }))

        const firstController = new AbortController()
        const firstRequest = fetchAlbumsPage({ visibility: 'public', type: 'photo', limit: 24 }, {
            signal: firstController.signal,
        })
        firstController.abort()
        const replacement = fetchAlbumsPage({ visibility: 'public', type: 'photo', limit: 24 })

        await expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' })
        await expect(replacement).resolves.toMatchObject({
            items: [{ albumId: 'replacement-request' }],
            nextCursor: null,
        })
        expect(requestCount).toBe(2)
    })
})

describe('public album detail cache', () => {
    beforeEach(() => {
        clearApiCache()
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        })
    })

    afterEach(() => {
        clearApiCache()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('deduplicates in-flight requests and reuses a fresh public response', async () => {
        let resolveRequest
        const request = vi.fn(() => new Promise((resolve) => { resolveRequest = resolve }))
        vi.stubGlobal('fetch', request)

        const first = fetchAlbum('album-one')
        const second = fetchAlbum('album-one')
        expect(request).toHaveBeenCalledOnce()
        resolveRequest(jsonResponse({ albumId: 'album-one', images: [] }))

        await expect(first).resolves.toMatchObject({ albumId: 'album-one' })
        await expect(second).resolves.toMatchObject({ albumId: 'album-one' })
        await expect(fetchAlbum('album-one')).resolves.toMatchObject({ albumId: 'album-one' })
        expect(request).toHaveBeenCalledOnce()
        expect(readCachedPublicAlbum('album-one')).toMatchObject({ albumId: 'album-one' })
    })

    it('expires entries, bounds the LRU to five albums, and supports forced refresh', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const request = vi.fn((url) => Promise.resolve(jsonResponse({ albumId: url.split('/').pop(), images: [] })))
        vi.stubGlobal('fetch', request)

        for (let index = 1; index <= 6; index += 1) await fetchAlbum(`album-${index}`)
        expect(readCachedPublicAlbum('album-1')).toBeNull()
        expect(readCachedPublicAlbum('album-6')).toMatchObject({ albumId: 'album-6' })

        await fetchAlbum('album-6', null, { force: true })
        expect(request).toHaveBeenCalledTimes(7)
        vi.advanceTimersByTime(5 * 60_000 + 1)
        expect(readCachedPublicAlbum('album-6')).toBeNull()
    })

    it('never caches authenticated album data and hides speculative failures', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ albumId: 'private', images: [] }))
            .mockResolvedValueOnce(jsonResponse({ albumId: 'private', images: [] }))
            .mockResolvedValueOnce(new Response('', { status: 404 }))
        vi.stubGlobal('fetch', request)

        await fetchAlbum('private', 'secret-token')
        await fetchAlbum('private', 'secret-token')
        expect(request).toHaveBeenNthCalledWith(1, expect.stringMatching(/\/albums\/private$/), expect.objectContaining({
            headers: { Authorization: 'Bearer secret-token' },
        }))
        expect(request).toHaveBeenCalledTimes(2)
        await expect(prefetchPublicAlbum('missing')).resolves.toBeNull()
        expect(request).toHaveBeenCalledTimes(3)
    })
})

describe('random public photos', () => {
    beforeEach(() => {
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        })
    })

    afterEach(() => vi.unstubAllGlobals())

    it('requests a fresh random session and annotates its media', async () => {
        const request = vi.fn().mockResolvedValue(jsonResponse({
            images: [{ mediaId: 'photo', url: 'https://media.test/photo.jpg' }],
            totalPhotos: 42,
        }))
        vi.stubGlobal('fetch', request)

        const payload = await fetchRandomPhotos()
        expect(request.mock.calls[0][0]).toMatch(/\/public\/random-photos$/)
        expect(payload.totalPhotos).toBe(42)
        expect(payload.images).toHaveLength(1)
    })
})

describe('public Explore API', () => {
    beforeEach(() => {
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        })
    })

    afterEach(() => vi.unstubAllGlobals())

    it('encodes color and lens filters and preserves safe pagination', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'blue' }], nextCursor: 'next' }))
            .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'lens' }], nextCursor: null }))
        vi.stubGlobal('fetch', request)

        await expect(fetchExplorePhotos({ mode: 'color', value: 'blue', limit: 12 }))
            .resolves.toMatchObject({ items: [{ id: 'blue' }], nextCursor: 'next' })
        await expect(fetchExplorePhotos({ mode: 'lens', value: 'Sigma 18-50mm', cursor: 'next' }))
            .resolves.toMatchObject({ items: [{ id: 'lens' }] })
        expect(request.mock.calls[0][0]).toContain('mode=color')
        expect(request.mock.calls[0][0]).toContain('limit=12')
        expect(request.mock.calls[1][0]).toContain('cursor=next')
    })

    it('rejects missing filters and unsafe cursors before making a request', async () => {
        const request = vi.fn()
        vi.stubGlobal('fetch', request)
        await expect(fetchExplorePhotos({ mode: 'camera', value: 'R7' }))
            .rejects.toMatchObject({ code: 'INVALID_EXPLORE_FILTER' })
        await expect(fetchExplorePhotos({ mode: 'color', value: '   ' }))
            .rejects.toMatchObject({ code: 'INVALID_EXPLORE_FILTER' })
        await expect(fetchExplorePhotos({ mode: 'color', value: 'blue', cursor: 'x'.repeat(4097) }))
            .rejects.toMatchObject({ code: 'BAD_CURSOR' })
        expect(request).not.toHaveBeenCalled()
    })

    it('keeps only named, positive lens facets', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            items: [
                { name: 'Sigma 18-50mm', photos: 7 },
                { name: '', photos: 2 },
                { name: 'Broken count', photos: 'many' },
                { name: 'Empty lens', photos: 0 },
            ],
        })))
        await expect(fetchExploreLenses()).resolves.toEqual({
            items: [{ name: 'Sigma 18-50mm', photos: 7 }],
        })
    })
})
