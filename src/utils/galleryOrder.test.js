import { describe, expect, it } from 'vitest'

import { sortGalleryAlbums, sortGalleryCategories } from './galleryOrder'

describe('gallery ordering', () => {
  it('defaults to newest-first chronology with stable title and id tiebreakers', () => {
    const albums = [
      { albumId: 'old', title: 'Old', createdAt: '2025-01-01T00:00:00Z' },
      { albumId: 'b', title: 'Album 10', createdAt: '2026-01-01T00:00:00Z' },
      { albumId: 'c', title: 'album 2', createdAt: '2026-01-01T00:00:00Z' },
      { albumId: 'a', title: 'Album 2', createdAt: '2026-01-01T00:00:00Z' },
    ]
    expect(sortGalleryAlbums(albums).map((album) => album.albumId)).toEqual(['a', 'c', 'b', 'old'])
    expect(albums.map((album) => album.albumId)).toEqual(['old', 'b', 'c', 'a'])
  })

  it('places configured albums first and leaves unconfigured albums alphabetical', () => {
    const albums = [
      { albumId: 'b', title: 'Beta' },
      { albumId: 'c', title: 'Charlie', galleryOrder: 0 },
      { albumId: 'a', title: 'Alpha' },
      { albumId: 'd', title: 'Delta', galleryOrder: 1 },
    ]
    expect(sortGalleryAlbums(albums).map((album) => album.albumId)).toEqual(['c', 'd', 'a', 'b'])
  })

  it('defaults categories alphabetically but honors configured category positions', () => {
    const grouped = {
      Hikes: [{ galleryCategoryOrder: 0 }],
      Astro: [{ galleryCategoryOrder: 1 }],
      Uncategorized: [{}],
    }
    expect(sortGalleryCategories(['Astro', 'Uncategorized', 'Hikes'], grouped))
      .toEqual(['Hikes', 'Astro', 'Uncategorized'])
    expect(sortGalleryCategories(['Hikes', 'Uncategorized', 'Astro'], {
      Hikes: [{}], Astro: [{}], Uncategorized: [{}],
    })).toEqual(['Astro', 'Hikes', 'Uncategorized'])
  })
})
