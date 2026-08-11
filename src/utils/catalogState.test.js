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

describe('loadCompleteCatalog', () => {
    afterEach(() => {
        clearCatalogSnapshots()
        vi.useRealTimers()
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
                ownerEmail: 'must-not-persist@example.test',
                rawKey: 'must-not-persist',
            }],
            nextCursor: null,
        })

        const stored = JSON.parse(sessionStorage.getItem('ian:public-catalog:v2:public-photos'))
        expect(stored).toMatchObject({
            version: 2,
            items: [{ albumId: 'album-one', title: 'Visible', visibility: 'public' }],
            nextCursor: null,
        })
        expect(stored.items[0]).not.toHaveProperty('ownerEmail')
        expect(stored.items[0]).not.toHaveProperty('rawKey')

        // Clearing only memory is intentionally unavailable: deletion removes
        // the persisted copy too, preventing stale data from being resurrected.
        deleteCatalogSnapshot('public-photos')
        expect(sessionStorage.getItem('ian:public-catalog:v2:public-photos')).toBeNull()
    })

    it('hydrates a valid tab snapshot and rejects malformed persisted state', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        sessionStorage.setItem('ian:public-catalog:v2:public-videos', JSON.stringify({
            version: 2,
            savedAt: Date.now(),
            nextCursor: null,
            items: [{ albumId: 'video-one', title: 'Film', ownerEmail: 'discard@example.test' }],
        }))
        expect(getCatalogSnapshot('public-videos')).toMatchObject({
            items: [{ albumId: 'video-one', title: 'Film' }],
            stale: false,
        })
        expect(getCatalogSnapshot('public-videos').items[0]).not.toHaveProperty('ownerEmail')

        sessionStorage.setItem('ian:public-catalog:v2:public-photos', '{bad-json')
        expect(getCatalogSnapshot('public-photos')).toBeNull()
        expect(sessionStorage.getItem('ian:public-catalog:v2:public-photos')).toBeNull()
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
