import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    clearCatalogSnapshots,
    deleteCatalogSnapshot,
    getCatalogSnapshot,
    invalidateCatalogSnapshots,
    loadCompleteCatalog,
    reconcilePublicCatalogItems,
    recordPublicCatalogDeletion,
    recordPublicCatalogUpsert,
    setCatalogSnapshot,
} from './catalogState'
import { sortGalleryAlbums, sortGalleryCategories } from './galleryOrder'

describe('loadCompleteCatalog', () => {
    afterEach(() => {
        clearCatalogSnapshots()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('stores, marks stale, expires, deletes, and clears catalog snapshots', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        setCatalogSnapshot('one', { items: [{ albumId: 'one' }], nextCursor: null })
        expect(getCatalogSnapshot('one')).toMatchObject({ items: [{ albumId: 'one' }], savedAt: Date.now() })
        expect(getCatalogSnapshot('one').stale).toBe(false)
        deleteCatalogSnapshot('one')
        expect(getCatalogSnapshot('one')).toBeNull()
        setCatalogSnapshot('old', { items: [] })
        vi.advanceTimersByTime(5 * 60_000 + 1)
        expect(getCatalogSnapshot('old')).toMatchObject({ items: [], stale: true })
        vi.advanceTimersByTime(25 * 60_000)
        expect(getCatalogSnapshot('old')).toBeNull()
        setCatalogSnapshot('clear', { items: [] })
        clearCatalogSnapshots()
        expect(getCatalogSnapshot('clear')).toBeNull()
    })

    it('persists only bounded public catalog DTO fields for tab reloads', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        sessionStorage.clear()
        setCatalogSnapshot('public-photos', {
            items: [{
                albumId: 'album-one',
                title: 'Visible',
                visibility: 'public',
                uploadedAt: '2025-12-31T20:00:00Z',
                coverHlsUrl: 'https://media.test/cover.m3u8',
                coverThumbnailTime: 4.5,
                ownerEmail: 'must-not-persist@example.test',
                rawKey: 'must-not-persist',
            }],
            nextCursor: null,
        })

        window.dispatchEvent(new Event('pagehide'))
        const stored = JSON.parse(sessionStorage.getItem('ian:public-catalog:v6:public-photos'))
        expect(stored).toMatchObject({
            version: 6,
            items: [{
                albumId: 'album-one',
                title: 'Visible',
                visibility: 'public',
                uploadedAt: '2025-12-31T20:00:00Z',
                coverHlsUrl: 'https://media.test/cover.m3u8',
                coverThumbnailTime: 4.5,
            }],
            nextCursor: null,
        })
        expect(stored.items[0]).not.toHaveProperty('ownerEmail')
        expect(stored.items[0]).not.toHaveProperty('rawKey')

        // Clearing only memory is intentionally unavailable: deletion removes
        // the persisted copy too, preventing stale data from being resurrected.
        deleteCatalogSnapshot('public-photos')
        expect(sessionStorage.getItem('ian:public-catalog:v6:public-photos')).toBeNull()
    })

    it('hydrates a valid tab snapshot and rejects malformed persisted state', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        sessionStorage.setItem('ian:public-catalog:v6:public-videos', JSON.stringify({
            version: 6,
            savedAt: Date.now(),
            nextCursor: null,
            items: [{ albumId: 'video-one', title: 'Film', ownerEmail: 'discard@example.test' }],
        }))
        expect(getCatalogSnapshot('public-videos')).toMatchObject({
            items: [{ albumId: 'video-one', title: 'Film' }],
            stale: false,
        })
        expect(getCatalogSnapshot('public-videos').items[0]).not.toHaveProperty('ownerEmail')

        sessionStorage.setItem('ian:public-catalog:v6:public-photos', '{bad-json')
        expect(getCatalogSnapshot('public-photos')).toBeNull()
        expect(sessionStorage.getItem('ian:public-catalog:v6:public-photos')).toBeNull()
    })

    it('preserves lightweight photo preview metadata through a tab reload', () => {
        const album = {
            albumId: 'album-one', visibility: 'public', title: 'Photos',
            hoverPreviewStatus: 'ready', hoverPreviewVersion: 'a'.repeat(24),
            hoverPreviewManifestUrl: 'https://media.test/public-previews/album-one/hover.json',
        }
        setCatalogSnapshot('public-photos', { items: [album], nextCursor: null })
        window.dispatchEvent(new Event('pagehide'))
        const persisted = sessionStorage.getItem('ian:public-catalog:v6:public-photos')
        deleteCatalogSnapshot('public-photos')
        sessionStorage.setItem('ian:public-catalog:v6:public-photos', persisted)
        expect(getCatalogSnapshot('public-photos').items).toEqual([album])
    })

    it('coalesces persistence during idle time while memory stays immediately current', () => {
        let idle
        vi.stubGlobal('requestIdleCallback', vi.fn(callback => { idle = callback; return 7 }))
        vi.stubGlobal('cancelIdleCallback', vi.fn())
        const setItem = vi.spyOn(sessionStorage, 'setItem')
        const first = { items: [{ albumId: 'one' }], nextCursor: 'two' }
        const final = { items: [{ albumId: 'one' }, { albumId: 'two' }], nextCursor: null }
        setCatalogSnapshot('public-photos', first)
        setCatalogSnapshot('public-photos', final)
        expect(getCatalogSnapshot('public-photos').items).toBe(final.items)
        expect(setItem).not.toHaveBeenCalled()
        expect(window.requestIdleCallback).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 1000 })
        idle()
        expect(setItem).toHaveBeenCalledOnce()
        expect(JSON.parse(setItem.mock.calls[0][1]).items).toHaveLength(2)
    })

    it('flushes before backgrounding and never resurrects invalidated snapshots from queued writes', () => {
        let idle
        vi.stubGlobal('requestIdleCallback', callback => { idle = callback; return 3 })
        vi.stubGlobal('cancelIdleCallback', vi.fn())
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
        setCatalogSnapshot('public-photos', { items: [{ albumId: 'one' }] })
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
        document.dispatchEvent(new Event('visibilitychange'))
        expect(sessionStorage.getItem('ian:public-catalog:v6:public-photos')).not.toBeNull()
        expect(window.cancelIdleCallback).toHaveBeenCalledWith(3)
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
        setCatalogSnapshot('public-photos', { items: [{ albumId: 'private-now' }] })
        invalidateCatalogSnapshots()
        idle()
        window.dispatchEvent(new Event('pagehide'))
        expect(sessionStorage.getItem('ian:public-catalog:v6:public-photos')).toBeNull()
    })

    it('keeps other pending catalogs when one is deleted and falls back when idle scheduling is unavailable', () => {
        vi.useFakeTimers()
        vi.stubGlobal('requestIdleCallback', undefined)
        setCatalogSnapshot('public-photos', { items: [{ albumId: 'one' }] })
        setCatalogSnapshot('public-videos', { items: [{ albumId: 'video' }] })
        deleteCatalogSnapshot('public-photos')
        vi.advanceTimersByTime(149)
        expect(sessionStorage.getItem('ian:public-catalog:v6:public-videos')).toBeNull()
        vi.advanceTimersByTime(1)
        expect(sessionStorage.getItem('ian:public-catalog:v6:public-photos')).toBeNull()
        expect(JSON.parse(sessionStorage.getItem('ian:public-catalog:v6:public-videos')).items[0].albumId).toBe('video')
        expect(vi.getTimerCount()).toBe(0)
    })

    it('retains a usable memory snapshot if background storage is unavailable or the catalog is too large', () => {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
        vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
        const items = [{ albumId: 'one' }]
        expect(() => setCatalogSnapshot('public-photos', { items })).not.toThrow()
        expect(getCatalogSnapshot('public-photos').items).toBe(items)
        const large = Array.from({ length: 501 }, (_, index) => ({ albumId: String(index) }))
        setCatalogSnapshot('public-videos', { items: large })
        expect(getCatalogSnapshot('public-videos').items).toBe(large)
        expect(sessionStorage.getItem('ian:public-catalog:v6:public-videos')).toBeNull()
    })

    it('ignores older snapshots that may have lost gallery order so the page refetches the catalog', () => {
        sessionStorage.setItem('ian:public-catalog:v5:public-photos', JSON.stringify({
            version: 5, savedAt: Date.now(), nextCursor: null,
            items: [{ albumId: 'old', visibility: 'public' }],
        }))
        try {
            expect(getCatalogSnapshot('public-photos')).toBeNull()
        } finally {
            sessionStorage.removeItem('ian:public-catalog:v5:public-photos')
        }
    })

    it('reconciles recent public mutations over a stale edge catalog', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const staleItems = [
            { albumId: 'old-photo', type: 'photo', visibility: 'public', title: 'Old', createdAt: '2025-01-01' },
            { albumId: 'old-video', type: 'video', visibility: 'public', title: 'Video', createdAt: '2025-01-02' },
        ]

        setCatalogSnapshot('public-photos', { items: staleItems, nextCursor: null })
        recordPublicCatalogUpsert({
            albumId: 'new-photo',
            type: 'photo',
            visibility: 'public',
            title: 'New',
            createdAt: '2026-01-01',
            ownerEmail: 'must-not-be-cached@example.test',
            s3Prefix: 'must-not-be-cached/',
        })
        expect(getCatalogSnapshot('public-photos')).toBeNull()
        const reconciledPhotos = reconcilePublicCatalogItems(staleItems, 'photo')
        expect(reconciledPhotos.map((album) => album.albumId))
            .toEqual(['new-photo', 'old-photo'])
        expect(reconciledPhotos[0]).not.toHaveProperty('ownerEmail')
        expect(reconciledPhotos[0]).not.toHaveProperty('s3Prefix')
        expect(reconcilePublicCatalogItems(staleItems, 'video').map((album) => album.albumId))
            .toEqual(['old-video'])

        recordPublicCatalogUpsert({
            albumId: 'old-photo',
            type: 'photo',
            visibility: 'private',
            title: 'Old',
            createdAt: '2025-01-01',
        })
        recordPublicCatalogDeletion('old-video')
        expect(reconcilePublicCatalogItems(staleItems, 'photo').map((album) => album.albumId))
            .toEqual(['new-photo'])
        expect(reconcilePublicCatalogItems(staleItems, 'video')).toEqual([])
    })

    it('preserves curated sections and album positions after a new album is edited or uploaded', () => {
        const items = [
            { albumId: 'misty', type: 'photo', visibility: 'public', category: 'Misty', galleryCategoryOrder: 4 },
            { albumId: 'prague', type: 'photo', visibility: 'public', category: 'Prague 2026', galleryCategoryOrder: 5, galleryOrder: 0 },
            { albumId: 'prague-two', type: 'photo', visibility: 'public', category: 'Prague 2026', galleryOrder: 1 },
            { albumId: 'spain', type: 'photo', visibility: 'public', category: 'Spain 2026', galleryCategoryOrder: 6 },
        ]
        // Create/edit responses omit the independently stored gallery settings.
        recordPublicCatalogUpsert({ albumId: 'prague', type: 'photo', visibility: 'public', category: 'Prague 2026', title: 'Updated title' })
        // Uploading invalidates the snapshot but keeps the recent mutation.
        invalidateCatalogSnapshots()
        const reconciled = reconcilePublicCatalogItems(items, 'photo')
        const grouped = Object.groupBy(reconciled, album => album.category)
        expect(sortGalleryCategories(Object.keys(grouped), grouped)).toEqual(['Misty', 'Prague 2026', 'Spain 2026'])
        expect(sortGalleryAlbums(grouped['Prague 2026']).map(album => album.albumId)).toEqual(['prague', 'prague-two'])
        expect(reconciled.find(album => album.albumId === 'prague')).toMatchObject({ title: 'Updated title', galleryCategoryOrder: 5, galleryOrder: 0 })
        // A later arrangement must win over any positions on an older overlay.
        recordPublicCatalogUpsert({ ...items[1], title: 'Another edit' })
        expect(reconcilePublicCatalogItems([{ ...items[1], galleryOrder: 3, galleryCategoryOrder: 2 }], 'photo')[0])
            .toMatchObject({ galleryOrder: 3, galleryCategoryOrder: 2 })
    })

    it('does not carry an old category position into a renamed or moved section', () => {
        recordPublicCatalogUpsert({ albumId: 'album', type: 'photo', visibility: 'public', category: 'New section' })
        const items = [{ albumId: 'album', type: 'photo', visibility: 'public', category: 'Old section', galleryCategoryOrder: 1, galleryOrder: 2 }]
        const [result] = reconcilePublicCatalogItems(items, 'photo')
        expect(result).toMatchObject({ category: 'New section', galleryOrder: 2 })
        expect(result).not.toHaveProperty('galleryCategoryOrder')
    })

    it('expires mutation overlays and distinguishes invalidation from logout clearing', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const created = {
            albumId: 'created', type: 'photo', visibility: 'public', createdAt: '2026-01-01',
        }
        recordPublicCatalogUpsert(created)
        setCatalogSnapshot('public-photos', { items: [created], nextCursor: null })
        invalidateCatalogSnapshots()
        expect(getCatalogSnapshot('public-photos')).toBeNull()
        expect(reconcilePublicCatalogItems([], 'photo')).toEqual([created])

        vi.advanceTimersByTime(10 * 60_000 + 1)
        expect(reconcilePublicCatalogItems([], 'photo')).toEqual([])

        recordPublicCatalogUpsert(created)
        clearCatalogSnapshots()
        expect(reconcilePublicCatalogItems([], 'photo')).toEqual([])
    })

    it('requires a page loader and honors a signal aborted before the first request', async () => {
        await expect(loadCompleteCatalog({})).rejects.toThrow('fetchPage must be a function')
        const controller = new AbortController()
        controller.abort()
        await expect(loadCompleteCatalog({ fetchPage: vi.fn(), signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' })
    })
    it('automatically exhausts every page and deduplicates albums', async () => {
        const fetchPage = async (cursor) => {
            if (cursor === null) {
                return {
                    items: [{ albumId: 'one' }, { albumId: 'two', title: 'old' }],
                    nextCursor: 'page-two',
                }
            }
            return {
                items: [{ albumId: 'two', title: 'new' }, { albumId: 'three' }],
                nextCursor: null,
            }
        }
        const snapshots = []

        const result = await loadCompleteCatalog({
            fetchPage,
            onPage: (snapshot) => snapshots.push(snapshot),
        })

        expect(result).toEqual({
            items: [
                { albumId: 'one' },
                { albumId: 'two', title: 'new' },
                { albumId: 'three' },
            ],
            nextCursor: null,
        })
        expect(snapshots).toHaveLength(2)
        expect(snapshots[0].nextCursor).toBe('page-two')
    })

    it('batches rapid pages without mutating earlier snapshots or losing updated albums', async () => {
        const fetchPage = vi.fn()
            .mockResolvedValueOnce({ items: [{ albumId: 'one', title: 'old' }], nextCursor: 'two' })
            .mockResolvedValueOnce({ items: [{ albumId: 'one', title: 'new' }, { albumId: 'two' }], nextCursor: 'three' })
            .mockResolvedValueOnce({ items: [{ albumId: 'three' }], nextCursor: null })
        const onPage = vi.fn()
        const result = await loadCompleteCatalog({ fetchPage, onPage, publishIntervalMs: 100 })
        expect(onPage).toHaveBeenCalledTimes(2)
        expect(onPage.mock.calls[0][0].items).toEqual([{ albumId: 'one', title: 'old' }])
        expect(result.items).toEqual([{ albumId: 'one', title: 'new' }, { albumId: 'two' }, { albumId: 'three' }])
        expect(onPage.mock.calls[1][0]).toBe(result)
    })

    it('publishes a buffered page promptly while a later network request is slow', async () => {
        vi.useFakeTimers()
        let finish
        const fetchPage = vi.fn()
            .mockResolvedValueOnce({ items: [{ albumId: 'one' }], nextCursor: 'two' })
            .mockResolvedValueOnce({ items: [{ albumId: 'two' }], nextCursor: 'three' })
            .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        const onPage = vi.fn()
        const result = loadCompleteCatalog({ fetchPage, onPage, publishIntervalMs: 100 })
        await vi.advanceTimersByTimeAsync(99)
        expect(onPage).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(onPage.mock.calls[1][0].items).toHaveLength(2)
        finish({ items: [{ albumId: 'three' }], nextCursor: null })
        await result
        expect(onPage).toHaveBeenCalledTimes(3)
        expect(vi.getTimerCount()).toBe(0)
        vi.useRealTimers()
    })

    it('flushes received pages on network failure and cancels deferred publication on abort', async () => {
        const onPage = vi.fn()
        const failure = new Error('offline')
        await expect(loadCompleteCatalog({
            publishIntervalMs: 100,
            onPage,
            fetchPage: vi.fn()
                .mockResolvedValueOnce({ items: [{ albumId: 'one' }], nextCursor: 'two' })
                .mockResolvedValueOnce({ items: [{ albumId: 'two' }], nextCursor: 'three' })
                .mockRejectedValueOnce(failure),
        })).rejects.toBe(failure)
        expect(onPage.mock.calls[1][0]).toMatchObject({ items: [{ albumId: 'one' }, { albumId: 'two' }], nextCursor: 'three' })

        vi.useFakeTimers()
        const controller = new AbortController()
        const publish = vi.fn()
        const result = loadCompleteCatalog({
            publishIntervalMs: 100, onPage: publish, signal: controller.signal,
            fetchPage: vi.fn()
                .mockResolvedValueOnce({ items: [{ albumId: 'one' }], nextCursor: 'two' })
                .mockResolvedValueOnce({ items: [{ albumId: 'two' }], nextCursor: 'three' })
                .mockImplementationOnce(async () => { controller.abort(); return { items: [], nextCursor: null } }),
        })
        await expect(result).rejects.toMatchObject({ name: 'AbortError' })
        await vi.runAllTimersAsync()
        expect(publish).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
        vi.useRealTimers()
    })

    it('resumes an incomplete cached catalog from its next cursor', async () => {
        const requestedCursors = []
        const result = await loadCompleteCatalog({
            fetchPage: async (cursor) => {
                requestedCursors.push(cursor)
                return { items: [{ albumId: 'two' }], nextCursor: null }
            },
            initialItems: [{ albumId: 'one' }],
            initialCursor: 'resume-here',
            hasInitialPage: true,
        })

        expect(requestedCursors).toEqual(['resume-here'])
        expect(result.items.map((album) => album.albumId)).toEqual(['one', 'two'])
    })

    it('continues through an empty page when it still has a cursor', async () => {
        const requestedCursors = []
        const result = await loadCompleteCatalog({
            fetchPage: async (cursor) => {
                requestedCursors.push(cursor)
                if (cursor === null) return { items: [], nextCursor: 'last-page' }
                return { items: [{ albumId: 'only-on-final-page' }], nextCursor: null }
            },
        })

        expect(requestedCursors).toEqual([null, 'last-page'])
        expect(result.items).toEqual([{ albumId: 'only-on-final-page' }])
    })

    it('uses a complete cached catalog without another request', async () => {
        let requestCount = 0
        const result = await loadCompleteCatalog({
            fetchPage: async () => {
                requestCount += 1
                return { items: [], nextCursor: null }
            },
            initialItems: [{ albumId: 'one' }],
            initialCursor: null,
            hasInitialPage: true,
        })

        expect(requestCount).toBe(0)
        expect(result.items).toEqual([{ albumId: 'one' }])
    })

    it('rejects a repeated cursor instead of looping forever', async () => {
        const fetchPage = async () => ({ items: [{ albumId: 'one' }], nextCursor: 'repeat' })

        await expect(loadCompleteCatalog({ fetchPage })).rejects.toThrow('invalid pagination sequence')
    })

    it('rejects malformed cursors before requesting another page', async () => {
        let requestCount = 0
        const fetchPage = async () => {
            requestCount += 1
            return { items: [{ albumId: 'one' }], nextCursor: 123 }
        }

        await expect(loadCompleteCatalog({ fetchPage })).rejects.toMatchObject({ code: 'BAD_CURSOR' })
        expect(requestCount).toBe(1)
    })

    it('honors cancellation even when a page fetch resolves after abort', async () => {
        const controller = new AbortController()
        const result = loadCompleteCatalog({
            fetchPage: async () => {
                controller.abort()
                return { items: [{ albumId: 'one' }], nextCursor: null }
            },
            signal: controller.signal,
        })

        await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('stops catalogs that exceed the 100-page safety limit', async () => {
        let page = 0
        await expect(loadCompleteCatalog({
            fetchPage: async () => ({ items: [], nextCursor: `page-${++page}` }),
        })).rejects.toMatchObject({ code: 'PAGE_LIMIT' })
        expect(page).toBe(100)
    })
})
