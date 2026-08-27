import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const exploreApi = vi.hoisted(() => ({
  fetchExploreColors: vi.fn(),
  fetchExploreExposures: vi.fn(),
  fetchExploreLenses: vi.fn(),
  fetchExplorePhotos: vi.fn(),
  fetchExploreSample: vi.fn(),
  prefetchExploreModule: vi.fn(() => Promise.resolve()),
}))
const api = vi.hoisted(() => ({ requestAlbumMediaDownload: vi.fn() }))
const scroll = vi.hoisted(() => ({ saveVerticalScroll: vi.fn(), useScrollRestoration: vi.fn() }))

vi.mock('../utils/api', () => api)
vi.mock('../utils/exploreApi', () => exploreApi)
vi.mock('../utils/scroll', () => scroll)
vi.mock('../utils/analytics', () => ({ trackPhotoDownload: vi.fn() }))
vi.mock('../utils/mediaUrls', () => ({
  mediaFileName: () => 'photo.jpg',
  mediaId: image => image.id,
  mediaPreviewSrcSet: image => (image.previewSrcSet || []).map(item => `${item.url} ${item.width}w`).join(', '),
  mediaThumbnailUrl: image => image.thumbnailUrl,
  resolveMediaDownloadUrl: request => request().then(result => result.downloadUrl),
  startBrowserDownload: vi.fn(),
}))
vi.mock('../components/ProgressiveImage', () => ({
  default: ({ alt, src, className }) => <img alt={alt} src={src} className={className} />,
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
  exif: {
    model: 'Canon EOS R7', lens: 'Sigma 18-50mm F2.8',
    focalLength: '56mm', focalRatio: 'f/2.8', shutterSpeed: '1/500s', iso: 'ISO 400',
  },
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
    exploreApi.fetchExploreExposures.mockResolvedValue({
      items: [
        { id: 'aperture', options: [{ id: 'wide', photos: 120 }, { id: 'middle', photos: 45 }, { id: 'deep', photos: 30 }] },
        { id: 'shutter', options: [{ id: 'motion', photos: 20 }, { id: 'handheld', photos: 70 }, { id: 'frozen', photos: 105 }] },
        { id: 'iso', options: [{ id: 'clean', photos: 60 }, { id: 'available', photos: 110 }, { id: 'low', photos: 25 }] },
        { id: 'focal', options: [{ id: 'wide', photos: 55 }, { id: 'normal', photos: 100 }, { id: 'telephoto', photos: 40 }] },
      ],
      initialPage: { value: 'aperture:wide', items: [photo], total: 120, nextCursor: null },
    })
    exploreApi.fetchExplorePhotos.mockResolvedValue({ items: [photo], nextCursor: null })
    exploreApi.fetchExploreSample.mockResolvedValue({ images: [photo, secondPhoto] })
  })

  it('presents Explore as a module landing page without loading an index', () => {
    render(<MemoryRouter initialEntries={['/explore']}><Explore /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Explore' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Color Explorer/ })).toHaveAttribute('href', '/explore/colors')
    expect(screen.getByRole('link', { name: /Lens Explorer/ })).toHaveAttribute('href', '/explore/lenses')
    expect(screen.getByRole('link', { name: /Exposure Explorer/ })).toHaveAttribute('href', '/explore/exposure')
    expect(screen.getByRole('link', { name: /Guess the Settings/ })).toHaveAttribute('href', '/explore/guess-settings')
    expect(exploreApi.fetchExplorePhotos).not.toHaveBeenCalled()
  })

  it('explores the complete exposure index while initially rendering one page', async () => {
    render(<MemoryRouter initialEntries={['/explore/exposure']}><Explore /></MemoryRouter>)
    expect(await screen.findByText('Blue Mountain')).toBeInTheDocument()
    expect(exploreApi.fetchExploreExposures).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(screen.getAllByText('120')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: 'Aperture' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'ISO' }))
    await waitFor(() => expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'exposure', value: 'iso:clean', limit: 24 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    expect(screen.getByRole('button', { name: /Clean light/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reconciles each exposure filter by stable media id and never leaks wide-open photos into stopped-down results', async () => {
    const stoppedDown = {
      ...photo,
      albumTitle: 'Stopped Down Mountain',
      mediaId: 'media-3',
      id: 'media-3',
      thumbnailUrl: 'https://media.test/stopped.webp',
      exif: { ...photo.exif, focalRatio: 'f/8', iso: 'ISO 1600' },
    }
    exploreApi.fetchExploreExposures.mockResolvedValue({
      items: [
        { id: 'aperture', options: [{ id: 'wide', photos: 1 }, { id: 'middle', photos: 0 }, { id: 'deep', photos: 1 }] },
        { id: 'shutter', options: [{ id: 'motion', photos: 0 }, { id: 'handheld', photos: 0 }, { id: 'frozen', photos: 2 }] },
        { id: 'iso', options: [{ id: 'clean', photos: 0 }, { id: 'available', photos: 1 }, { id: 'low', photos: 1 }] },
        { id: 'focal', options: [{ id: 'wide', photos: 0 }, { id: 'normal', photos: 2 }, { id: 'telephoto', photos: 0 }] },
      ],
      initialPage: { value: 'aperture:wide', items: [photo], total: 1, nextCursor: null },
    })
    exploreApi.fetchExplorePhotos.mockImplementation(({ value }) => Promise.resolve({
      items: value === 'aperture:deep' || value === 'iso:low' ? [stoppedDown] : [photo],
      total: 1,
      nextCursor: null,
    }))
    render(<MemoryRouter initialEntries={['/explore/exposure']}><Explore /></MemoryRouter>)

    expect(await screen.findByRole('button', { name: 'View photo from Blue Mountain' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Stopped Down/ }))
    expect(await screen.findByRole('button', { name: 'View photo from Stopped Down Mountain' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View photo from Blue Mountain' })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'ISO' }))
    expect(await screen.findByRole('button', { name: 'View photo from Blue Mountain' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Low light/ }))
    expect(await screen.findByRole('button', { name: 'View photo from Stopped Down Mountain' })).toBeInTheDocument()
  })

  it('loads more exposure results without changing the true total or duplicating a photo', async () => {
    exploreApi.fetchExploreExposures.mockResolvedValue({
      items: [{ id: 'aperture', options: [{ id: 'wide', photos: 50 }] }],
      initialPage: { value: 'aperture:wide', items: [photo], total: 50, nextCursor: 'exposure-cursor' },
    })
    exploreApi.fetchExplorePhotos.mockResolvedValue({ items: [photo, secondPhoto], total: 50, nextCursor: null })
    render(<MemoryRouter initialEntries={['/explore/exposure']}><Explore /></MemoryRouter>)

    fireEvent.click(await screen.findByRole('button', { name: 'Show another random set' }))
    expect(await screen.findByText('Green Valley')).toBeInTheDocument()
    expect(screen.getAllByText('Blue Mountain')).toHaveLength(1)
    expect(screen.getAllByText('50')).toHaveLength(2)
  })

  it('saves and restores the Explore landing scroll position around module navigation', () => {
    const first = render(<MemoryRouter initialEntries={['/explore']}><Explore /></MemoryRouter>)
    fireEvent.click(screen.getByRole('link', { name: /Exposure Explorer/ }))
    expect(scroll.saveVerticalScroll).toHaveBeenCalledWith('/explore')
    first.unmount()

    render(<MemoryRouter initialEntries={[{ pathname: '/explore', state: { restoreExploreScroll: true } }]}><Explore /></MemoryRouter>)
    expect(scroll.useScrollRestoration).toHaveBeenLastCalledWith('/explore', true)
  })

  it('runs a settings-guessing round and reveals the complete answer', async () => {
    render(<MemoryRouter initialEntries={['/explore/guess-settings']}><Explore /></MemoryRouter>)
    expect(await screen.findByRole('img', { name: /photograph from (Blue Mountain|Green Valley)/i })).toBeInTheDocument()
    expect(document.querySelector('.explore-game-image')).toHaveClass('explore-game-image')
    const choices = screen.getAllByRole('button').filter(button => /^(f\/|1\/|ISO|\d+mm)/.test(button.textContent))
    expect(choices).toHaveLength(4)
    fireEvent.click(choices[0])
    expect(await screen.findByRole('button', { name: /Next photograph/ })).toBeInTheDocument()
    expect(screen.getAllByText(/56mm/).length).toBeGreaterThan(0)
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
