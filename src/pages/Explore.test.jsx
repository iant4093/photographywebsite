import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const exploreApi = vi.hoisted(() => ({
  fetchExploreLenses: vi.fn(),
  fetchExplorePhotos: vi.fn(),
}))
const api = vi.hoisted(() => ({
  requestAlbumMediaDownload: vi.fn(),
}))

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
  default: ({ images, index, onClose, onNext, onPrevious, onDownload }) => (
    <div role="dialog" aria-label="Photographs in Explore">
      <p>{images[index].albumTitle}</p>
      <button type="button" onClick={onNext}>Next photo</button>
      <button type="button" onClick={onPrevious}>Previous photo</button>
      <button type="button" onClick={event => onDownload(event, images[index])}>Download photo</button>
      <button type="button" onClick={onClose}>Close photo viewer</button>
    </div>
  ),
}))

import Explore from './Explore'

const photo = {
  albumId: 'album-1',
  albumTitle: 'Blue Mountain',
  albumCategory: 'Hikes',
  mediaId: 'media-1',
  id: 'media-1',
  thumbnailUrl: 'https://media.test/photo.webp',
  previewSrcSet: [{ width: 640, url: 'https://media.test/photo.webp' }],
  palette: ['#123456', '#567890'],
  width: 1920,
  height: 1280,
}
const secondPhoto = {
  ...photo,
  albumId: 'album-2',
  albumTitle: 'Green Valley',
  mediaId: 'media-2',
  id: 'media-2',
  thumbnailUrl: 'https://media.test/second.webp',
}

describe('Explore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    exploreApi.fetchExploreLenses.mockResolvedValue({
      items: [
        { name: 'Sigma 18-50mm F2.8', photos: 12 },
        { name: 'Sirui Nightwalker 75mm T1.2', photos: 4 },
      ],
    })
    exploreApi.fetchExplorePhotos.mockResolvedValue({ items: [photo], nextCursor: null })
  })

  it('browses colors and opens matching photographs in a lightbox', async () => {
    render(<MemoryRouter><Explore /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Explore' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Color Explorer' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('Blue Mountain')).toBeInTheDocument()
    expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'color', value: 'blue', limit: 24 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'View photo from Blue Mountain' }))
    expect(screen.getByRole('dialog', { name: 'Photographs in Explore' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close photo viewer' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('switches to lens browsing and queries the selected lens', async () => {
    render(<MemoryRouter><Explore /></MemoryRouter>)
    await screen.findByText('Blue Mountain')
    fireEvent.click(screen.getByRole('tab', { name: 'Lens Explorer' }))
    const sigma = await screen.findByRole('button', { name: /Sigma 18-50mm F2.8/ })
    await waitFor(() => expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'lens', value: 'Sigma 18-50mm F2.8', limit: 24 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    expect(sigma).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Sirui Nightwalker/ }))
    await waitFor(() => expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'lens', value: 'Sirui Nightwalker 75mm T1.2', limit: 24 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
  })

  it('shows a safe empty state when the selected facet has no indexed photos', async () => {
    exploreApi.fetchExplorePhotos.mockResolvedValue({ items: [], nextCursor: null })
    render(<MemoryRouter initialEntries={['/explore?color=red']}><Explore /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'No matches yet' })).toBeInTheDocument()
  })

  it('changes color facets and falls back from an unsupported URL color', async () => {
    render(<MemoryRouter initialEntries={['/explore?color=chartreuse']}><Explore /></MemoryRouter>)
    await screen.findByText('Blue Mountain')
    expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'color', value: 'blue', limit: 24 },
      expect.anything(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Green' }))
    await waitFor(() => expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'color', value: 'green', limit: 24 },
      expect.anything(),
    ))
  })

  it('loads another page without duplicating an existing photograph', async () => {
    exploreApi.fetchExplorePhotos
      .mockResolvedValueOnce({ items: [photo], nextCursor: 'safe-cursor' })
      .mockResolvedValueOnce({ items: [photo, secondPhoto], nextCursor: null })
    render(<MemoryRouter><Explore /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Load more photographs' }))
    expect(await screen.findByText('Green Valley')).toBeInTheDocument()
    expect(screen.getAllByText('Blue Mountain')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Load more photographs' })).toBeNull()
  })

  it('keeps lightbox navigation and downloads available for Explore results', async () => {
    exploreApi.fetchExplorePhotos.mockResolvedValue({ items: [photo, secondPhoto], nextCursor: null })
    api.requestAlbumMediaDownload.mockResolvedValue({ downloadUrl: 'https://download.test/photo' })
    render(<MemoryRouter><Explore /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'View photo from Blue Mountain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Green Valley')
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Blue Mountain')
    fireEvent.click(screen.getByRole('button', { name: 'Download photo' }))
    await waitFor(() => expect(api.requestAlbumMediaDownload).toHaveBeenCalledWith('album-1', 'media-1'))
  })

  it('surfaces safe initial-result and lens-index errors', async () => {
    exploreApi.fetchExplorePhotos.mockRejectedValueOnce(new Error('Explore is unavailable.'))
    const first = render(<MemoryRouter><Explore /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Explore is unavailable.')
    first.unmount()

    exploreApi.fetchExploreLenses.mockRejectedValueOnce(new Error('Lens index is unavailable.'))
    render(<MemoryRouter initialEntries={['/explore?mode=lens']}><Explore /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Lens index is unavailable.')
  })
})
