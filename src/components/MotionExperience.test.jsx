import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MotionExperience from './MotionExperience'

function renderExperience(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <main>
        <section className="home-hero" />
        <div className="album-card" />
        <header className="photo-stats-hero" />
        <section className="photo-stats-motion-section">
          <article className="photo-stats-card" />
          <article className="photo-stats-card" />
        </section>
      </main>
      <MotionExperience />
    </MemoryRouter>,
  )
}

describe('MotionExperience film-strip scrollbar', () => {
  let frames
  let frameId

  const flushFrames = () => {
    act(() => {
      while (frames.length) frames.shift()()
    })
  }

  beforeEach(() => {
    frames = []
    frameId = 0
    window.matchMedia = vi.fn(() => ({ matches: false }))
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      frames.push(callback)
      frameId += 1
      return frameId
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('IntersectionObserver', undefined)
    vi.stubGlobal('MutationObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('PointerEvent', MouseEvent)
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 1000 })
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2000 })
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  })

  afterEach(() => {
    document.documentElement.classList.remove('editorial-motion-active', 'editorial-scrollbar-active')
    document.documentElement.style.removeProperty('--editorial-progress')
    document.documentElement.style.removeProperty('--editorial-speed')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('moves the thumb with page progress and exposes live scrollbar semantics', () => {
    const view = renderExperience()
    const rail = screen.getByRole('scrollbar', { name: 'Page scroll position' })
    const thumb = rail.firstElementChild
    Object.defineProperty(rail, 'clientHeight', { configurable: true, value: 600 })
    Object.defineProperty(thumb, 'offsetHeight', { configurable: true, value: 120 })

    flushFrames()
    expect(document.documentElement).toHaveClass('editorial-motion-active', 'editorial-scrollbar-active')
    expect(view.container.querySelector('.editorial-light-leak')).toBeNull()
    expect(view.container.querySelector('.editorial-exposure-sweep')).toBeNull()
    expect(view.container.querySelector('.editorial-gate')).toBeNull()
    expect(view.container.querySelector('.editorial-motion-overlay')).toBeNull()
    expect(rail).toHaveAttribute('aria-valuemin', '0')
    expect(rail).toHaveAttribute('aria-valuemax', '100')
    expect(rail).toHaveAttribute('aria-valuenow', '0')
    expect(rail.style.getPropertyValue('--editorial-progress-offset')).toBe('0.00px')
    expect(rail.hidden).toBe(false)

    window.scrollY = 500
    fireEvent.scroll(window)
    flushFrames()
    expect(rail).toHaveAttribute('aria-valuenow', '50')
    expect(rail.style.getPropertyValue('--editorial-progress-offset')).toBe('240.00px')

    view.unmount()
    expect(document.documentElement).not.toHaveClass('editorial-motion-active', 'editorial-scrollbar-active')
  })

  it('supports keyboard, track clicks, and thumb dragging', () => {
    renderExperience()
    const rail = screen.getByRole('scrollbar', { name: 'Page scroll position' })
    const thumb = rail.firstElementChild
    Object.defineProperty(rail, 'clientHeight', { configurable: true, value: 600 })
    Object.defineProperty(thumb, 'offsetHeight', { configurable: true, value: 120 })
    rail.getBoundingClientRect = () => ({ top: 100, bottom: 700, height: 600, left: 0, right: 14, width: 14 })
    thumb.getBoundingClientRect = () => ({ top: 100, bottom: 220, height: 120, left: 0, right: 14, width: 14 })
    rail.setPointerCapture = vi.fn()
    rail.releasePointerCapture = vi.fn()
    flushFrames()

    window.scrollY = 400
    fireEvent.keyDown(rail, { key: 'ArrowDown' })
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 520, left: 0, behavior: 'smooth' })
    fireEvent.keyDown(rail, { key: 'PageUp' })
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'smooth' })
    fireEvent.keyDown(rail, { key: 'End' })
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 1000, left: 0, behavior: 'smooth' })

    fireEvent.pointerDown(rail, { button: 0, clientY: 400, pointerId: 7 })
    expect(rail).toHaveClass('is-dragging')
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 500, left: 0, behavior: 'instant' })

    fireEvent.pointerDown(thumb, { button: 0, clientY: 120, pointerId: 8 })
    fireEvent.pointerMove(rail, { clientY: 500, pointerId: 8 })
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 791.6666666666666, left: 0, behavior: 'instant' })
    fireEvent.pointerUp(rail, { pointerId: 8 })
    expect(rail).not.toHaveClass('is-dragging')
  })

  it('hides itself when the document does not scroll and preserves the native fallback', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 1000 })
    renderExperience()
    const rail = screen.getByRole('scrollbar', { name: 'Page scroll position', hidden: true })
    flushFrames()
    expect(rail.hidden).toBe(true)

    document.documentElement.classList.remove('editorial-motion-active', 'editorial-scrollbar-active')
    window.matchMedia = vi.fn(() => ({ matches: true }))
    renderExperience()
    expect(document.documentElement).not.toHaveClass('editorial-scrollbar-active')
  })

  it('does not render the public scrollbar on admin routes', () => {
    renderExperience('/admin')
    expect(screen.queryByRole('scrollbar')).toBeNull()
    expect(document.documentElement).not.toHaveClass('editorial-scrollbar-active')
  })

  it('uses stronger consistent catalog motion on home, search, videos, and stats', () => {
    for (const path of ['/', '/search', '/videos', '/stats']) {
      const view = renderExperience(path)
      flushFrames()
      const card = view.container.querySelector(path === '/stats' ? '.photo-stats-motion-section' : '.album-card')
      expect(card.style.getPropertyValue('--editorial-x')).toBe('0px')
      expect(card.style.getPropertyValue('--editorial-card-rotation')).toBe('0deg')
      if (path === '/stats') {
        expect(card).toHaveClass('editorial-motion-frame')
        expect(card).not.toHaveClass('editorial-motion-media')
        expect(Math.abs(Number.parseFloat(card.style.getPropertyValue('--editorial-y')))).toBeGreaterThan(38)
        expect(view.container.querySelectorAll('.photo-stats-card.editorial-motion-frame')).toHaveLength(0)
      } else {
        expect(Math.abs(Number.parseFloat(card.style.getPropertyValue('--editorial-card-y')))).toBeGreaterThan(28)
        expect(Number.parseFloat(card.style.getPropertyValue('--editorial-card-scale'))).toBeLessThan(0.98)
      }
      view.unmount()
    }
  })

  it('preserves the expressive card motion inside album routes', () => {
    const view = renderExperience('/album/example')
    flushFrames()
    const card = view.container.querySelector('.album-card')
    expect(card.style.getPropertyValue('--editorial-x')).not.toBe('0px')
    expect(card.style.getPropertyValue('--editorial-card-rotation')).not.toBe('0deg')
  })

  it('ignores preview image/video swaps but discovers and removes real motion targets', () => {
    let notify
    vi.stubGlobal('MutationObserver', class {
      constructor(callback) { notify = callback }
      observe() {}
      disconnect() {}
    })
    const view = renderExperience()
    flushFrames()
    const main = view.container.querySelector('main')
    const collect = vi.spyOn(main, 'querySelectorAll')
    const card = main.querySelector('.album-card')
    const preview = document.createElement('img')
    card.append(preview)
    notify([{ addedNodes: [preview], removedNodes: [] }])
    preview.remove()
    const video = document.createElement('video')
    card.append(video)
    notify([{ addedNodes: [video], removedNodes: [preview] }])
    expect(frames).toHaveLength(0)
    expect(collect).not.toHaveBeenCalled()

    const wrapper = document.createElement('div')
    const newCard = document.createElement('a')
    newCard.className = 'album-card'
    wrapper.append(newCard)
    main.prepend(wrapper)
    notify([{ addedNodes: [wrapper], removedNodes: [] }])
    flushFrames()
    expect(collect).toHaveBeenCalledOnce()
    expect(newCard).toHaveClass('editorial-motion-frame', 'editorial-index-0')
    expect(card).toHaveClass('editorial-index-1')
    expect(card).not.toHaveClass('editorial-index-0')

    wrapper.remove()
    notify([{ addedNodes: [], removedNodes: [wrapper] }])
    flushFrames()
    expect(newCard).not.toHaveClass('editorial-motion-frame')
    expect(card).toHaveClass('editorial-index-0')
    expect(card).not.toHaveClass('editorial-index-1')
  })

  it('does not rewrite unchanged animation values when the viewport is refreshed', () => {
    const view = renderExperience()
    flushFrames()
    const card = view.container.querySelector('.album-card')
    const write = vi.spyOn(card.style, 'setProperty')
    fireEvent.resize(window)
    flushFrames()
    expect(write).not.toHaveBeenCalled()
  })

  it('animates only nearby cards and leaves their catalog sections stable', () => {
    let notify
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { notify = callback }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    const view = render(<MemoryRouter><main><section className="catalog-section">
      {Array.from({ length: 100 }, (_, index) => <a key={index} className="album-card" />)}
    </section></main><MotionExperience /></MemoryRouter>)
    flushFrames()
    const cards = view.container.querySelectorAll('.album-card')
    expect(view.container.querySelector('.catalog-section')).not.toHaveClass('editorial-motion-frame')
    expect(view.container.querySelectorAll('.is-motion-visible')).toHaveLength(0)
    act(() => notify([{ target: cards[0], isIntersecting: true }]))
    flushFrames()
    expect(view.container.querySelectorAll('.is-motion-visible')).toHaveLength(1)
    const farWrite = vi.spyOn(cards[99].style, 'setProperty')
    window.scrollY = 500
    fireEvent.scroll(window)
    flushFrames()
    expect(farWrite).not.toHaveBeenCalled()
    act(() => notify([{ target: cards[0], isIntersecting: false }, { target: cards[1], isIntersecting: true }]))
    flushFrames()
    expect(cards[0]).not.toHaveClass('is-motion-visible')
    expect(cards[1]).toHaveClass('is-motion-visible')
    view.unmount()
    expect(cards[1]).not.toHaveClass('is-motion-visible')
  })

  it('does not measure transformed card geometry or invalidate root styles during scrolling', () => {
    const view = renderExperience()
    const card = view.container.querySelector('.album-card')
    const readTop = vi.fn(() => 600)
    Object.defineProperty(card, 'offsetTop', { configurable: true, get: readTop })
    Object.defineProperty(card, 'offsetHeight', { configurable: true, value: 300 })
    const bounds = vi.spyOn(card, 'getBoundingClientRect')
    const rootWrite = vi.spyOn(document.documentElement.style, 'setProperty')
    flushFrames()
    readTop.mockClear()
    window.scrollY = 300
    fireEvent.scroll(window)
    flushFrames()
    const transform = card.style.cssText
    window.scrollY = 700
    fireEvent.scroll(window)
    flushFrames()
    window.scrollY = 300
    fireEvent.scroll(window)
    flushFrames()
    expect(card.style.cssText).toBe(transform)
    expect(readTop).not.toHaveBeenCalled()
    expect(bounds).not.toHaveBeenCalled()
    expect(rootWrite).not.toHaveBeenCalled()
    fireEvent.resize(window)
    flushFrames()
    expect(readTop).toHaveBeenCalledOnce()
  })

  it('responds to mobile and reduced-motion changes without leaving stale layers', () => {
    const queries = new Map()
    window.matchMedia = vi.fn(query => {
      if (!queries.has(query)) queries.set(query, {
        matches: false,
        addEventListener: (_event, notify) => { queries.get(query).notify = notify },
        removeEventListener: vi.fn(),
      })
      return queries.get(query)
    })
    const view = renderExperience()
    flushFrames()
    expect(view.container.querySelectorAll('.is-motion-visible').length).toBeGreaterThan(0)
    const compact = queries.get('(pointer: coarse), (max-width: 720px)')
    act(() => { compact.matches = true; compact.notify() })
    flushFrames()
    expect(view.container.querySelectorAll('.editorial-motion-frame')).toHaveLength(0)
    expect(screen.getByRole('scrollbar')).toBeInTheDocument()
    const reduced = queries.get('(prefers-reduced-motion: reduce)')
    act(() => { reduced.matches = true; reduced.notify() })
    expect(document.documentElement).not.toHaveClass('editorial-scrollbar-active')
  })
})
