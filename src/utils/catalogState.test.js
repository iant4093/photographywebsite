import { describe, expect, it } from 'vitest'
import { loadCompleteCatalog } from './catalogState'

describe('loadCompleteCatalog', () => {
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
})
