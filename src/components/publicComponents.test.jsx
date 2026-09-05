import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hlsInstances = []
vi.mock('hls.js', () => {
  class Hls {
    static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' }
    static isSupported = vi.fn(() => true)
    constructor() {
      this.handlers = {}
      this.loadSource = vi.fn()
      this.attachMedia = vi.fn()
      this.on = vi.fn((event, callback) => { this.handlers[event] = callback })
      this.destroy = vi.fn()
      hlsInstances.push(this)
    }
  }
  return { default: Hls }
})
vi.mock('react-blurhash', () => ({ Blurhash: () => <div data-testid="blurhash" /> }))

import { AuthContext } from '../context/auth'
import Hls from 'hls.js'
import AlbumCard from './AlbumCard'
import BackToTop from './BackToTop'
import DocumentMetadata from './DocumentMetadata'
import Navbar from './Navbar'
import ProgressiveImage from './ProgressiveImage'
import ScrollRow from './ScrollRow'
import VideoPlayer from './VideoPlayer'

function routed(ui, auth = { user: null, isAdmin: false, logout: vi.fn() }, path = '/') {
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('AlbumCard', () => {
  it('routes photo, single-video, and multi-video cards correctly', () => {
    const photo = routed(<AlbumCard album={{ albumId: 'p 1', title: 'Wildlife', description: 'Birds', createdAt: '2026-01-02', coverImageUrl: 'https://x.test/a' }} />)
    expect(screen.getByRole('link', { name: /Wildlife/ })).toHaveAttribute('href', '/album/p 1')
    expect(screen.queryByText('Photographic series')).toBeNull()
    expect(screen.getByText('Birds')).toBeInTheDocument()
    expect(screen.getByText(/January [12], 2026/)).toBeInTheDocument()
    photo.unmount()

    const single = routed(<AlbumCard album={{ albumId: 'v', title: 'One', type: 'video', imageCount: 1 }} />)
    expect(screen.getByRole('link', { name: /One/ })).toHaveAttribute('href', '/video/v?play=1')
    expect(screen.queryByText('Moving image')).toBeNull()
    single.unmount()

    routed(<AlbumCard album={{ albumId: 'v2', title: 'Series', type: 'video', imageCount: 3 }} />)
    expect(screen.getByRole('link', { name: /Series/ })).toHaveAttribute('href', '/video/v2')
    expect(screen.getByText('3')).toBeInTheDocument()
  })
})

describe('navigation and metadata', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback) => { callback(); return 1 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 })
    document.body.style.overflow = ''
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-lightbox-scroll-lock')
    vi.unstubAllGlobals()
  })

  it('opens and closes the guest menu and resets the body lock', () => {
    const { unmount } = routed(<Navbar />)
    const toggle = screen.getByRole('button', { name: 'Open menu' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', 'site-menu')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true')
    expect(document.body.style.overflow).toBe('hidden')
    const menu = document.getElementById('site-menu')
    expect(menu).not.toHaveAttribute('inert')
    expect(within(menu).getByRole('link', { name: 'Sign In' })).toHaveAttribute('href', '/login')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.body.style.overflow).toBe('')
    expect(document.getElementById('site-menu')).toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus()
    unmount()
    expect(document.body.style.overflow).toBe('')
  })

  it('restores existing page styles and scroll position after closing or unmounting the menu', () => {
    document.body.style.overflow = 'clip'
    document.body.style.position = 'relative'
    document.body.style.width = '95%'
    document.documentElement.style.overflow = 'auto'
    document.documentElement.style.overscrollBehavior = 'contain'
    window.scrollY = 320
    const { unmount } = routed(<Navbar />)
    const menu = document.getElementById('site-menu')
    menu.scrollTop = 240
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(menu.scrollTop).toBe(0)
    expect(document.body.style.position).toBe('fixed')
    expect(document.body.style.top).toBe('-320px')
    expect(document.documentElement.style.overflow).toBe('hidden')
    expect(document.documentElement).toHaveAttribute('data-menu-scroll-lock')
    menu.scrollTop = 480
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }))
    expect(document.body.style.overflow).toBe('clip')
    expect(document.body.style.position).toBe('relative')
    expect(document.body.style.width).toBe('95%')
    expect(document.documentElement.style.overflow).toBe('auto')
    expect(document.documentElement.style.overscrollBehavior).toBe('contain')
    expect(document.documentElement).not.toHaveAttribute('data-menu-scroll-lock')
    expect(window.scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 320, behavior: 'instant' })

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(menu.scrollTop).toBe(0)
    unmount()
    expect(document.body.style.overflow).toBe('clip')
    expect(document.body.style.position).toBe('relative')
    expect(document.documentElement).not.toHaveAttribute('data-menu-scroll-lock')
    document.body.style.cssText = ''
    document.documentElement.style.cssText = ''
  })

  it('keeps the close button on screen while scrolling an open menu', async () => {
    window.requestAnimationFrame = callback => { queueMicrotask(callback); return 1 }
    const { container } = routed(<Navbar />)
    const nav = container.querySelector('nav')
    window.scrollY = 200
    fireEvent.scroll(window)
    await waitFor(() => expect(nav).toHaveClass('-translate-y-full'))
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(nav).toHaveClass('translate-y-0')
    window.scrollY = 0
    fireEvent.scroll(window)
    await act(async () => {})
    expect(nav).toHaveClass('translate-y-0')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus()
    expect(window.scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 200, behavior: 'instant' })
  })

  it('offers an accessible theme toggle beside the brand on public routes', () => {
    const toggleTheme = vi.fn()
    const light = routed(<Navbar theme="light" onToggleTheme={toggleTheme} />)
    const toggle = screen.getByRole('button', { name: 'Switch to dark mode' })
    const search = screen.getByRole('link', { name: 'Search' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle.closest('.linen-brand-cluster')).toContainElement(screen.getByRole('link', { name: /Ian Truong/ }))
    expect(search).toHaveAttribute('href', '/search')
    expect(toggle.closest('.linen-brand-cluster')).toContainElement(search)
    fireEvent.click(toggle)
    expect(toggleTheme).toHaveBeenCalledOnce()
    light.unmount()

    const dark = routed(<Navbar theme="dark" onToggleTheme={toggleTheme} />)
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toHaveAttribute('aria-pressed', 'true')
    dark.unmount()

    routed(<Navbar theme="dark" onToggleTheme={toggleTheme} showThemeToggle={false} />, undefined, '/admin')
    expect(screen.queryByRole('button', { name: /Switch to .* mode/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute('href', '/search')
  })

  it('uses the brand search control instead of a named navigation item', () => {
    const { container } = routed(<Navbar />, undefined, '/search')
    const search = screen.getByRole('link', { name: 'Search' })
    expect(search).toHaveAttribute('aria-current', 'page')
    expect(within(container.querySelector('.linen-desktop-links')).queryByRole('link', { name: 'Search' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(within(document.getElementById('site-menu')).queryByRole('link', { name: 'Search' })).toBeNull()
    fireEvent.click(search)
    expect(document.body.style.overflow).toBe('')
  })

  it.each([
    [/Ian Truong/, '/'],
    ['Find Album', '/sharedalbum'],
    ['Explore', '/explore'],
    ['Editor', '/editor'],
    ['Stats', '/stats'],
    ['Contact', '/contact'],
    ['Sign In', '/login'],
  ])('closes the guest menu through %s', (name, destination) => {
    const view = routed(<Navbar />)
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const link = name instanceof RegExp
      ? screen.getByRole('link', { name })
      : within(document.getElementById('site-menu')).getByRole('link', { name })
    expect(link).toHaveAttribute('href', destination)
    fireEvent.click(link)
    expect(document.body.style.overflow).toBe('')
    view.unmount()
  })

  it('shows role-aware dashboards, logs out, and hides/reveals with scroll direction', async () => {
    window.requestAnimationFrame = (callback) => { queueMicrotask(callback); return 1 }
    const logout = vi.fn()
    const { container } = routed(<Navbar />, { user: { email: 'admin@test' }, isAdmin: true, logout })
    const nav = container.querySelector('nav')
    const desktopLinks = container.querySelector('.linen-desktop-links')
    const dashboardLink = within(desktopLinks).getByRole('link', { name: 'Dashboard' })
    const desktopSignOut = within(desktopLinks).getByRole('button', { name: 'Sign Out' })
    expect(dashboardLink).toHaveAttribute('href', '/admin')
    expect(dashboardLink.nextElementSibling).toBe(desktopSignOut)
    fireEvent.click(desktopSignOut)
    expect(logout).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(within(document.getElementById('site-menu')).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/admin')
    fireEvent.click(within(document.getElementById('site-menu')).getByRole('button', { name: 'Sign Out' }))
    expect(logout).toHaveBeenCalledTimes(2)

    window.scrollY = 100
    fireEvent.scroll(window)
    await waitFor(() => expect(nav).toHaveClass('-translate-y-full'))
    document.documentElement.setAttribute('data-lightbox-scroll-lock', '')
    window.scrollY = 0
    fireEvent.scroll(window)
    await waitFor(() => expect(nav).toHaveClass('-translate-y-full'))
    document.documentElement.removeAttribute('data-lightbox-scroll-lock')
    window.scrollY = 100
    fireEvent.scroll(window)
    await waitFor(() => expect(nav).toHaveClass('-translate-y-full'))
    window.scrollY = 20
    fireEvent.scroll(window)
    await waitFor(() => expect(nav).toHaveClass('translate-y-0'))
  })

  it('routes a signed-in viewer to the user dashboard and closes through every menu link', () => {
    const auth = { user: { email: 'viewer@test' }, isAdmin: false, logout: vi.fn() }
    routed(<Navbar />, auth)
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const menu = document.getElementById('site-menu')
    expect(within(menu).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard')
    fireEvent.click(within(menu).getByRole('link', { name: 'Dashboard' }))
    expect(document.body.style.overflow).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    fireEvent.click(within(menu).getByRole('link', { name: 'Videos' }))
    expect(document.body.style.overflow).toBe('')
  })

  it('sets and reuses a canonical URL for the current pathname', () => {
    const existing = document.querySelector('link[rel="canonical"]')
    existing?.remove()
    const first = routed(<DocumentMetadata />, undefined, '/album/test')
    expect(document.querySelector('link[rel="canonical"]')).toHaveAttribute('href', 'https://iantruongphotography.com/album/test')
    first.unmount()
    routed(<DocumentMetadata />, undefined, '/videos')
    expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1)
    expect(document.querySelector('link[rel="canonical"]')).toHaveAttribute('href', 'https://iantruongphotography.com/videos')
  })
})

describe('scroll controls and progressive loading', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback) => { callback(); return 1 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('reveals BackToTop after scrolling and cancels a queued frame on cleanup', () => {
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 600 })
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const { unmount } = render(<BackToTop />)
    fireEvent.scroll(window)
    fireEvent.click(screen.getByRole('button', { name: 'Back to top' }))
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
    unmount()
  })

  it('coalesces queued scroll work, stays hidden below threshold, and cancels on cleanup', () => {
    let callback
    const request = vi.fn((next) => { callback = next; return 77 })
    const cancel = vi.fn()
    window.requestAnimationFrame = request
    window.cancelAnimationFrame = cancel
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 100 })
    const { unmount } = render(<BackToTop />)
    fireEvent.scroll(window)
    fireEvent.scroll(window)
    expect(request).toHaveBeenCalledOnce()
    act(() => callback())
    expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull()
    fireEvent.scroll(window)
    unmount()
    expect(cancel).toHaveBeenCalledWith(77)
  })

  it('hides BackToTop while the footer is visible', () => {
    let intersectionCallback
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { intersectionCallback = callback }
      observe() {}
      disconnect() { disconnect() }
    })
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 600 })
    const { unmount } = render(<><BackToTop /><footer>Footer</footer></>)
    fireEvent.scroll(window)
    expect(screen.getByRole('button', { name: 'Back to top' })).toBeInTheDocument()
    act(() => intersectionCallback([{ isIntersecting: true }]))
    expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull()
    unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('restores, persists, and operates both ScrollRow arrows', () => {
    sessionStorage.clear()
    const { container, unmount } = render(<ScrollRow scrollKey="test"><div>item</div></ScrollRow>)
    const scroller = container.querySelector('.overflow-x-auto')
    expect(scroller).toHaveClass('px-8', '-mx-6')
    expect(scroller).toHaveStyle({ scrollPaddingInline: '2rem' })
    expect(scroller.style.maskImage)
      .toBe('linear-gradient(90deg,transparent,#000 4%,#000 96%,transparent)')
    Object.defineProperties(scroller, {
      scrollLeft: { configurable: true, writable: true, value: 10 },
      scrollWidth: { configurable: true, value: 1000 },
      clientWidth: { configurable: true, value: 300 },
    })
    scroller.scrollBy = vi.fn()
    fireEvent.scroll(scroller)
    act(() => vi.advanceTimersByTime(500))
    const leftButton = screen.getByRole('button', { name: 'Scroll left' })
    const rightButton = screen.getByRole('button', { name: 'Scroll right' })
    expect(leftButton).toHaveClass('left-3')
    expect(leftButton).not.toHaveClass('-translate-x-1/2')
    expect(rightButton).toHaveClass('right-3')
    expect(rightButton).not.toHaveClass('translate-x-1/2')
    fireEvent.click(leftButton)
    fireEvent.click(rightButton)
    expect(scroller.scrollBy).toHaveBeenNthCalledWith(1, { left: -240, behavior: 'smooth' })
    expect(scroller.scrollBy).toHaveBeenNthCalledWith(2, { left: 240, behavior: 'smooth' })
    unmount()

    vi.stubGlobal('ResizeObserver', undefined)
    const restored = render(<ScrollRow scrollKey="test"><div>again</div></ScrollRow>)
    expect(restored.container.querySelector('.overflow-x-auto').scrollLeft).toBe(10)
    fireEvent.resize(window)
    restored.unmount()
  })

  it('supports an unkeyed non-overflowing row without persisting scroll', () => {
    const { container } = render(<ScrollRow><div>small</div></ScrollRow>)
    const scroller = container.querySelector('.overflow-x-auto')
    fireEvent.scroll(scroller)
    fireEvent.scroll(scroller)
    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByRole('button', { name: /Scroll/ })).toBeNull()
  })

  it('loads lazily at intersection and fades out the blur placeholder on load', () => {
    let observerCallback
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { observerCallback = callback }
      observe() {}
      disconnect() { disconnect() }
    })
    const { container } = render(<ProgressiveImage src="https://x.test/a.jpg" blurhash="LEHV6nWB2yk8pyo0adR*.7kCMdnj" alt="Lazy" />)
    expect(screen.queryByRole('img', { name: 'Lazy' })).toBeNull()
    act(() => observerCallback([{ isIntersecting: false }]))
    expect(screen.queryByRole('img', { name: 'Lazy' })).toBeNull()
    act(() => observerCallback([{ isIntersecting: true }]))
    const image = screen.getByRole('img', { name: 'Lazy' })
    fireEvent.load(image)
    expect(container.querySelector('[aria-hidden="true"]')).toHaveClass('opacity-0')
    expect(disconnect).toHaveBeenCalled()
  })

  it('loads immediately when IntersectionObserver is unavailable or eager', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const first = render(<ProgressiveImage src="https://x.test/fallback.jpg" alt="Fallback" />)
    expect(screen.getByRole('img', { name: 'Fallback' })).toHaveAttribute('loading', 'lazy')
    first.unmount()
    render(<ProgressiveImage eager src="https://x.test/eager.jpg" alt="Eager" />)
    expect(screen.getByRole('img', { name: 'Eager' })).toHaveAttribute('fetchpriority', 'high')
  })
})

