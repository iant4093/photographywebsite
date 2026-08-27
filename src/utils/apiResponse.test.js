import { describe, expect, it } from 'vitest'
import { isSafeCursor, mergeUniqueById, normalizePage } from './apiResponse'

describe('normalizePage', () => {
    it('accepts the legacy array response', () => {
        expect(normalizePage([{ albumId: 'one' }])).toEqual({
            items: [{ albumId: 'one' }],
            nextCursor: null,
        })
    })

    it.each([
        ['nextToken', 'token-a'],
        ['nextCursor', 'token-b'],
        ['cursor', 'token-c'],
        ['paginationToken', 'token-d'],
    ])('accepts a paginated response using %s', (field, value) => {
        expect(normalizePage({ items: [{ albumId: 'one' }], [field]: value })).toEqual({
            items: [{ albumId: 'one' }],
            nextCursor: value,
        })
    })

    it('accepts albums as a transitional item field and safely rejects malformed data', () => {
        expect(normalizePage({ albums: [{ albumId: 'one' }] }).items).toHaveLength(1)
        expect(normalizePage({ items: 'not-an-array' })).toEqual({ items: [], nextCursor: null })
        expect(normalizePage(null)).toEqual({ items: [], nextCursor: null })
    })

    it('preserves a valid server-side total without trusting malformed counts', () => {
        expect(normalizePage({ items: [], total: '42' })).toEqual({
            items: [], nextCursor: null, total: 42,
        })
        expect(normalizePage({ items: [], total: -1 })).toEqual({ items: [], nextCursor: null })
    })
})

describe('mergeUniqueById', () => {
    it('deduplicates albums and keeps the newest copy', () => {
        expect(mergeUniqueById(
            [{ albumId: 'one', title: 'old' }, { albumId: 'two' }],
            [{ albumId: 'one', title: 'new' }, { id: 'three' }],
        )).toEqual([
            { albumId: 'one', title: 'new' },
            { albumId: 'two' },
            { id: 'three' },
        ])
    })
})

describe('isSafeCursor', () => {
    it('only accepts absent or reasonably bounded string cursors', () => {
        expect(isSafeCursor(null)).toBe(true)
        expect(isSafeCursor('opaque-token')).toBe(true)
        expect(isSafeCursor(123)).toBe(false)
        expect(isSafeCursor('x'.repeat(4097))).toBe(false)
    })
})
