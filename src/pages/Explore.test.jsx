import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const exploreApi = vi.hoisted(() => ({
  fetchExploreColors: vi.fn(),
  fetchExploreLenses: vi.fn(),
  fetchExplorePhotos: vi.fn(),
  prefetchExploreModule: vi.fn(() => Promise.resolve()),
}))
const api = vi.hoisted(() => ({ requestAlbumMediaDownload: vi.fn() }))

vi.mock('../utils/api', () => api)
vi.mock('../utils/exploreApi', () => exploreApi)
vi.mock('../utils/analytics', () => ({ trackPhotoDownload: vi.fn() }))
vi.mock('../utils/mediaUrls', () => ({
  mediaFileName: () => 'photo.jpg',
  mediaId: image => image.id,
  mediaPreviewSrcSet: image => (image.previewSrcSet || []).map(item => `${item.url} ${item.width}w`).join(', '),
  resolveMediaDownloadUrl: request => request().then(result => result.downloadUrl),
  startBrowserDownload: vi.fn(),
}))
vi.mock('../components/ProgressiveImage', () => ({
  default: ({ alt, src }) => <img alt={alt} src={src} />,
}))
vi.mock('../components/PhotoLightbox', () => ({
  default: ({ images, index, ariaLabel, onClose, onNext, onPrevious, onDownload }) => (
    <div role="dialog" aria-label={ariaLabel}>
      <p>{images[index].albumTitle}</p>
      <p>{images[index].exif?.model}</p>
      <button type="button" onClick={onNext}>Next photo</button>
      <button type="button" onClick={onPrevious}>Previous photo</button>
      <button type="button" onClick={event => onDownload(event, images[index])}>Download photo</button>
      <button type="button" onClick={onClose}>Close photo viewer</button>
    </div>
  ),
}))

import Explore from './Explore'

const photo = {
  albumId: 'album-1', albumTitle: 'Blue Mountain', albumCategory: 'Hikes',
  mediaId: 'media-1', id: 'media-1', thumbnailUrl: 'https://media.test/photo.webp',
  previewSrcSet: [{ width: 640, url: 'https://media.test/photo.webp' }],
  palette: ['#123456', '#567890'], width: 1920, height: 1280,
  exif: { model: 'Canon EOS R7', lens: 'Sigma 18-50mm F2.8' },
}
const secondPhoto = {
  ...photo, albumId: 'album-2', albumTitle: 'Green Valley', mediaId: 'media-2', id: 'media-2',
  thumbnailUrl: 'https://media.test/second.webp',
}

describe('Explore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    exploreApi.fetchExploreColors.mockResolvedValue({
      items: [{ id: 'blue', photos: 12 }, { id: 'green', photos: 8 }],
    })
    exploreApi.fetchExploreLenses.mockResolvedValue({
      items: [
        { name: 'Sigma 18-50mm F2.8', photos: 12 },
        { name: 'Sirui Nightwalker 75mm T1.2', photos: 4 },
      ],
    })
    exploreApi.fetchExplorePhotos.mockResolvedValue({ items: [photo], nextCursor: null })
  })

  it('presents Explore as a module landing page without loading an index', () => {
    render(<MemoryRouter initialEntries={['/explore']}><Explore /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Explore' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Color Explorer/ })).toHaveAttribute('href', '/explore/colors')
    expect(screen.getByRole('link', { name: /Lens Explorer/ })).toHaveAttribute('href', '/explore/lenses')
    expect(exploreApi.fetchExplorePhotos).not.toHaveBeenCalled()
  })

  it('browses available colors and opens matching photographs with full metadata', async () => {
    render(<MemoryRouter initialEntries={['/explore/colors']}><Explore /></MemoryRouter>)
    expect(await screen.findByText('Blue Mountain')).toBeInTheDocument()
    expect(exploreApi.fetchExploreColors).toHaveBeenCalled()
    expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'color', value: 'blue', limit: 24 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(screen.getByLabelText('Extracted color palette')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View photo from Blue Mountain' }))
    expect(screen.getByRole('dialog', { name: 'Photographs in Color Explorer' })).toHaveTextContent('Canon EOS R7')
  })

  it('uses a bundled initial page without making a second blocking request', async () => {
    exploreApi.fetchExploreColors.mockResolvedValue({
      items: [{ id: 'blue', photos: 12 }],
      initialPage: { value: 'blue', items: [photo], nextCursor: null },
    })
    render(<MemoryRouter initialEntries={['/explore/colors']}><Explore /></MemoryRouter>)

    expect(await screen.findByText('Blue Mountain')).toBeInTheDocument()
    expect(exploreApi.fetchExplorePhotos).not.toHaveBeenCalled()
  })

  it('browses lenses without rendering irrelevant palette swatches', async () => {
    render(<MemoryRouter initialEntries={['/explore/lenses']}><Explore /></MemoryRouter>)
    expect(await screen.findByText('Blue Mountain')).toBeInTheDocument()
    expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'lens', value: 'Sigma 18-50mm F2.8', limit: 24 },
      expect.anything(),
    )
    expect(screen.queryByLabelText('Extracted color palette')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Sirui Nightwalker/ }))
    await waitFor(() => expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'lens', value: 'Sirui Nightwalker 75mm T1.2', limit: 24 },
      expect.anything(),
    ))
  })

  it('falls back from an unavailable URL facet and only presents populated choices', async () => {
    render(<MemoryRouter initialEntries={['/explore/colors?color=orange']}><Explore /></MemoryRouter>)
    await screen.findByText('Blue Mountain')
    expect(screen.queryByRole('button', { name: /Warm orange/ })).toBeNull()
    expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'color', value: 'blue', limit: 24 }, expect.anything(),
    )
    fireEvent.click(screen.getByRole('button', { name: /Green/ }))
    await waitFor(() => expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'color', value: 'green', limit: 24 }, expect.anything(),
    ))
  })

  it('loads another stable random page without duplicating photographs', async () => {
    exploreApi.fetchExplorePhotos
      .mockResolvedValueOnce({ items: [photo], nextCursor: 'safe-cursor' })
      .mockResolvedValueOnce({ items: [photo, secondPhoto], nextCursor: null })
    render(<MemoryRouter initialEntries={['/explore/colors']}><Explore /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Show another random set' }))
    expect(await screen.findByText('Green Valley')).toBeInTheDocument()
    expect(screen.getAllByText('Blue Mountain')).toHaveLength(1)
  })

  it('keeps lightbox navigation and downloads available', async () => {
    exploreApi.fetchExplorePhotos.mockResolvedValue({ items: [photo, secondPhoto], nextCursor: null })
    api.requestAlbumMediaDownload.mockResolvedValue({ downloadUrl: 'https://download.test/photo' })
    render(<MemoryRouter initialEntries={['/explore/colors']}><Explore /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'View photo from Blue Mountain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Green Valley')
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download photo' }))
    await waitFor(() => expect(api.requestAlbumMediaDownload).toHaveBeenCalledWith('album-1', 'media-1'))
  })

  it('surfaces facet and result errors without claiming indexing is still in progress', async () => {
    exploreApi.fetchExploreColors.mockRejectedValueOnce(new Error('Color index is unavailable.'))
    const first = render(<MemoryRouter initialEntries={['/explore/colors']}><Explore /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Color index is unavailable.')
    expect(screen.queryByText(/still being prepared/i)).toBeNull()
    first.unmount()

    exploreApi.fetchExplorePhotos.mockRejectedValueOnce(new Error('Explore is unavailable.'))
    render(<MemoryRouter initialEntries={['/explore/lenses']}><Explore /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Explore is unavailable.')
  })
})
