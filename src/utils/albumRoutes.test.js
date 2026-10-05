import { describe, expect, it } from 'vitest'
import { albumHandle, albumPath, isAlbumId, isAlbumSlug } from './albumRoutes'

const ID = '11111111-1111-4111-8111-111111111111'

describe('album routes', () => {
    it('tells ids from slugs', () => {
        expect(isAlbumId(ID)).toBe(true)
        expect(isAlbumId('prague')).toBe(false)
        expect(isAlbumSlug('prague-2026')).toBe(true)
        for (const value of [ID, 'Prague', 'prague--2', '-prague', 'prague 2', '', null, 'a'.repeat(81)]) {
            expect(isAlbumSlug(value)).toBe(false)
        }
    })

    it('links to the slug when there is one, else the id', () => {
        expect(albumHandle({ albumId: ID, slug: 'prague-2' })).toBe('prague-2')
        expect(albumHandle({ albumId: ID, slug: 'Bad Slug' })).toBe(ID)
        expect(albumHandle(null)).toBe('')
        expect(albumPath({ albumId: ID, slug: 'prague' })).toBe('/album/prague')
        expect(albumPath({ albumId: ID, type: 'video', imageCount: 3 })).toBe(`/video/${ID}`)
        expect(albumPath({ albumId: ID, slug: 'reel', type: 'video', imageCount: 1 })).toBe('/video/reel?play=1')
        expect(albumPath({ albumId: ID, slug: 'reel', type: 'video', imageCount: 1 }, { play: false })).toBe('/video/reel')
    })
})
