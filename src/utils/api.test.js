import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    clearApiCache,
    fetchAlbum,
    fetchAlbumForViewing,
    fetchAlbumsPage,
    fetchRandomPhotos,
    prefetchPublicAlbum,
    readCachedPublicAlbum,
} from './api'
import {
    clearExploreCache,
    createExploreSeed,
    fetchExploreColors,
    fetchExploreExposures,
    fetchExploreLenses,
    fetchExplorePhotos,
    fetchExploreSample,
    fetchExploreSeasons,
    fetchExploreTimes,
    prefetchExploreModule,
} from './exploreApi'

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
        expect(request).toHaveBeenLastCalledWith(expect.stringMatching(/\/public\/albums\/album-6$/), expect.objectContaining({ cache: 'no-store' }))
        vi.advanceTimersByTime(5 * 60_000 + 1)
        expect(readCachedPublicAlbum('album-6')).toBeNull()
    })

    it('fetches changing original states again without browser caching or changing the album URL', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ albumId: 'progress', images: [{ id: 'photo', before: { status: 'pending' } }] }))
            .mockResolvedValueOnce(jsonResponse({ albumId: 'progress', images: [{ id: 'photo', before: { status: 'ready' } }] }))
        vi.stubGlobal('fetch', request)

        expect((await fetchAlbum('progress')).images[0].before.status).toBe('pending')
        expect(request.mock.calls[0][1].cache).toBeUndefined()
        expect((await fetchAlbum('progress', null, { force: true })).images[0].before.status).toBe('ready')
        expect(request.mock.calls[1][0]).toBe(request.mock.calls[0][0])
        expect(request.mock.calls[1][1].cache).toBe('no-store')
        expect(readCachedPublicAlbum('progress').images[0].before.status).toBe('ready')
    })

    it('never caches authenticated album data and hides speculative failures', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ albumId: 'private', images: [] }))
            .mockResolvedValueOnce(jsonResponse({ albumId: 'private', images: [] }))
            .mockResolvedValueOnce(new Response('', { status: 404 }))
        vi.stubGlobal('fetch', request)

        await fetchAlbum('private', 'secret-token', { force: true })
        await fetchAlbum('private', 'secret-token')
        expect(request).toHaveBeenNthCalledWith(1, expect.stringMatching(/\/albums\/private$/), expect.objectContaining({
            headers: { Authorization: 'Bearer secret-token' },
            cache: 'no-store',
        }))
        expect(request.mock.calls[1][1].cache).toBeUndefined()
        expect(request).toHaveBeenCalledTimes(2)
        await expect(prefetchPublicAlbum('missing')).resolves.toBeNull()
        expect(request).toHaveBeenCalledTimes(3)
    })
})

