import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  fetchAlbumsPage: vi.fn(),
  fetchRandomPhotos: vi.fn(),
  requestAlbumMediaDownload: vi.fn(),
}))
const catalog = vi.hoisted(() => ({
  getCatalogSnapshot: vi.fn(() => null),
  setCatalogSnapshot: vi.fn(),
  deleteCatalogSnapshot: vi.fn(),
  loadCompleteCatalog: vi.fn(),
  reconcilePublicCatalogItems: vi.fn((items) => items),
}))
const scroll = vi.hoisted(() => ({
  isRevealed: vi.fn(() => false),
  markAsRevealed: vi.fn(),
  useScrollRestoration: vi.fn(),
}))

vi.mock('../utils/api', () => api)
vi.mock('../utils/catalogState', () => ({
  ...catalog,
  CatalogPaginationError: class CatalogPaginationError extends Error {
    constructor(message, code) { super(message); this.code = code }
  },
}))
vi.mock('../utils/scroll', () => scroll)
vi.mock('../components/AlbumCard', () => ({ default: ({ album, videoPreview }) => <a data-video-preview={videoPreview || undefined} href={`/${album.type === 'video' ? 'video' : 'album'}/${album.albumId}`}>{album.title}</a> }))
vi.mock('../components/VideoAlbumCard', () => ({ default: ({ album }) => <a data-video-preview="true" href={`/video/${album.albumId}`}>{album.title}</a> }))
vi.mock('../components/ScrollRow', () => ({ default: ({ children, scrollKey }) => <div data-testid={scrollKey}>{children}</div> }))

import Home from './Home'
import Videos from './Videos'

