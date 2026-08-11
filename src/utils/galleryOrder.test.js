import { describe, expect, it } from 'vitest'

import { sortGalleryAlbums } from './galleryOrder'

describe('gallery ordering', () => {
  it('defaults to natural alphabetical order with a stable id tiebreaker', () => {
    const albums = [
      { albumId: 'b', title: 'Album 10' },
      { albumId: 'c', title: 'album 2' },
      { albumId: 'a', title: 'Album 2' },
    ]
    expect(sortGalleryAlbums(albums).map((album) => album.albumId)).toEqual(['a', 'c', 'b'])
    expect(albums.map((album) => album.albumId)).toEqual(['b', 'c', 'a'])
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
})
