import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  fetchAlbumsFilteredPage: vi.fn(), fetchAllAlbums: vi.fn(), readCachedAlbumsPage: vi.fn(), listUsersPage: vi.fn(), updateAlbum: vi.fn(), updateGalleryOrder: vi.fn(), deleteAlbum: vi.fn(), deleteImages: vi.fn(),
  requestUploadUrl: vi.fn(), uploadFileToS3: vi.fn(), fetchAlbumMediaPage: vi.fn(), addImagesToAlbum: vi.fn(), updateImageThumbnail: vi.fn(),
}))
const auth = vi.hoisted(() => ({ getIdToken: vi.fn() }))
const media = vi.hoisted(() => ({ processImage: vi.fn(), processVideo: vi.fn(), extractFrameFromVideoElement: vi.fn() }))

vi.mock('../context/auth', () => ({ useAuth: () => auth }))
vi.mock('../utils/api', () => api)
vi.mock('../utils/mediaUtils', () => media)
vi.mock('../utils/mediaUrls', () => ({ mediaDisplayUrl: (item) => item.url || item.rawKey, mediaThumbnailUrl: (item) => item.thumbnailUrl || item.thumbKey }))
vi.mock('../utils/concurrency', () => ({ mapWithConcurrency: async (items, _limit, mapper) => Promise.all(items.map(mapper)) }))

import ManageAlbums from './ManageAlbums'

const albums = [
  { albumId: 'photo', title: 'Summer', description: 'A trip', category: 'Travel', type: 'photo', ownerEmail: 'client@example.com', createdAt: '2026-06-01T12:00:00.000Z', s3Prefix: 'albums/photo/', coverImageUrl: 'https://cdn.test/albums/photo/raw.jpg', coverThumbKey: 'albums/photo/thumb.jpg' },
  { albumId: 'uncat', title: 'Loose Photos', type: 'photo', ownerEmail: 'client@example.com', createdAt: '2026-05-01T12:00:00.000Z' },
  { albumId: 'other', title: 'Other Client', type: 'photo', ownerEmail: 'other@example.com', createdAt: '2026-04-01T12:00:00.000Z' },
  { albumId: 'video', title: 'Film', category: 'Video', type: 'video', ownerEmail: 'client@example.com', createdAt: '2026-03-01T12:00:00.000Z' },
]

function mounted(entry = '/admin/albums') {
  return render(<MemoryRouter initialEntries={[entry]}><ManageAlbums /></MemoryRouter>)
}

