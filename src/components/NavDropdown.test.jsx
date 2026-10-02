import { act, createEvent, fireEvent, render, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/api', () => ({ fetchAlbumsPage: vi.fn() }))

import { AuthContext } from '../context/auth'
import { catalogSections } from '../hooks/useNavSections'
import { fetchAlbumsPage } from '../utils/api'
import { clearCatalogSnapshots, setCatalogSnapshot } from '../utils/catalogState'
import { EXPLORE_MODULES } from '../utils/exploreModules'
import Navbar from './Navbar'

const auth = { user: null, isAdmin: false, logout: vi.fn() }
const renderNavbar = (path) => render(
  <AuthContext.Provider value={auth}>
    <MemoryRouter initialEntries={[path]}><Navbar /></MemoryRouter>
  </AuthContext.Provider>,
)
// The dropdowns load lazily, so wait until they replace the plain links.
const routed = async (path = '/') => {
  const view = renderNavbar(path)
  await waitFor(() => expect(view.container.querySelectorAll('.linen-nav-dropdown')).toHaveLength(3))
  return view
}
const stubHoverDesktop = (matches) => {
  window.matchMedia = vi.fn(query => ({
    matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }))
}
const desktop = (container) => container.querySelector('.linen-desktop-links')
const trigger = (container, name) => within(desktop(container)).getByRole('link', { name })
const panelFor = (link) => document.getElementById(link.getAttribute('aria-controls'))

describe('desktop navigation dropdowns', () => {
  const originalMatchMedia = window.matchMedia
  beforeEach(() => {
    clearCatalogSnapshots()
    fetchAlbumsPage.mockReset()
    stubHoverDesktop(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    window.matchMedia = originalMatchMedia
  })

  it('keeps plain links without loading dropdowns on touch or narrow screens', () => {
    stubHoverDesktop(false)
    const { container } = renderNavbar('/')
    expect(trigger(container, 'Photographs')).not.toHaveAttribute('aria-expanded')
    expect(container.querySelector('.linen-nav-dropdown')).toBeNull()
  })

  it('groups the public catalog into curated sections with album counts', () => {
    expect(catalogSections([
      { albumId: 'a', category: 'Wildlife' },
      { albumId: 'b', category: 'Wildlife', galleryOrder: 0 },
      { albumId: 'c', category: 'Landscapes' },
      { albumId: 'd' },
      { albumId: 'e', category: 'Hidden', visibility: 'private' },
      { albumId: 'f', category: 'Clips', type: 'video' },
    ], 'photo')).toEqual([
      { category: 'Landscapes', count: 1 },
      { category: 'Wildlife', count: 2 },
      { category: 'Uncategorized', count: 1 },
    ])
    expect(catalogSections([{ albumId: 'f', category: 'Clips', type: 'video' }], 'video'))
      .toEqual([{ category: 'Clips', count: 1 }])
  })

  it('loads photo sections on hover and links each to its section page', async () => {
    fetchAlbumsPage.mockResolvedValue({
      items: [
        { albumId: 'a', type: 'photo', category: 'Wildlife', visibility: 'public' },
        { albumId: 'b', type: 'photo', category: 'Night Sky', visibility: 'public' },
      ],
      nextCursor: null,
    })
    const { container } = await routed('/sections/photo/Night%20Sky')
    const photos = trigger(container, 'Photographs')
    expect(photos).toHaveAttribute('aria-expanded', 'false')
    expect(panelFor(photos)).toHaveAttribute('inert')
    expect(fetchAlbumsPage).not.toHaveBeenCalled()

    fireEvent.pointerEnter(photos.parentElement)
    expect(photos).toHaveAttribute('aria-expanded', 'true')
    expect(photos).toHaveAttribute('aria-current', 'page')
    const panel = panelFor(photos)
    expect(panel).not.toHaveAttribute('inert')
    expect(panel).toHaveTextContent('Loading sections…')
    expect(fetchAlbumsPage).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'public', type: 'photo' }),
      expect.anything(),
    )

    const night = await within(panel).findByRole('link', { name: /Night Sky/ })
    expect(night).toHaveAttribute('href', '/sections/photo/Night%20Sky')
    expect(night).toHaveAttribute('aria-current', 'page')
    expect(within(panel).getByRole('link', { name: /Wildlife/ })).toHaveAttribute('href', '/sections/photo/Wildlife')
    expect(within(panel).getByRole('link', { name: /All photo albums/ })).toHaveAttribute('href', '/#photo-albums')

    fireEvent.click(night)
    expect(photos).toHaveAttribute('aria-expanded', 'false')
  })

  it('reuses a fresh catalog snapshot and picks up new sections once it changes', async () => {
    setCatalogSnapshot('public-videos', {
      items: [{ albumId: 'v1', type: 'video', category: 'Weddings', visibility: 'public' }],
      nextCursor: null,
    })
    const { container } = await routed()
    const videos = trigger(container, 'Videos')
    fireEvent.pointerEnter(videos.parentElement)
    expect(within(panelFor(videos)).getByRole('link', { name: /Weddings/ })).toHaveAttribute('href', '/sections/video/Weddings')
    expect(fetchAlbumsPage).not.toHaveBeenCalled()

    fireEvent.pointerLeave(videos.parentElement)
    setCatalogSnapshot('public-videos', {
      items: [
        { albumId: 'v1', type: 'video', category: 'Weddings', visibility: 'public' },
        { albumId: 'v2', type: 'video', category: 'Travel', visibility: 'public' },
      ],
      nextCursor: null,
    })
    fireEvent.pointerEnter(videos.parentElement)
    expect(within(panelFor(videos)).getByRole('link', { name: /Travel/ })).toHaveAttribute('href', '/sections/video/Travel')
  })

  it('reports an unavailable catalog without breaking navigation', async () => {
    fetchAlbumsPage.mockRejectedValue(new Error('offline'))
    const { container } = await routed()
    const photos = trigger(container, 'Photographs')
    fireEvent.pointerEnter(photos.parentElement)
    await waitFor(() => expect(panelFor(photos)).toHaveTextContent('Sections are unavailable right now.'))
    expect(photos).toHaveAttribute('href', '/')
  })

  it('lists every Explore module and ignores touch hovers', async () => {
    const { container } = await routed('/explore/lenses')
    const explore = trigger(container, 'Explore')
    // React derives pointerenter from pointerover; jsdom has no PointerEvent, so
    // set the pointer type on the event directly.
    const touch = createEvent.pointerOver(explore.parentElement)
    Object.defineProperty(touch, 'pointerType', { value: 'touch' })
    fireEvent(explore.parentElement, touch)
    expect(explore).toHaveAttribute('aria-expanded', 'false')

    fireEvent.pointerEnter(explore.parentElement)
    const panel = panelFor(explore)
    for (const module of EXPLORE_MODULES) {
      expect(within(panel).getByRole('link', { name: new RegExp(module.title) })).toHaveAttribute('href', module.path)
    }
    expect(within(panel).getByRole('link', { name: /Lens Explorer/ })).toHaveAttribute('aria-current', 'page')
    expect(fetchAlbumsPage).not.toHaveBeenCalled()
  })

  it('closes after the pointer leaves unless it comes back first', async () => {
    const { container } = await routed()
    vi.useFakeTimers()
    const explore = trigger(container, 'Explore')
    fireEvent.pointerEnter(explore.parentElement)
    fireEvent.pointerLeave(explore.parentElement)
    expect(explore).toHaveAttribute('aria-expanded', 'true')
    fireEvent.pointerEnter(explore.parentElement)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(explore).toHaveAttribute('aria-expanded', 'true')

    fireEvent.pointerLeave(explore.parentElement)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(explore).toHaveAttribute('aria-expanded', 'false')
  })

  it('supports keyboard navigation through a panel', async () => {
    const { container } = await routed()
    const explore = trigger(container, 'Explore')
    explore.focus()
    fireEvent.keyDown(explore, { key: 'ArrowDown' })
    expect(explore).toHaveAttribute('aria-expanded', 'true')
    const links = within(panelFor(explore)).getAllByRole('link')
    expect(links[0]).toHaveFocus()
    fireEvent.keyDown(links[0], { key: 'ArrowDown' })
    expect(links[1]).toHaveFocus()
    fireEvent.keyDown(links[1], { key: 'ArrowUp' })
    fireEvent.keyDown(links[0], { key: 'ArrowUp' })
    expect(explore).toHaveFocus()
    fireEvent.keyDown(explore, { key: 'Escape' })
    expect(explore).toHaveAttribute('aria-expanded', 'false')
    expect(explore).toHaveFocus()
  })

  it('leaves Editor, Stats, Find Album, and Contact as plain links', async () => {
    const { container } = await routed()
    for (const name of ['Editor', 'Stats', 'Find Album', 'Contact', 'Sign In']) {
      const link = trigger(container, name)
      expect(link).not.toHaveAttribute('aria-expanded')
      expect(link.parentElement).toBe(desktop(container))
    }
  })
})
