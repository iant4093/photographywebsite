import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchAlbumsPage: vi.fn() }))
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
vi.mock('../components/AlbumCard', () => ({ default: ({ album }) => <a href={`/${album.type === 'video' ? 'video' : 'album'}/${album.albumId}`}>{album.title}</a> }))
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
  })
  afterEach(() => vi.restoreAllMocks())

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
    expect(screen.queryByRole('status')).toBeNull()
    await waitFor(() => expect(container.querySelector('[data-reveal-id="home-photo-header"]')).toHaveClass('is-visible', 'no-stagger'))
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
    const hero = screen.getByRole('img', { name: 'Golden hour landscape' })
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

  it('falls back to the bundled responsive hero if the managed CDN object is unavailable', async () => {
    catalog.loadCompleteCatalog.mockResolvedValue({ items: [], nextCursor: null })
    const { container } = routed(<Home />)
    const managed = screen.getByRole('img', { name: 'Golden hour landscape' })
    fireEvent.error(managed)
    const fallback = screen.getByRole('img', { name: 'Golden hour landscape' })
    expect(fallback).toHaveAttribute('src', '/images/heroes/photo-1280.jpg')
    expect(fallback).toHaveAttribute('srcset')
    expect(fallback).toHaveClass('home-hero-media', 'parallax-hero')
    expect(container.querySelector('source[type="image/avif"]')).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: 'Load more videos' }))
    expect(await screen.findByText('Updated')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
    expect(screen.queryByText('First')).toBeNull()
    expect(screen.queryByText('Photo')).toBeNull()
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
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
})