describe('ManageAlbums', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.getIdToken.mockResolvedValue('admin-token')
    api.listUsersPage.mockResolvedValue({ users: [{ email: 'client@example.com', sub: '11111111-1111-4111-8111-111111111111' }, { email: 'other@example.com', sub: '22222222-2222-4222-8222-222222222222' }], nextCursor: null })
    api.fetchAlbumsFilteredPage.mockResolvedValue({ items: albums, nextCursor: null })
    api.fetchAllAlbums.mockResolvedValue(albums)
    api.readCachedAlbumsPage.mockReturnValue(null)
    api.updateAlbum.mockResolvedValue({})
    api.updateGalleryOrder.mockResolvedValue({})
    api.deleteAlbum.mockResolvedValue({})
    api.fetchAlbumMediaPage.mockResolvedValue({ album: null, items: [], nextCursor: null })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('loads, type-filters, groups, and switches among public, link-only, and private scopes', async () => {
    mounted()
    expect(screen.getByText('Manage Photo Albums')).toBeInTheDocument()
    expect(await screen.findByText('Summer')).toBeInTheDocument()
    expect(screen.getByText('Loose Photos')).toBeInTheDocument()
    expect(screen.queryByText('Film')).toBeNull()
    expect(screen.getByText('Travel')).toBeInTheDocument()
    expect(screen.getByText('Uncategorized')).toBeInTheDocument()
    expect(api.fetchAlbumsFilteredPage).toHaveBeenCalledWith(
      { type: 'photo', limit: 40, visibility: 'public' },
      'admin-token',
      expect.objectContaining({ signal: expect.any(AbortSignal), force: false }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Link Only' }))
    await waitFor(() => expect(api.fetchAlbumsFilteredPage).toHaveBeenCalledWith(
      { type: 'photo', limit: 40, visibility: 'unlisted' },
      'admin-token',
      expect.objectContaining({ signal: expect.any(AbortSignal), force: false }),
    ))

    fireEvent.change(screen.getByPlaceholderText('Search users…'), { target: { value: 'client@' } })
    fireEvent.click(await screen.findByRole('button', { name: 'client@example.com' }))
    expect(await screen.findByText('Viewing albums for: client@example.com')).toBeInTheDocument()
    await waitFor(() => expect(api.fetchAlbumsFilteredPage).toHaveBeenCalledWith(
      { type: 'photo', limit: 40, visibility: 'private', ownerSub: '11111111-1111-4111-8111-111111111111' },
      'admin-token',
      expect.objectContaining({ signal: expect.any(AbortSignal), force: false }),
    ))
    expect(screen.queryByText('Other Client')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('Search users…'), { target: { value: 'missing' } })
    expect(screen.getByText('No users found')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Main Gallery' }))
    await waitFor(() => expect(api.fetchAlbumsFilteredPage).toHaveBeenLastCalledWith(
      { type: 'photo', limit: 40, visibility: 'public' },
      'admin-token',
      expect.objectContaining({ signal: expect.any(AbortSignal), force: false }),
    ))
  })

  it('persists main-gallery photo order within a category and hides controls elsewhere', async () => {
    api.fetchAlbumsFilteredPage.mockResolvedValue({ items: [
      { ...albums[0], albumId: 'z-album', title: 'Zulu', galleryOrder: 1 },
      { ...albums[0], albumId: 'a-album', title: 'Alpha', galleryOrder: 0 },
    ], nextCursor: null })
    mounted()
    await screen.findByText('Alpha')
    const titlesBefore = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(titlesBefore).toEqual(['Alpha', 'Zulu'])

    fireEvent.click(screen.getByRole('button', { name: 'Arrange Gallery' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move Zulu earlier' }))
    await waitFor(() => expect(api.updateGalleryOrder).toHaveBeenCalledWith(
      'admin-token', { albumType: 'photo', albumIds: ['z-album', 'a-album'] },
    ))
    const titlesAfter = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(titlesAfter).toEqual(['Zulu', 'Alpha'])

    fireEvent.click(screen.getByRole('button', { name: 'Link Only' }))
    await waitFor(() => expect(api.fetchAlbumsFilteredPage).toHaveBeenLastCalledWith(
      { type: 'photo', limit: 40, visibility: 'unlisted' }, 'admin-token', expect.any(Object),
    ))
    expect(screen.queryByRole('button', { name: /Move .* earlier/ })).toBeNull()
  })

  it('persists category order independently from album order', async () => {
    api.fetchAlbumsFilteredPage.mockResolvedValue({ items: [
      { ...albums[0], albumId: 'hike', title: 'Trail', category: 'Hikes', galleryCategoryOrder: 1 },
      { ...albums[0], albumId: 'astro', title: 'Stars', category: 'Astro', galleryCategoryOrder: 0 },
    ], nextCursor: null })
    mounted()
    await screen.findByText('Trail')
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent))
      .toEqual(['Astro', 'Hikes'])

    fireEvent.click(screen.getByRole('button', { name: 'Arrange Gallery' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move Hikes category earlier' }))
    await waitFor(() => expect(api.updateGalleryOrder).toHaveBeenCalledWith(
      'admin-token', { albumType: 'photo', categoryNames: ['Hikes', 'Astro'] },
    ))
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent))
      .toEqual(['Hikes', 'Astro'])
  })

  it('supports independent video category and album ordering on the optimized list', async () => {
    api.fetchAlbumsFilteredPage.mockResolvedValue({ items: [
      { ...albums[3], albumId: 'film-b', title: 'Film B', category: 'Films', galleryOrder: 1, galleryCategoryOrder: 0 },
      { ...albums[3], albumId: 'film-a', title: 'Film A', category: 'Films', galleryOrder: 0, galleryCategoryOrder: 0 },
      { ...albums[3], albumId: 'sport', title: 'Sports Film', category: 'Sports', galleryCategoryOrder: 1 },
    ], nextCursor: null })
    mounted('/admin/albums?type=video')
    await screen.findByText('Film B')

    fireEvent.click(screen.getByRole('button', { name: 'Arrange Gallery' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move Film B earlier' }))
    await waitFor(() => expect(api.updateGalleryOrder).toHaveBeenCalledWith(
      'admin-token',
      { albumType: 'video', albumIds: ['film-b', 'film-a', 'sport'] },
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Move Sports category earlier' }))
    await waitFor(() => expect(api.updateGalleryOrder).toHaveBeenCalledWith(
      'admin-token',
      { albumType: 'video', categoryNames: ['Sports', 'Films'] },
    ))
    expect(api.fetchAlbumsFilteredPage).toHaveBeenCalledWith(
      { type: 'video', limit: 40, visibility: 'public' },
      'admin-token',
      expect.any(Object),
    )
    expect(api.fetchAlbumMediaPage).not.toHaveBeenCalled()
  })

  it('supports metadata editing, cancellation, delete confirmation, and load failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm')
    mounted()
    await screen.findByText('Summer')
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    fireEvent.change(screen.getByDisplayValue('Summer'), { target: { value: 'Summer Updated' } })
    fireEvent.change(screen.getByDisplayValue('A trip'), { target: { value: 'Updated description' } })
    fireEvent.change(screen.getByDisplayValue('Travel'), { target: { value: 'People' } })
    fireEvent.change(screen.getByDisplayValue('2026-06-01'), { target: { value: '2026-07-02' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.updateAlbum).toHaveBeenCalledWith('admin-token', 'photo', {
      title: 'Summer Updated', description: 'Updated description', category: 'People',
      createdAt: new Date('2026-07-02T12:00:00').toISOString(),
    }))
    expect(await screen.findByText('Album updated!')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    confirm.mockReturnValueOnce(false)
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    expect(api.deleteAlbum).not.toHaveBeenCalled()
    confirm.mockReturnValueOnce(true)
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    await waitFor(() => expect(api.deleteAlbum).toHaveBeenCalledWith('admin-token', 'photo'))
    expect(await screen.findByText('Album deleted!')).toBeInTheDocument()
  })

  it('renders video albums and empty/error responses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = mounted('/admin/albums?type=video')
    expect(await screen.findByText('Manage Video Albums')).toBeInTheDocument()
    expect(await screen.findByText('Film')).toBeInTheDocument()
    expect(screen.queryByText('Summer')).toBeNull()
    first.unmount()

    api.fetchAlbumsFilteredPage.mockResolvedValueOnce({ items: [], nextCursor: null })
    const empty = mounted()
    expect(await screen.findByText('No albums found.')).toBeInTheDocument()
    empty.unmount()

    api.listUsersPage.mockRejectedValueOnce(new Error('users failed'))
    api.fetchAlbumsFilteredPage.mockRejectedValueOnce(new Error('albums failed'))
    mounted()
    expect(await screen.findByText('No albums found.')).toBeInTheDocument()
    await waitFor(() => expect(console.error).toHaveBeenCalled())
  })

  it('uses administrator media keys for cover and removal mutations', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const mediaItem = {
      id: 'opaque-media-id',
      rawKey: 'albums/photo/raw.jpg',
      thumbKey: 'albums/photo/thumb.jpg',
      thumbnailUrl: 'https://cdn.test/thumb.jpg',
      blurhash: 'hash',
    }
    api.fetchAlbumMediaPage.mockResolvedValue({ album: albums[0], items: [mediaItem], nextCursor: null })
    api.deleteImages.mockResolvedValue({ album: { ...albums[0], imageCount: 0, coverImageUrl: '' } })

    mounted()
    await screen.findByText('Summer')
    fireEvent.click(screen.getAllByRole('button', { name: 'Photos' })[0])
    fireEvent.click(await screen.findByTitle('Set as album cover'))
    await waitFor(() => expect(api.updateAlbum).toHaveBeenCalledWith('admin-token', 'photo', {
      coverImageUrl: mediaItem.rawKey,
      coverThumbKey: mediaItem.thumbKey,
      coverBlurhash: mediaItem.blurhash,
    }))

    // Cover updates are local, so the expanded panel remains open for removal.
    expect(screen.getByTitle('Remove')).toBeInTheDocument()
    expect(api.fetchAlbumsFilteredPage).toHaveBeenCalledTimes(1)
    fireEvent.click(await screen.findByTitle('Remove'))
    await waitFor(() => expect(api.deleteImages).toHaveBeenCalledWith(
      'admin-token', 'photo', [mediaItem.rawKey],
    ))
    expect(confirm).toHaveBeenCalled()
  })

  it('blocks media mutations when a management key is absent', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    api.fetchAlbumMediaPage.mockResolvedValue({
      album: albums[0],
      items: [{ id: 'opaque-media-id', thumbnailUrl: 'https://cdn.test/thumb.jpg' }],
      nextCursor: null,
    })

    mounted()
    await screen.findByText('Summer')
    fireEvent.click(screen.getAllByRole('button', { name: 'Photos' })[0])
    fireEvent.click(await screen.findByTitle('Remove'))
    expect(await screen.findByText(/missing its management key/i)).toBeInTheDocument()
    expect(confirm).not.toHaveBeenCalled()
    expect(api.deleteImages).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTitle('Set as album cover'))
    expect(api.updateAlbum).not.toHaveBeenCalled()
  })

  it('pages album media without reloading the catalog or replacing loaded items', async () => {
    api.fetchAlbumMediaPage
      .mockResolvedValueOnce({
        album: { ...albums[0], imageCount: 2 },
        items: [{ rawKey: 'albums/photo/one.jpg', thumbnailUrl: 'https://cdn.test/one.jpg' }],
        nextCursor: 'media-cursor',
      })
      .mockResolvedValueOnce({
        album: { ...albums[0], imageCount: 2 },
        items: [{ rawKey: 'albums/photo/two.jpg', thumbnailUrl: 'https://cdn.test/two.jpg' }],
        nextCursor: null,
      })

    mounted()
    await screen.findByText('Summer')
    fireEvent.click(screen.getAllByRole('button', { name: 'Photos' })[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Load more photos' }))

    await waitFor(() => expect(api.fetchAlbumMediaPage).toHaveBeenLastCalledWith(
      'admin-token',
      'photo',
      { limit: 48, cursor: 'media-cursor' },
    ))
    expect(screen.getAllByTitle('Remove')).toHaveLength(2)
    expect(api.fetchAlbumsFilteredPage).toHaveBeenCalledTimes(1)
  })
})
