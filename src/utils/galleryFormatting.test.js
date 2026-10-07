import { describe, expect, it } from 'vitest'
import { compareGalleryTitles, formatAlbumDate } from './galleryFormatting'

describe('gallery formatting compatibility', () => {
    it.each([
        '2026-01-01', '2026-03-08T09:59:00Z', '2026-03-08T10:01:00Z',
        '2026-11-01T08:59:00Z', '2026-11-01T09:01:00Z', '2024-02-29T12:00:00Z',
        'not-a-date', '2026-10-06T00:01:00Z',
    ])('preserves the existing visitor date text for %s', value => {
        expect(formatAlbumDate(value)).toBe(new Date(value).toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric',
        }))
    })

    it('preserves numeric, accented and case-insensitive title ordering', () => {
        const titles = ['Album 10', 'album 2', 'Álbum 2', 'Album 02', 'Été', 'été', '山', '', 'Uncategorized']
        expect([...titles].sort(compareGalleryTitles)).toEqual([...titles].sort((left, right) => (
            left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
        )))
    })
})
