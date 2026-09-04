import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const exploreApi = vi.hoisted(() => ({
  createExploreSeed: vi.fn(() => '0123456789abcdef'),
  fetchExploreColors: vi.fn(),
  fetchExploreExposures: vi.fn(),
  fetchExploreLenses: vi.fn(),
  fetchExplorePhotos: vi.fn(),
  fetchExploreSample: vi.fn(),
  fetchExploreSeasons: vi.fn(),
  fetchExploreTimes: vi.fn(),
  prefetchExploreModule: vi.fn(() => Promise.resolve()),
}))
const api = vi.hoisted(() => ({ fetchAlbum: vi.fn(), requestAlbumMediaDownload: vi.fn() }))
const scroll = vi.hoisted(() => ({ saveVerticalScroll: vi.fn(), useScrollRestoration: vi.fn() }))
const exploreState = vi.hoisted(() => ({
  readExploreBrowseState: vi.fn(() => null),
  saveExploreBrowseScroll: vi.fn(),
  writeExploreBrowseState: vi.fn(),
}))

vi.mock('../utils/api', () => api)
vi.mock('../utils/exploreApi', () => exploreApi)
vi.mock('../utils/scroll', () => scroll)
vi.mock('../utils/exploreState', () => exploreState)
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
  default: ({ alt, src, className, blurhash }) => <img alt={alt} src={src} className={className} data-blurhash={blurhash} />,
}))
vi.mock('../components/PhotoLightbox', () => ({
  default: ({ images, index, ariaLabel, onClose, onNext, onPrevious, onDownload, onBeforeRefresh }) => (
    <div role="dialog" aria-label={ariaLabel}>
      <p>{images[index].albumTitle}</p>
      <p>{images[index].exif?.model}</p>
      <p data-testid="original-status">{images[index].before?.status || 'pending'}</p>
      <button type="button" onClick={event => onBeforeRefresh(event, images[index])}>Refresh original</button>
      <button type="button" onClick={onNext}>Next photo</button>
      <button type="button" onClick={onPrevious}>Previous photo</button>
      <button type="button" onClick={event => onDownload(event, images[index])}>Download photo</button>
      <button type="button" onClick={onClose}>Close photo viewer</button>
    </div>
  ),
}))