function routed(ui) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('Home complete public catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    catalog.getCatalogSnapshot.mockReturnValue(null)
    scroll.isRevealed.mockReturnValue(false)
    window.matchMedia = vi.fn(() => ({ matches: true }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('managed hero unavailable')))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders every automatically fetched page grouped and sorted without a load-more affordance', async () => {
    catalog.loadCompleteCatalog.mockImplementation(async ({ fetchPage, onPage }) => {
      const first = await fetchPage(null)
      onPage(first)
      const second = await fetchPage(first.nextCursor)
      const final = { items: [...first.items, ...second.items], nextCursor: null }
      onPage(final)
      return final
    })
    api.fetchAlbumsPage
      .mockResolvedValueOnce({ items: [{ albumId: '1', title: 'Zoo', category: 'Wildlife', type: 'photo' }], nextCursor: 'two' })
      .mockResolvedValueOnce({ items: [
        { albumId: '2', title: 'Portrait', category: 'People' },
        { albumId: '3', title: 'Misc', category: '', type: 'photo' },
        { albumId: 'ignore', title: 'Wrong type', type: 'video', category: 'People' },
      ], nextCursor: null })
    routed(<Home />)
    expect(screen.getByRole('status', { name: 'Loading gallery' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Portrait')).toBeInTheDocument())
    expect(api.fetchAlbumsPage).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: null, type: 'photo', visibility: 'public' }), expect.anything())
    expect(api.fetchAlbumsPage).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'two' }), expect.anything())
    expect(screen.queryByText('Wrong type')).toBeNull()
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
    expect(catalog.setCatalogSnapshot).toHaveBeenLastCalledWith('public-photos', expect.objectContaining({ nextCursor: null }))
  })

  it('uses a cached catalog immediately and marks already-revealed sections', async () => {
    catalog.getCatalogSnapshot.mockReturnValue({ items: [{ albumId: '1', title: 'Cached', type: 'photo', category: 'Travel' }], nextCursor: null })
    catalog.loadCompleteCatalog.mockResolvedValue({ items: [], nextCursor: null })
    scroll.isRevealed.mockReturnValue(true)
    const { container } = routed(<Home />)
    expect(screen.getByText('Cached')).toBeInTheDocument()
    expect(screen.getByText('Cached').parentElement).toHaveClass(
      'w-[280px]',
      'sm:w-[320px]',
      'lg:w-[360px]',
    )
    expect(screen.getByText('Cached').parentElement).not.toHaveClass('md:w-[360px]')
    expect(screen.queryByRole('status')).toBeNull()
    await waitFor(() => expect(container.querySelector('[data-reveal-id="home-photo-header"]')).toHaveClass('is-visible', 'no-stagger'))
  })

  it('sorts whole category sections locally while preserving curated album order', () => {
    const items = [
      { albumId: 'bird-two', title: 'Bird Two', type: 'photo', category: 'Birding', galleryOrder: 1, galleryCategoryOrder: 0, uploadedAt: '2026-08-20T12:00:00Z' },
      { albumId: 'bird-one', title: 'Bird One', type: 'photo', category: 'Birding', galleryOrder: 0, galleryCategoryOrder: 0, uploadedAt: '2026-08-19T12:00:00Z' },
      { albumId: 'hike-one', title: 'Hike One', type: 'photo', category: 'Hikes', galleryCategoryOrder: 1, uploadedAt: '2026-08-22T12:00:00Z' },
    ]
    catalog.getCatalogSnapshot.mockReturnValue({ items, nextCursor: null })
    catalog.loadCompleteCatalog.mockResolvedValue({ items, nextCursor: null })
    const view = routed(<Home />)
    const sectionSort = screen.getByLabelText('Sort sections')

    expect(sectionSort).toHaveValue('0')
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
      .toEqual(['Birding', 'Hikes'])
    expect(screen.getByTestId('home-photo-Birding')).toHaveTextContent('Bird OneBird Two')

    fireEvent.change(sectionSort, { target: { value: '1' } })
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
      .toEqual(['Hikes', 'Birding'])
    expect(screen.getByTestId('home-photo-Birding')).toHaveTextContent('Bird OneBird Two')

    view.unmount()
    routed(<Home />)
    expect(screen.getByLabelText('Sort sections')).toHaveValue('0')
  })

  it('smoothly skips the moving wall and targets the photo album heading', () => {
    catalog.getCatalogSnapshot.mockReturnValue({ items: [], nextCursor: null })
    catalog.loadCompleteCatalog.mockResolvedValue({ items: [], nextCursor: null })
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const { container } = routed(<Home />)
    const target = container.querySelector('#photo-albums')
    const link = screen.getByRole('link', { name: 'Explore Photos' })
    const albumsSection = container.querySelector('#albums')

    expect(link).toHaveAttribute('href', '#photo-albums')
    expect(target).toHaveStyle({ scrollMarginTop: '6rem' })
    expect(albumsSection).toHaveClass('pt-10', 'md:pt-14', 'pb-16', 'md:pb-24')
    expect(albumsSection).not.toHaveClass('py-16', 'md:py-24')
    expect(screen.queryByText('Wildlife, portraiture, sport & place')).toBeNull()
    fireEvent.click(link)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('opens a fresh whole-site random photo session in the gallery lightbox', async () => {
    catalog.getCatalogSnapshot.mockReturnValue({ items: [], nextCursor: null })
    catalog.loadCompleteCatalog.mockResolvedValue({ items: [], nextCursor: null })
    let finishRequest
    api.fetchRandomPhotos.mockReturnValue(new Promise((resolve) => { finishRequest = resolve }))
    const payload = {
      images: [
        { mediaId: 'first', albumId: 'album-one', url: 'https://media.test/first.jpg', thumbnailUrl: 'https://media.test/first-thumb.jpg' },
        { mediaId: 'second', albumId: 'album-two', url: 'https://media.test/second.jpg', thumbnailUrl: 'https://media.test/second-thumb.jpg' },
      ],
    }
    vi.spyOn(Math, 'random').mockReturnValue(0)
    routed(<Home />)

    const randomButton = await screen.findByRole('button', { name: /explore random photos/i })
    const videosLink = screen.getByRole('link', { name: 'Explore Videos' })
    expect(videosLink.parentElement).toContainElement(randomButton)
    expect(randomButton).toHaveClass('cursor-pointer')
    await waitFor(() => expect(api.fetchRandomPhotos).toHaveBeenCalledOnce())
    fireEvent.click(randomButton)

    expect(screen.getByRole('dialog', { name: 'Random photos from Ian Truong Photography' })).toBeInTheDocument()
    expect(screen.getByAltText('Full size preview')).toHaveAttribute(
      'src',
      expect.stringContaining('/site/hero/current/hero.jpg'),
    )
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => finishRequest(payload))
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close photo viewer' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.fetchRandomPhotos).toHaveBeenCalledOnce()
  })

  it('shows a cached album cover immediately while the whole-site random pool warms', async () => {
    catalog.getCatalogSnapshot.mockReturnValue({
      items: [{
        albumId: 'album-seed',
        title: 'Seed album',
        type: 'photo',
        category: 'Hikes',
        coverImageUrl: 'https://media.test/seed.jpg',
        coverThumbnailUrl: 'https://media.test/seed-thumb.jpg',
      }],
      nextCursor: null,
    })
    catalog.loadCompleteCatalog.mockResolvedValue({ items: [], nextCursor: null })
    let finishRequest
    api.fetchRandomPhotos.mockReturnValue(new Promise((resolve) => { finishRequest = resolve }))
    vi.spyOn(Math, 'random').mockReturnValue(0)
    routed(<Home />)

    const randomButton = await screen.findByRole('button', { name: /explore random photos/i })
    await waitFor(() => expect(api.fetchRandomPhotos).toHaveBeenCalledOnce())
    fireEvent.click(randomButton)

    expect(screen.getByAltText('Full size preview')).toHaveAttribute('src', 'https://media.test/seed.jpg')
    expect(screen.queryByRole('status')).toBeNull()

    await act(async () => finishRequest({
      images: [{
        id: 'full-photo',
        albumId: 'album-full',
        url: 'https://media.test/full.jpg',
        thumbnailUrl: 'https://media.test/full-thumb.jpg',
      }],
    }))
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeInTheDocument())
  })

  it('clears a broken cursor snapshot, reports errors, and retries', async () => {
    const error = Object.assign(new Error('Pagination broke'), { code: 'BAD_CURSOR' })
    catalog.loadCompleteCatalog.mockRejectedValueOnce(error).mockImplementationOnce(async ({ onPage }) => {
      onPage({ items: [], nextCursor: null })
      return { items: [], nextCursor: null }
    })
    routed(<Home />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Pagination broke')
    expect(catalog.deleteCatalogSnapshot).toHaveBeenCalledWith('public-photos')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(catalog.loadCompleteCatalog).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No photo albums found.')).toBeInTheDocument()
  })

  it('ignores aborted loading errors', async () => {
    catalog.loadCompleteCatalog.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    routed(<Home />)
    await waitFor(() => expect(screen.getByText('No photo albums found.')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a page callback that arrives after the component aborts', async () => {
    let finish
    catalog.loadCompleteCatalog.mockImplementation(({ onPage }) => new Promise((resolve) => {
      finish = () => {
        onPage({ items: [{ albumId: 'late', title: 'Late', type: 'photo' }], nextCursor: null })
        resolve({ items: [], nextCursor: null })
      }
    }))
    const view = routed(<Home />)
    view.unmount()
    await act(async () => finish())
    expect(catalog.setCatalogSnapshot).not.toHaveBeenCalled()
  })

  it('animates parallax/reveals in-view content and disconnects observers on cleanup', async () => {
    catalog.getCatalogSnapshot.mockReturnValue({ items: [{ albumId: '1', title: 'Animated', type: 'photo', category: 'Travel' }], nextCursor: null })
    catalog.loadCompleteCatalog.mockResolvedValue({ items: [], nextCursor: null })
    window.matchMedia = vi.fn(() => ({ matches: false }))
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 500 })
    let frameCallback
    window.requestAnimationFrame = vi.fn((callback) => { frameCallback = callback; return 9 })
    window.cancelAnimationFrame = vi.fn()
    let callback
    const unobserve = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(next) { callback = next }
      observe = vi.fn()
      unobserve = unobserve
      disconnect = disconnect
    })
    const { container, unmount } = routed(<Home />)
    fireEvent.scroll(window)
    fireEvent.scroll(window)
    expect(window.requestAnimationFrame).toHaveBeenCalledOnce()
    act(() => frameCallback())
    const hero = screen.getByRole('img', { name: 'Ian Truong Photography portfolio cover' })
    expect(hero).toHaveClass('home-hero-media', 'parallax-hero')
    expect(hero.style.transform).toBe('translateY(-24px)')
    expect(container.querySelector('section.home-hero')).toBeTruthy()
    expect(container.querySelector('.home-hero-overlay')).toBeTruthy()
    const target = container.querySelector('[data-reveal-id="home-photo-header"]')
    act(() => callback([{ isIntersecting: false, target }, { isIntersecting: true, target }]))
    expect(target).toHaveClass('is-visible')
    expect(scroll.markAsRevealed).toHaveBeenCalledWith('home-photo-header')
    expect(unobserve).toHaveBeenCalledWith(target)
    fireEvent.scroll(window)
    unmount()
    expect(disconnect).toHaveBeenCalled()
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(9)
  })

  it('falls back through the legacy managed hero before using the bundled responsive hero', async () => {
    catalog.loadCompleteCatalog.mockResolvedValue({ items: [], nextCursor: null })
    const { container } = routed(<Home />)
    const responsive = screen.getByRole('img', { name: 'Ian Truong Photography portfolio cover' })
    expect(responsive).toHaveAttribute('src', expect.stringContaining('/site/hero/current/hero.jpg'))
    expect(responsive).toHaveAttribute('srcset', expect.stringContaining('/site/hero/current/hero-960.jpg 960w'))
    expect(container.querySelector('source[type="image/avif"]')).toHaveAttribute(
      'srcset',
      expect.stringContaining('/site/hero/current/hero-960.avif 960w'),
    )
    fireEvent.error(responsive)
    const managed = screen.getByRole('img', { name: 'Ian Truong Photography portfolio cover' })
    expect(managed).toHaveAttribute('src', expect.stringContaining('/site/hero/home'))
    expect(container.querySelector('source[type="image/avif"]')).toBeNull()
    fireEvent.error(managed)
    const fallback = screen.getByRole('img', { name: 'Ian Truong Photography portfolio cover' })
    expect(fallback).toHaveAttribute('src', '/images/heroes/photo-1280.jpg')
    expect(fallback).toHaveAttribute('srcset')
    expect(fallback).toHaveClass('home-hero-media', 'parallax-hero')
    expect(container.querySelector('source[type="image/avif"]')).toBeTruthy()
  })

  it('paints the stable responsive hero without waiting for a manifest request', async () => {
    catalog.loadCompleteCatalog.mockResolvedValue({ items: [], nextCursor: null })
    routed(<Home />)
    const hero = screen.getByRole('img', { name: 'Ian Truong Photography portfolio cover' })
    expect(hero).toHaveAttribute('src', expect.stringContaining('/site/hero/current/hero.jpg'))
    expect(hero).toHaveAttribute('fetchpriority', 'high')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('Videos paginated catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    catalog.getCatalogSnapshot.mockReturnValue(null)
    scroll.isRevealed.mockReturnValue(false)
    window.matchMedia = vi.fn(() => ({ matches: true }))
  })

  it('loads, groups, deduplicates, and loads another page', async () => {
    api.fetchAlbumsPage
      .mockResolvedValueOnce({ items: [{ albumId: 'v1', title: 'First', type: 'video', category: 'Sports' }], nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [
        { albumId: 'v1', title: 'Updated', type: 'video', category: 'Sports' },
        { albumId: 'v2', title: 'Second', type: 'video' },
        { albumId: 'p1', title: 'Photo', type: 'photo' },
      ], nextCursor: null })
    routed(<Videos />)
    expect(await screen.findByText('First')).toBeInTheDocument()
    expect(screen.queryByText('Motion studies / Selected work')).toBeNull()
    expect(screen.queryByText('Studies in rhythm, movement & atmosphere')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Load more videos' }))
    expect(await screen.findByText('Updated')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
    expect(screen.queryByText('First')).toBeNull()
    expect(screen.queryByText('Photo')).toBeNull()
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  it('honors configured video category and album order', () => {
    catalog.getCatalogSnapshot.mockReturnValue({
      items: [
        { albumId: 'v2', title: 'Film Second', type: 'video', category: 'Films', galleryOrder: 1, galleryCategoryOrder: 1 },
        { albumId: 'v1', title: 'Film First', type: 'video', category: 'Films', galleryOrder: 0, galleryCategoryOrder: 1 },
        { albumId: 's1', title: 'Sports First', type: 'video', category: 'Sports', galleryCategoryOrder: 0 },
      ],
      nextCursor: null,
    })
    routed(<Videos />)

    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
      .toEqual(['Sports', 'Films'])
    expect(screen.getByTestId('videos-Films').textContent)
      .toBe('Film FirstFilm Second')
    expect(screen.getByText('Film First')).toHaveAttribute('data-video-preview', 'true')
    expect(screen.getByText('Film First').parentElement).toHaveClass(
      'w-[280px]',
      'sm:w-[320px]',
      'lg:w-[360px]',
    )
    expect(screen.getByText('Film First').parentElement).not.toHaveClass('md:w-[360px]')
  })

  it('sorts whole video sections locally and resets to curated order on remount', () => {
    const items = [
      { albumId: 'film-old', title: 'Film Old', type: 'video', category: 'Films', galleryOrder: 0, galleryCategoryOrder: 0, uploadedAt: '2026-08-01T12:00:00Z' },
      { albumId: 'film-new', title: 'Film New', type: 'video', category: 'Films', galleryOrder: 1, galleryCategoryOrder: 0, uploadedAt: '2026-08-02T12:00:00Z' },
      { albumId: 'sports-new', title: 'Sports New', type: 'video', category: 'Sports', galleryCategoryOrder: 1, uploadedAt: '2026-08-22T12:00:00Z' },
    ]
    catalog.getCatalogSnapshot.mockReturnValue({ items, nextCursor: null })
    const view = routed(<Videos />)
    const sectionSort = screen.getByLabelText('Sort video sections')

    expect(sectionSort).toHaveValue('0')
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
      .toEqual(['Films', 'Sports'])
    expect(screen.getByTestId('videos-Films')).toHaveTextContent('Film OldFilm New')

    fireEvent.change(sectionSort, { target: { value: '1' } })
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
      .toEqual(['Sports', 'Films'])
    expect(screen.getByTestId('videos-Films')).toHaveTextContent('Film OldFilm New')

    view.unmount()
    routed(<Videos />)
    expect(screen.getByLabelText('Sort video sections')).toHaveValue('0')
  })

  it('renders initial and load-more failures and blocks duplicate load clicks', async () => {
    api.fetchAlbumsPage.mockRejectedValueOnce(new Error('Initial videos failed'))
    const first = routed(<Videos />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Initial videos failed')
    first.unmount()

    catalog.getCatalogSnapshot.mockReturnValue({
      items: [{ albumId: 'v1', title: 'Cached video', type: 'video', category: 'Film' }],
      nextCursor: 'next',
    })
    let rejectPage
    api.fetchAlbumsPage.mockImplementation(() => new Promise((_resolve, reject) => { rejectPage = reject }))
    routed(<Videos />)
    const button = screen.getByRole('button', { name: 'Load more videos' })
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Loading…' }))
    expect(api.fetchAlbumsPage).toHaveBeenCalledTimes(2)
    await act(async () => rejectPage(new Error('More failed')))
    expect(screen.getByRole('alert')).toHaveTextContent('More failed')
  })

  it('shows the empty catalog state', () => {
    catalog.getCatalogSnapshot.mockReturnValue({ items: [], nextCursor: null })
    routed(<Videos />)
    expect(screen.getByText('No video projects found.')).toBeInTheDocument()
  })

  it('reveals a cached section immediately and uses safe fallback error messages', async () => {
    catalog.getCatalogSnapshot.mockReturnValue({
      items: [
        { albumId: 'u', title: 'Uncategorized first', type: 'video' },
        { albumId: 'f', title: 'Film second', type: 'video', category: 'Film' },
      ],
      nextCursor: 'next',
    })
    scroll.isRevealed.mockReturnValue(true)
    api.fetchAlbumsPage.mockRejectedValueOnce({})
    const { container } = routed(<Videos />)
    expect(container.querySelector('[data-reveal-id="video-projects-header"]')).toHaveClass('is-visible', 'no-stagger')
    fireEvent.click(screen.getByRole('button', { name: 'Load more videos' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('More videos could not be loaded.')
  })

  it('animates its hero and reveals intersecting category sections', async () => {
    catalog.getCatalogSnapshot.mockReturnValue({ items: [{ albumId: 'v', title: 'Animated video', type: 'video', category: 'Film' }], nextCursor: null })
    window.matchMedia = vi.fn(() => ({ matches: false }))
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 200 })
    let frameCallback
    window.requestAnimationFrame = vi.fn((next) => { frameCallback = next; return 4 })
    window.cancelAnimationFrame = vi.fn()
    let callback
    const unobserve = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(next) { callback = next }
      observe() {}
      unobserve = unobserve
      disconnect() {}
    })
    const { container, unmount } = routed(<Videos />)
    fireEvent.scroll(window)
    fireEvent.scroll(window)
    expect(window.requestAnimationFrame).toHaveBeenCalledOnce()
    act(() => frameCallback())
    expect(screen.getByRole('img', { name: 'Cinematography' }).style.transform).toBe('translateY(30px)')
    const target = container.querySelector('[data-reveal-id="video-projects-header"]')
    act(() => callback([{ isIntersecting: false, target }, { isIntersecting: true, target }]))
    expect(target).toHaveClass('is-visible')
    expect(unobserve).toHaveBeenCalledWith(target)
    fireEvent.scroll(window)
    unmount()
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(4)
  })

  it('falls back through the managed video hero before the bundled video image', () => {
    catalog.getCatalogSnapshot.mockReturnValue({ items: [], nextCursor: null })
    const { container } = routed(<Videos />)
    const responsive = screen.getByRole('img', { name: 'Cinematography' })
    expect(responsive).toHaveAttribute('src', expect.stringContaining('/site/hero/video/current/hero.jpg'))
    expect(responsive).toHaveAttribute('srcset', expect.stringContaining('/site/hero/video/current/hero-960.jpg 960w'))
    expect(container.querySelector('source[type="image/avif"]')).toHaveAttribute(
      'srcset',
      expect.stringContaining('/site/hero/video/current/hero-960.avif 960w'),
    )
    fireEvent.error(responsive)
    const managed = screen.getByRole('img', { name: 'Cinematography' })
    expect(managed).toHaveAttribute('src', expect.stringContaining('/site/hero/video/home'))
    expect(container.querySelector('source[type="image/avif"]')).toBeNull()
    fireEvent.error(managed)
    const fallback = screen.getByRole('img', { name: 'Cinematography' })
    expect(fallback).toHaveAttribute('src', '/images/heroes/video-1280.jpg')
    expect(fallback).toHaveAttribute('srcset', expect.stringContaining('/images/heroes/video-960.jpg 960w'))
  })
})