describe('VideoPlayer', () => {
  beforeEach(() => {
    hlsInstances.length = 0
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('')
  })

  it('plays a raw video and reports raw playback errors', () => {
    const onMediaError = vi.fn()
    const { container, unmount } = render(<VideoPlayer videoInfo={{ url: 'https://x.test/raw.mp4', thumbnailUrl: 'poster' }} onMediaError={onMediaError} />)
    const video = container.querySelector('video')
    expect(video.src).toBe('https://x.test/raw.mp4')
    fireEvent.error(video)
    expect(onMediaError).toHaveBeenCalledOnce()
    unmount()
    expect(video.getAttribute('src')).toBeNull()
  })

  it('uses native HLS and falls back to raw after an HLS error', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably')
    const { container } = render(<VideoPlayer videoInfo={{ url: 'https://x.test/raw.mp4', hlsUrl: 'https://x.test/hls.m3u8' }} />)
    const video = container.querySelector('video')
    expect(video.src).toBe('https://x.test/hls.m3u8')
    fireEvent.loadedMetadata(video)
    fireEvent.error(video)
    await waitFor(() => expect(video.src).toBe('https://x.test/raw.mp4'))
  })

  it('attaches hls.js, starts on manifest, and destroys it at cleanup', async () => {
    const { unmount } = render(<VideoPlayer videoInfo={{ url: 'https://x.test/raw.mp4', hlsUrl: 'https://x.test/hls.m3u8' }} />)
    await waitFor(() => expect(hlsInstances).toHaveLength(1))
    const instance = hlsInstances[0]
    expect(instance.loadSource).toHaveBeenCalledWith('https://x.test/hls.m3u8')
    act(() => instance.handlers.manifest())
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
    unmount()
    expect(instance.destroy).toHaveBeenCalledOnce()
  })

  it('falls back when hls.js is unsupported or emits a fatal error and respects autoplay=false', async () => {
    Hls.isSupported.mockReturnValueOnce(false)
    const unsupported = render(<VideoPlayer autoplay={false} videoInfo={{ url: 'https://x.test/raw.mp4', hlsUrl: 'https://x.test/hls.m3u8' }} />)
    await waitFor(() => expect(unsupported.container.querySelector('video').src).toBe('https://x.test/raw.mp4'))
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    unsupported.unmount()

    render(<VideoPlayer videoInfo={{ url: 'https://x.test/raw2.mp4', hlsUrl: 'https://x.test/hls2.m3u8' }} />)
    await waitFor(() => expect(hlsInstances).toHaveLength(1))
    act(() => hlsInstances[0].handlers.error(null, { fatal: false }))
    act(() => hlsInstances[0].handlers.error(null, { fatal: true }))
    await waitFor(() => expect(document.querySelector('video').src).toBe('https://x.test/raw2.mp4'))
  })

  it('does nothing without any playable URL', () => {
    const { container } = render(<VideoPlayer videoInfo={{}} />)
    expect(container.querySelector('video')).not.toHaveAttribute('src')
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled()
  })
})