import Explore from './Explore'

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const photo = {
  albumId: 'album-1', albumTitle: 'Blue Mountain', albumCategory: 'Hikes',
  mediaId: 'media-1', id: 'media-1', thumbnailUrl: 'https://media.test/photo.webp',
  blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
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
const thirdPhoto = {
  ...photo, albumId: 'album-3', albumTitle: 'New Shuffle', mediaId: 'media-3', id: 'media-3',
  thumbnailUrl: 'https://media.test/third.webp',
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
    exploreApi.fetchExploreTimes.mockResolvedValue({
      items: [
        { id: 'dawn', photos: 2 }, { id: 'morning', photos: 8 }, { id: 'afternoon', photos: 6 },
        { id: 'evening', photos: 4 }, { id: 'night', photos: 3 },
      ],
      initialPage: { value: 'dawn', items: [photo], nextCursor: null, seed: '0123456789abcdef' },
    })
    exploreApi.fetchExploreSeasons.mockResolvedValue({
      items: [
        { id: 'winter', photos: 3 }, { id: 'spring', photos: 5 },
        { id: 'summer', photos: 7 }, { id: 'autumn', photos: 4 },
      ],
      initialPage: { value: 'winter', items: [photo], nextCursor: null, seed: '0123456789abcdef' },
    })
    exploreState.readExploreBrowseState.mockReturnValue(null)
  })

  it.each(['/explore/colors', '/explore/time-of-day?period=dawn'])('refreshes only the selected original in %s without resetting navigation', async (path) => {
    exploreApi.fetchExplorePhotos.mockResolvedValue({ items: [photo, secondPhoto], nextCursor: null })
    exploreApi.fetchExploreTimes.mockResolvedValue({
      items: [{ id: 'dawn', photos: 2 }],
      initialPage: { value: 'dawn', items: [photo, secondPhoto], nextCursor: null, seed: '0123456789abcdef' },
    })
    api.fetchAlbum.mockResolvedValue({ images: [{ id: 'media-2', before: { status: 'unavailable' } }] })
    render(<MemoryRouter initialEntries={[path]}><Explore /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'View photo from Blue Mountain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Green Valley')
    const browseRequests = exploreApi.fetchExplorePhotos.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh original' }))
    await waitFor(() => expect(screen.getByTestId('original-status')).toHaveTextContent('unavailable'))
    expect(api.fetchAlbum).toHaveBeenCalledWith('album-2', null, { force: true, signal: expect.any(AbortSignal) })
    expect(screen.getByRole('dialog')).toHaveTextContent('Green Valley')
    expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledTimes(browseRequests)
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Blue Mountain')
    expect(screen.getByTestId('original-status')).toHaveTextContent('pending')
  })

  it('presents Explore as a module landing page without loading an index', () => {
    render(<MemoryRouter initialEntries={['/explore']}><Explore /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Explore' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Immersive Gallery/ })).toHaveAttribute('href', '/explore/immersive-gallery')
    expect(screen.getByRole('link', { name: /Color Explorer/ })).toHaveAttribute('href', '/explore/colors')
    expect(screen.getByRole('link', { name: /Lens Explorer/ })).toHaveAttribute('href', '/explore/lenses')
    expect(screen.getByRole('link', { name: /Exposure Explorer/ })).toHaveAttribute('href', '/explore/exposure')
    expect(screen.getByRole('link', { name: /Time of Day Explorer/ })).toHaveAttribute('href', '/explore/time-of-day')
    expect(screen.getByRole('link', { name: /Season Explorer/ })).toHaveAttribute('href', '/explore/seasons')
    expect(screen.getByRole('link', { name: /Guess the Settings/ })).toHaveAttribute('href', '/explore/guess-settings')
    expect(exploreApi.fetchExplorePhotos).not.toHaveBeenCalled()
  })

  it('browses camera-local time buckets, canonicalizes the URL, and persists the page', async () => {
    render(
      <MemoryRouter initialEntries={['/explore/time-of-day?period=unknown']}>
        <Explore />
        <LocationProbe />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: 'Time of Day Explorer' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Blue Mountain')).toBeInTheDocument())
    expect(exploreApi.fetchExploreTimes).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/explore/time-of-day?period=dawn'))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Dawn/ })).toHaveAttribute('aria-pressed', 'true'))
    expect(exploreState.writeExploreBrowseState).toHaveBeenCalledWith(
      'time:dawn',
      expect.objectContaining({ items: [photo], seed: '0123456789abcdef' }),
    )

    fireEvent.click(screen.getByRole('button', { name: /Evening/ }))
    await waitFor(() => expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'time', value: 'evening', limit: 24, seed: '0123456789abcdef' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
  })

  it('browses seasons and leaves zero-count fixed choices visibly disabled', async () => {
    exploreApi.fetchExploreSeasons.mockResolvedValue({
      items: [
        { id: 'winter', photos: 0 }, { id: 'spring', photos: 5 },
        { id: 'summer', photos: 7 }, { id: 'autumn', photos: 4 },
      ],
      initialPage: { value: 'spring', items: [photo], nextCursor: null, seed: '0123456789abcdef' },
    })
    render(<MemoryRouter initialEntries={['/explore/seasons?season=autumn']}><Explore /></MemoryRouter>)

    expect(await screen.findByRole('heading', { name: 'Season Explorer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Winter/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Autumn/ })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'season', value: 'autumn', limit: 24, seed: '0123456789abcdef' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
  })

  it('restores a fresh temporal browsing snapshot without refetching its grid', async () => {
    exploreState.readExploreBrowseState.mockImplementation(key => key === 'time:dawn' ? {
      items: [secondPhoto], total: 2, nextCursor: 'cached-cursor', seed: 'fedcba9876543210',
      scrollY: 420, stale: false,
    } : null)
    render(<MemoryRouter initialEntries={['/explore/time-of-day?period=dawn']}><Explore /></MemoryRouter>)

    expect(await screen.findByText('Green Valley')).toBeInTheDocument()
    expect(exploreApi.fetchExplorePhotos).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument()
  })

  it('renders a stale temporal snapshot while revalidating it with the same seed', async () => {
    exploreState.readExploreBrowseState.mockImplementation(key => key === 'season:winter' ? {
      items: [secondPhoto], total: 3, nextCursor: null, seed: 'fedcba9876543210',
      scrollY: 0, stale: true,
    } : null)
    exploreApi.fetchExplorePhotos.mockResolvedValueOnce({
      items: [photo], nextCursor: null, seed: 'fedcba9876543210',
    })
    render(<MemoryRouter initialEntries={['/explore/seasons?season=winter']}><Explore /></MemoryRouter>)

    expect(await screen.findByText('Blue Mountain')).toBeInTheDocument()
    expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'season', value: 'winter', limit: 24, seed: 'fedcba9876543210' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('keeps a newer reshuffle when an older stale revalidation finishes late', async () => {
    const oldRefresh = deferred()
    exploreState.readExploreBrowseState.mockImplementation(key => key === 'season:winter' ? {
      items: [secondPhoto], total: 3, nextCursor: null, seed: 'fedcba9876543210',
      scrollY: 0, stale: true,
    } : null)
    exploreApi.fetchExplorePhotos
      .mockImplementationOnce(() => oldRefresh.promise)
      .mockResolvedValueOnce({ items: [thirdPhoto], nextCursor: null, seed: '0123456789abcdef' })

    render(<MemoryRouter initialEntries={['/explore/seasons?season=winter']}><Explore /></MemoryRouter>)
    await waitFor(() => expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Reshuffle Winter photographs' }))
    expect(await screen.findByText('New Shuffle')).toBeInTheDocument()

    oldRefresh.resolve({ items: [photo], nextCursor: null, seed: 'fedcba9876543210' })
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.getByText('New Shuffle')).toBeInTheDocument()
    expect(screen.queryByText('Blue Mountain')).not.toBeInTheDocument()
  })

  it('drops a late load-more result after the temporal explorer unmounts', async () => {
    const latePage = deferred()
    exploreState.readExploreBrowseState.mockImplementation(key => key === 'time:dawn' ? {
      items: [photo], total: 2, nextCursor: 'cached-cursor', seed: 'fedcba9876543210',
      scrollY: 0, stale: false,
    } : null)
    exploreApi.fetchExplorePhotos.mockImplementationOnce(() => latePage.promise)
    const view = render(<MemoryRouter initialEntries={['/explore/time-of-day?period=dawn']}><Explore /></MemoryRouter>)

    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledTimes(1))
    view.unmount()
    latePage.resolve({ items: [secondPhoto], nextCursor: null })
    await Promise.resolve()
    await Promise.resolve()
    expect(exploreState.writeExploreBrowseState).not.toHaveBeenCalled()
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
    expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('Clean light')
  })

  it('restores the selected exposure setting from the URL after a refresh', async () => {
    render(<MemoryRouter initialEntries={['/explore/exposure?setting=shutter:frozen']}><Explore /></MemoryRouter>)

    expect(await screen.findByRole('tab', { name: 'Shutter speed' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: /^Frozen action/ })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(exploreApi.fetchExplorePhotos).toHaveBeenCalledWith(
      { mode: 'exposure', value: 'shutter:frozen', limit: 24 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
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

    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }))
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

  it('saves the Explore position before entering the immersive gallery', () => {
    render(<MemoryRouter initialEntries={['/explore']}><Explore /></MemoryRouter>)
    fireEvent.click(screen.getByRole('link', { name: /Immersive Gallery/ }))
    expect(scroll.saveVerticalScroll).toHaveBeenCalledWith('/explore')
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

  it('shows every eligible settings photograph once before repeating the deck', async () => {
    const thirdPhoto = {
      ...photo,
      albumId: 'album-3', albumTitle: 'Amber Coast', mediaId: 'media-3', id: 'media-3',
      thumbnailUrl: 'https://media.test/third.webp',
    }
    exploreApi.fetchExploreSample.mockResolvedValue({ images: [photo, secondPhoto, thirdPhoto] })
    render(<MemoryRouter initialEntries={['/explore/guess-settings']}><Explore /></MemoryRouter>)

    const seen = []
    for (let index = 0; index < 3; index += 1) {
      const image = await screen.findByRole('img', { name: /A photograph from/ })
      seen.push(image.getAttribute('alt'))
      if (index < 2) fireEvent.click(screen.getByRole('button', { name: 'Skip photograph' }))
    }
    expect(new Set(seen).size).toBe(3)
    fireEvent.click(screen.getByRole('button', { name: 'Skip photograph' }))
    expect((await screen.findByRole('img', { name: /A photograph from/ })).getAttribute('alt')).not.toBe(seen[2])
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
    expect(document.querySelector('.explore-photo-image')).toHaveAttribute('data-blurhash', photo.blurhash)
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
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    expect(await screen.findByText('Green Valley')).toBeInTheDocument()
    expect(screen.getAllByText('Blue Mountain')).toHaveLength(1)
  })

  it('requests a fresh seeded color shuffle and replaces the current page', async () => {
    exploreApi.fetchExplorePhotos
      .mockResolvedValueOnce({ items: [photo], nextCursor: null })
      .mockResolvedValueOnce({ items: [secondPhoto], nextCursor: null })
    render(<MemoryRouter initialEntries={['/explore/colors']}><Explore /></MemoryRouter>)

    fireEvent.click(await screen.findByRole('button', { name: 'Reshuffle Blue photographs' }))
    expect(await screen.findByText('Green Valley')).toBeInTheDocument()
    expect(screen.queryByText('Blue Mountain')).toBeNull()
    expect(exploreApi.fetchExplorePhotos).toHaveBeenLastCalledWith({
      mode: 'color', value: 'blue', limit: 24, seed: '0123456789abcdef',
    })
  })

  it('requests a fresh seeded exposure shuffle and preserves the indexed total', async () => {
    exploreApi.fetchExplorePhotos.mockResolvedValueOnce({
      items: [secondPhoto], total: 120, nextCursor: null,
    })
    render(<MemoryRouter initialEntries={['/explore/exposure']}><Explore /></MemoryRouter>)

    fireEvent.click(await screen.findByRole('button', { name: 'Reshuffle Aperture Wide open photographs' }))
    expect(await screen.findByText('Green Valley')).toBeInTheDocument()
    expect(screen.getAllByText('120')).toHaveLength(2)
    expect(exploreApi.fetchExplorePhotos).toHaveBeenLastCalledWith({
      mode: 'exposure', value: 'aperture:wide', limit: 24, seed: '0123456789abcdef',
    })
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