describe('album viewing access', () => {
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

    it('shares a public prefetch and its cached result without acquiring a signed-in token', async () => {
        let resolveRequest
        const request = vi.fn(() => new Promise((resolve) => { resolveRequest = resolve }))
        const getIdToken = vi.fn().mockResolvedValue('admin-token')
        vi.stubGlobal('fetch', request)

        const prefetch = prefetchPublicAlbum('public-album')
        const viewing = fetchAlbumForViewing('public-album', getIdToken)
        expect(request).toHaveBeenCalledOnce()
        expect(getIdToken).not.toHaveBeenCalled()
        resolveRequest(jsonResponse({ album: { visibility: 'public' }, images: [] }))

        await expect(viewing).resolves.toBe(await prefetch)
        await expect(fetchAlbumForViewing('public-album', getIdToken)).resolves.toBe(await viewing)
        expect(request).toHaveBeenCalledOnce()
        expect(request.mock.calls[0][0]).toMatch(/\/public\/albums\/public-album$/)
        expect(request.mock.calls[0][1].headers.Authorization).toBeUndefined()
        expect(getIdToken).not.toHaveBeenCalled()
    })

    it('uses the authenticated route for protected albums without caching the private response', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(new Response('', { status: 404 }))
            .mockResolvedValueOnce(jsonResponse({ album: { visibility: 'private' }, images: [] }))
        const getIdToken = vi.fn().mockResolvedValue('owner-token')
        const signal = new AbortController().signal
        vi.stubGlobal('fetch', request)

        await expect(fetchAlbumForViewing('private/id', getIdToken, { signal, force: true }))
            .resolves.toMatchObject({ album: { visibility: 'private' } })
        expect(getIdToken).toHaveBeenCalledOnce()
        expect(request.mock.calls[0][0]).toMatch(/\/public\/albums\/private%2Fid$/)
        expect(request.mock.calls[1]).toEqual([
            expect.stringMatching(/\/albums\/private%2Fid$/),
            expect.objectContaining({ headers: { Authorization: 'Bearer owner-token' }, cache: 'no-store' }),
        ])
        expect(readCachedPublicAlbum('private/id')).toBeNull()
    })

    it.each(['missing', 'rejected', 'empty'])('does not repeat an unauthenticated request when the session is %s', async (session) => {
        const request = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
        const getIdToken = session === 'missing' ? undefined : vi.fn()
        if (session === 'rejected') getIdToken.mockRejectedValue(new Error('No active user session.'))
        if (session === 'empty') getIdToken.mockResolvedValue(null)
        vi.stubGlobal('fetch', request)

        await expect(fetchAlbumForViewing('unavailable', getIdToken)).rejects.toMatchObject({ status: 404 })
        expect(request).toHaveBeenCalledOnce()
    })

    it.each([400, 403, 429, 503, 'network'])('does not retry with authentication after a %s failure', async (status) => {
        vi.useFakeTimers()
        const request = status === 'network'
            ? vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
            : vi.fn(() => Promise.resolve(new Response('', { status })))
        const getIdToken = vi.fn().mockResolvedValue('admin-token')
        vi.stubGlobal('fetch', request)

        const result = expect(fetchAlbumForViewing('album', getIdToken)).rejects.toMatchObject(
            status === 'network' ? { code: 'NETWORK_ERROR' } : { status },
        )
        await vi.runAllTimersAsync()
        await result
        expect(getIdToken).not.toHaveBeenCalled()
        expect(request.mock.calls.every(([url]) => url.endsWith('/public/albums/album'))).toBe(true)
    })

    it('rejects canceled views before reading a cached response or starting a request', async () => {
        const request = vi.fn().mockResolvedValue(jsonResponse({ album: { visibility: 'public' }, images: [] }))
        const getIdToken = vi.fn()
        vi.stubGlobal('fetch', request)
        await prefetchPublicAlbum('cached')
        const controller = new AbortController()
        controller.abort()

        for (const albumId of ['cached', 'uncached']) {
            await expect(fetchAlbumForViewing(albumId, getIdToken, { signal: controller.signal }))
                .rejects.toMatchObject({ name: 'AbortError' })
        }
        expect(request).toHaveBeenCalledOnce()
        expect(getIdToken).not.toHaveBeenCalled()
    })

    it('does not start a protected request if the view is canceled during token acquisition', async () => {
        let resolveToken
        let tokenRequested
        const acquired = new Promise((resolve) => { tokenRequested = resolve })
        const getIdToken = vi.fn(() => {
            tokenRequested()
            return new Promise((resolve) => { resolveToken = resolve })
        })
        const request = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
        vi.stubGlobal('fetch', request)
        const controller = new AbortController()
        const result = fetchAlbumForViewing('private', getIdToken, { signal: controller.signal })

        await acquired
        controller.abort()
        resolveToken('owner-token')
        await expect(result).rejects.toMatchObject({ name: 'AbortError' })
        expect(request).toHaveBeenCalledOnce()
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

    it('uses the edge-cache allowlisted mode and value for a category shuffle', async () => {
        const request = vi.fn().mockResolvedValue(jsonResponse({ images: [], totalPhotos: 0 }))
        vi.stubGlobal('fetch', request)

        await fetchRandomPhotos({ category: 'Birding & Wildlife' })

        expect(request.mock.calls[0][0]).toMatch(
            /\/public\/random-photos\?mode=category&value=Birding\+%26\+Wildlife$/,
        )
    })
})

describe('public Explore API', () => {
    beforeEach(() => {
        clearExploreCache()
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        })
    })

    afterEach(() => {
        clearExploreCache()
        vi.unstubAllGlobals()
    })

    it('encodes color, lens, exposure, time, and season filters and preserves safe pagination', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'blue' }], nextCursor: 'next' }))
            .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'lens' }], nextCursor: null }))
            .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'exposure' }], total: 42, nextCursor: null }))
            .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'time' }], nextCursor: null, seed: '0123456789abcdef' }))
            .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'season' }], nextCursor: null }))
        vi.stubGlobal('fetch', request)

        await expect(fetchExplorePhotos({ mode: 'color', value: 'blue', limit: 12 }))
            .resolves.toMatchObject({ items: [{ id: 'blue' }], nextCursor: 'next' })
        await expect(fetchExplorePhotos({ mode: 'lens', value: 'Sigma 18-50mm', cursor: 'next' }))
            .resolves.toMatchObject({ items: [{ id: 'lens' }] })
        await expect(fetchExplorePhotos({ mode: 'exposure', value: 'aperture:wide' }))
            .resolves.toMatchObject({ items: [{ id: 'exposure' }], total: 42 })
        await expect(fetchExplorePhotos({ mode: 'time', value: 'morning' }))
            .resolves.toMatchObject({ items: [{ id: 'time' }], seed: '0123456789abcdef' })
        await expect(fetchExplorePhotos({ mode: 'season', value: 'autumn' }))
            .resolves.toMatchObject({ items: [{ id: 'season' }] })
        expect(request.mock.calls[0][0]).toContain('mode=color')
        expect(request.mock.calls[0][0]).toContain('limit=12')
        expect(request.mock.calls[1][0]).toContain('cursor=next')
        expect(request.mock.calls[2][0]).toContain('value=aperture%3Awide')
        expect(request.mock.calls[3][0]).toContain('mode=time')
        expect(request.mock.calls[4][0]).toContain('mode=season')
    })

    it('creates safe shuffle seeds and keeps them in the cache key', async () => {
        const request = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ items: [], nextCursor: null })))
        vi.stubGlobal('fetch', request)
        const seed = createExploreSeed()
        expect(seed).toMatch(/^[0-9a-f]{16}$/)

        await fetchExplorePhotos({ mode: 'color', value: 'blue', seed })
        await fetchExplorePhotos({ mode: 'color', value: 'blue', seed: 'fedcba9876543210' })
        expect(request).toHaveBeenCalledTimes(2)
        expect(request.mock.calls[0][0]).toContain(`seed=${seed}`)
        expect(request.mock.calls[1][0]).toContain('seed=fedcba9876543210')
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
        await expect(fetchExplorePhotos({ mode: 'color', value: 'blue', seed: 'unsafe' }))
            .rejects.toMatchObject({ code: 'BAD_EXPLORE_SEED' })
        await expect(fetchExplorePhotos({ mode: 'color', value: 'blue', seed: '0123456789abcdef', cursor: 'next' }))
            .rejects.toMatchObject({ code: 'BAD_EXPLORE_SEED' })
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
            initialPage: null,
        })
    })

    it('keeps only identified, positive color facets', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            items: [
                { id: 'blue', photos: 12 },
                { id: '', photos: 3 },
                { id: 'orange', photos: 0 },
                { id: 'red', photos: 'many' },
            ],
        })))
        await expect(fetchExploreColors()).resolves.toEqual({
            items: [{ id: 'blue', photos: 12 }],
            initialPage: null,
        })
    })

    it('normalizes exposure groups, zero counts, and the bundled first page', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            items: [
                { id: 'aperture', options: [{ id: 'wide', photos: 12 }, { id: 'deep', photos: 0 }] },
                { id: '', options: [] },
                { id: 'broken' },
            ],
            initialPage: {
                value: 'aperture:wide',
                items: [{ mediaId: 'photo-1' }],
                total: 12,
                nextCursor: 'next',
            },
        })))

        await expect(fetchExploreExposures()).resolves.toEqual({
            items: [{
                id: 'aperture',
                options: [{ id: 'wide', photos: 12 }, { id: 'deep', photos: 0 }],
            }],
            initialPage: {
                value: 'aperture:wide',
                items: [{ mediaId: 'photo-1' }],
                total: 12,
                nextCursor: 'next',
            },
        })
    })

    it('normalizes fixed temporal options, zero counts, and bundled shuffle seeds', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(jsonResponse({
                items: [{ id: 'dawn', photos: 0 }, { id: 'morning', photos: 8 }, { id: '', photos: 2 }],
                initialPage: {
                    value: 'morning', items: [{ mediaId: 'photo-1' }], nextCursor: 'next', seed: '0123456789abcdef',
                },
            }))
            .mockResolvedValueOnce(jsonResponse({
                items: [{ id: 'winter', photos: 3 }, { id: 'broken', photos: 'many' }],
            }))
        vi.stubGlobal('fetch', request)

        await expect(fetchExploreTimes()).resolves.toEqual({
            items: [{ id: 'dawn', photos: 0 }, { id: 'morning', photos: 8 }],
            initialPage: {
                value: 'morning', items: [{ mediaId: 'photo-1' }], nextCursor: 'next', seed: '0123456789abcdef',
            },
        })
        await expect(fetchExploreSeasons()).resolves.toEqual({
            items: [{ id: 'winter', photos: 3 }], initialPage: null,
        })
    })

    it('normalizes and caches the bundled initial page', async () => {
        const request = vi.fn().mockResolvedValue(jsonResponse({
            items: [{ id: 'blue', photos: 12 }],
            initialPage: {
                value: 'blue',
                items: [{ mediaId: 'photo-1' }],
                nextCursor: 'next',
            },
        }))
        vi.stubGlobal('fetch', request)

        const first = await fetchExploreColors()
        const second = await fetchExploreColors()

        expect(first.initialPage).toEqual({
            value: 'blue',
            items: [{ mediaId: 'photo-1' }],
            nextCursor: 'next',
        })
        expect(second).toBe(first)
        expect(request).toHaveBeenCalledTimes(1)
    })

    it('supports abortable cached random samples', async () => {
        const request = vi.fn().mockResolvedValue(jsonResponse({ images: [], totalPhotos: 0 }))
        vi.stubGlobal('fetch', request)
        const controller = new AbortController()
        controller.abort()

        await expect(fetchExploreSample({ signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' })
        await expect(fetchExploreSample()).resolves.toMatchObject({ images: [] })
        expect(request).toHaveBeenCalledOnce()
    })

    it('settles an active abort subscriber for both success and failure', async () => {
        const controller = new AbortController()
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ images: [], totalPhotos: 0 })))
        await expect(fetchExploreSample({ signal: controller.signal })).resolves.toMatchObject({ images: [] })

        clearExploreCache()
        vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')))
        await expect(fetchExploreSample({ signal: controller.signal })).rejects.toThrow('Unable to reach the service')
    })

    it('expires cached Explore facets', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const request = vi.fn(() => Promise.resolve(jsonResponse({ items: [{ id: 'blue', photos: 1 }] })))
        vi.stubGlobal('fetch', request)

        await fetchExploreColors()
        vi.advanceTimersByTime(5 * 60_000 + 1)
        await fetchExploreColors()
        expect(request).toHaveBeenCalledTimes(2)
        vi.useRealTimers()
    })

    it('prefetches each module and ignores unusable bundled pages', async () => {
        const request = vi.fn((url) => {
            if (String(url).includes('mode=lenses')) {
                return Promise.resolve(jsonResponse({
                    items: [{ name: 'Lens', photos: 1 }],
                    initialPage: { value: '', items: [{ mediaId: 'ignored' }] },
                }))
            }
            if (String(url).includes('mode=colors')) {
                return Promise.resolve(jsonResponse({ items: [{ id: 'blue', photos: 1 }] }))
            }
            if (String(url).includes('mode=exposures')) {
                return Promise.resolve(jsonResponse({ items: [{ id: 'aperture', options: [] }] }))
            }
            if (String(url).includes('mode=times')) {
                return Promise.resolve(jsonResponse({ items: [{ id: 'morning', photos: 1 }] }))
            }
            if (String(url).includes('mode=seasons')) {
                return Promise.resolve(jsonResponse({ items: [{ id: 'autumn', photos: 1 }] }))
            }
            return Promise.resolve(jsonResponse({ images: [], totalPhotos: 0 }))
        })
        vi.stubGlobal('fetch', request)

        await expect(prefetchExploreModule('lens')).resolves.toMatchObject({ initialPage: null })
        await expect(prefetchExploreModule('color')).resolves.toMatchObject({ items: [{ id: 'blue', photos: 1 }] })
        await expect(prefetchExploreModule('exposure')).resolves.toMatchObject({ items: [{ id: 'aperture', options: [] }] })
        await expect(prefetchExploreModule('time')).resolves.toMatchObject({ items: [{ id: 'morning', photos: 1 }] })
        await expect(prefetchExploreModule('season')).resolves.toMatchObject({ items: [{ id: 'autumn', photos: 1 }] })
        await expect(prefetchExploreModule('sample')).resolves.toMatchObject({ images: [] })
        await expect(prefetchExploreModule('unknown')).rejects.toMatchObject({ code: 'INVALID_EXPLORE_MODE' })
    })
})
