import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectExploreMoreAlbums } from './exploreMoreAlbums'

function album(albumId, overrides = {}) {
    return { albumId, category: 'Travel', type: 'photo', visibility: 'public', status: 'active', ...overrides }
}

const current = { albumId: 'current', category: 'Travel', type: 'photo' }
const ids = (albums) => albums.map((item) => item.albumId)
const membership = (albums) => ids(albums).sort()

describe('selectExploreMoreAlbums', () => {
    beforeEach(() => {
        sessionStorage.clear()
        vi.spyOn(Math, 'random').mockReturnValue(0.25)
    })

    afterEach(() => {
        vi.restoreAllMocks()
        sessionStorage.clear()
    })

    it.each([0, 1, 2, 3])('returns all %i available alternatives without including the current album', (count) => {
        const alternatives = Array.from({ length: count }, (_, index) => album(`other-${index}`))

        const selected = selectExploreMoreAlbums([album('current'), ...alternatives], current)

        expect(selected).toHaveLength(count)
        expect(membership(selected)).toEqual(membership(alternatives))
    })

    it('only selects active public photo albums in the same category, including legacy photos', () => {
        const included = [album('photo'), album('legacy', { type: undefined, status: undefined })]
        const excluded = [
            album('current'),
            album('video', { type: 'video' }),
            album('other-category', { category: 'Portraits' }),
            album('no-category', { category: undefined }),
            album('private', { visibility: 'private' }),
            album('unlisted', { visibility: 'unlisted' }),
            album('missing-visibility', { visibility: undefined }),
            album('archived', { status: 'archived' }),
            album('deleted', { status: 'deleted' }),
        ]

        expect(membership(selectExploreMoreAlbums([...excluded, ...included], current)))
            .toEqual(membership(included))
    })

    it('keeps video recommendations separate from photo and legacy albums', () => {
        const video = album('video', { type: 'video' })
        const selected = selectExploreMoreAlbums([
            video,
            album('photo'),
            album('legacy', { type: undefined }),
            album('other-category', { type: 'video', category: 'Portraits' }),
            album('private-video', { type: 'video', visibility: 'private' }),
        ], { ...current, type: 'video' })

        expect(selected).toEqual([video])
    })

    it('groups missing and empty categories with Uncategorized', () => {
        const uncategorized = [
            album('missing', { category: undefined }),
            album('empty', { category: '' }),
            album('explicit', { category: 'Uncategorized' }),
        ]

        expect(membership(selectExploreMoreAlbums([...uncategorized, album('travel')], {
            ...current, category: undefined,
        }))).toEqual(membership(uncategorized))
    })

    it('deduplicates album IDs before applying the three-card limit', () => {
        const alternatives = [album('one'), album('two'), album('three')]
        const selected = selectExploreMoreAlbums([
            alternatives[0], alternatives[0], alternatives[1], alternatives[1], alternatives[2],
        ], current)

        expect(selected).toHaveLength(3)
        expect(membership(selected)).toEqual(['one', 'three', 'two'])
    })

    it('samples three albums using randomness without changing the catalog', () => {
        const catalog = Object.freeze(Array.from({ length: 8 }, (_, index) => Object.freeze(album(`album-${index}`))))
        const originalOrder = ids(catalog)
        vi.mocked(Math.random).mockReturnValue(0)
        const first = selectExploreMoreAlbums(catalog, { ...current, albumId: 'first-visit' })
        vi.mocked(Math.random).mockReturnValue(0.999)
        const second = selectExploreMoreAlbums(catalog, { ...current, albumId: 'separate-visit' })

        expect(first).toHaveLength(3)
        expect(second).toHaveLength(3)
        expect(new Set(ids(first)).size).toBe(3)
        expect(new Set(ids(second)).size).toBe(3)
        expect(membership(first)).not.toEqual(membership(second))
        expect(first.every((item) => catalog.includes(item))).toBe(true)
        expect(second.every((item) => catalog.includes(item))).toBe(true)
        expect(ids(catalog)).toEqual(originalOrder)
    })

    it.each([2, 3])('randomizes card order when only %i alternatives exist', (count) => {
        const catalog = Array.from({ length: count }, (_, index) => album(`album-${index}`))
        vi.mocked(Math.random).mockReturnValue(0)
        const first = selectExploreMoreAlbums(catalog, { ...current, albumId: 'small-first' })
        vi.mocked(Math.random).mockReturnValue(0.999)
        const second = selectExploreMoreAlbums(catalog, { ...current, albumId: 'small-second' })

        expect(membership(first)).toEqual(membership(second))
        expect(ids(first)).not.toEqual(ids(second))
    })

    it('avoids repeating the same three albums on consecutive visits even if randomness repeats', () => {
        const catalog = Array.from({ length: 4 }, (_, index) => album(`album-${index}`))
        vi.mocked(Math.random).mockReturnValue(0.5)
        let previous = selectExploreMoreAlbums(catalog, current)

        for (let visit = 0; visit < 4; visit += 1) {
            const selected = selectExploreMoreAlbums(catalog, current)
            expect(selected).toHaveLength(3)
            expect(new Set(ids(selected)).size).toBe(3)
            expect(membership(selected)).not.toEqual(membership(previous))
            previous = selected
        }
    })

    it('remembers the previous selection across module reloads in the same tab', async () => {
        const catalog = Array.from({ length: 5 }, (_, index) => album(`album-${index}`))
        const first = selectExploreMoreAlbums(catalog, current)
        vi.resetModules()
        const reloaded = await import('./exploreMoreAlbums')
        const second = reloaded.selectExploreMoreAlbums(catalog, current)

        expect(second).toHaveLength(3)
        expect(membership(second)).not.toEqual(membership(first))
    })

    it.each(['getItem', 'setItem'])('still returns recommendations when session storage %s is blocked', (method) => {
        vi.spyOn(Storage.prototype, method).mockImplementation(() => {
            throw new Error('Storage unavailable')
        })
        const catalog = Array.from({ length: 5 }, (_, index) => album(`album-${index}`))

        const selected = selectExploreMoreAlbums(catalog, current)

        expect(selected).toHaveLength(3)
        expect(new Set(ids(selected)).size).toBe(3)
        expect(selected.every((item) => catalog.includes(item))).toBe(true)
    })
})
