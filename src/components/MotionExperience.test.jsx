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
        <div className="linen-section-heading" />
        <section className="linen-gallery-page">
          <div className="linen-media-frame" data-page-scroll-media />
          <div role="dialog"><div data-page-scroll-media /></div>
        </section>
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
      while (frames.length) frames.shift().callback()
    })
  }

  beforeEach(() => {
    frames = []
    frameId = 0
    window.matchMedia = vi.fn(() => ({ matches: false }))
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      frameId += 1
      frames.push({ id: frameId, callback })
      return frameId
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn(id => {
      frames = frames.filter(frame => frame.id !== id)
    }))
    vi.stubGlobal('IntersectionObserver', undefined)
    vi.stubGlobal('MutationObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      constructor(type, options) {
        super(type, options)
        this.pointerId = options.pointerId
      }
    })
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
    fireEvent.pointerUp(rail, { pointerId: 7 })

    fireEvent.pointerDown(thumb, { button: 0, clientY: 120, pointerId: 8 })
    fireEvent.pointerMove(rail, { clientY: 500, pointerId: 8 })
    flushFrames()
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 791.6666666666666, left: 0, behavior: 'instant' })
    fireEvent.pointerUp(rail, { pointerId: 8 })
    expect(rail).not.toHaveClass('is-dragging')
  })

  function prepareRail() {
    const view = renderExperience()
    const rail = screen.getByRole('scrollbar')
    const thumb = rail.firstElementChild
    Object.defineProperty(rail, 'clientHeight', { configurable: true, value: 600 })
    Object.defineProperty(thumb, 'offsetHeight', { configurable: true, value: 120 })
    vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 600 })
    vi.spyOn(thumb, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 220, height: 120 })
    rail.setPointerCapture = vi.fn()
    rail.releasePointerCapture = vi.fn()
    flushFrames()
    return { view, rail, thumb }
  }

  it('coalesces fast pointer input and moves the thumb with the page without remeasuring layout', () => {
    const { rail, thumb } = prepareRail()
    fireEvent.pointerDown(thumb, { button: 0, clientY: 120, pointerId: 7 })
    rail.getBoundingClientRect.mockClear()
    thumb.getBoundingClientRect.mockClear()
    const readHeight = vi.fn(() => 9000)
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: readHeight })
    window.scrollTo.mockClear()

    for (const clientY of [180, 250, 330, 400]) {
      fireEvent.pointerMove(rail, { clientY, pointerId: 7 })
    }
    expect(window.scrollTo).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)
    flushFrames()
    expect(window.scrollTo).toHaveBeenCalledOnce()
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 280 / 480 * 1000, left: 0, behavior: 'instant' })
    expect(rail.style.getPropertyValue('--editorial-progress-offset')).toBe('280.00px')
    expect(rail).toHaveAttribute('aria-valuenow', '58')
    expect(readHeight).not.toHaveBeenCalled()
    expect(rail.getBoundingClientRect).not.toHaveBeenCalled()
    expect(thumb.getBoundingClientRect).not.toHaveBeenCalled()
    // An older scroll event cannot overwrite the current drag position.
    fireEvent.scroll(window)
    flushFrames()
    expect(rail.style.getPropertyValue('--editorial-progress-offset')).toBe('280.00px')
  })

  it('preserves the grab offset across the full rail width and ignores another pointer', () => {
    const { rail } = prepareRail()
    fireEvent.pointerDown(rail, { button: 0, clientY: 200, pointerId: 7 })
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'instant' })
    fireEvent.pointerDown(rail, { button: 0, clientY: 400, pointerId: 8 })
    fireEvent.pointerMove(rail, { clientY: 600, pointerId: 8 })
    fireEvent.pointerUp(rail, { pointerId: 8 })
    expect(rail).toHaveClass('is-dragging')
    fireEvent.pointerMove(rail, { clientY: 248, pointerId: 7 })
    flushFrames()
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 100, left: 0, behavior: 'instant' })
  })

  it('flushes the final pointer position on release and clamps both ends', () => {
    const { rail, thumb } = prepareRail()
    fireEvent.pointerDown(thumb, { button: 0, clientY: 120, pointerId: 7 })
    fireEvent.pointerMove(rail, { clientY: -100, pointerId: 7 })
    flushFrames()
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'instant' })
    fireEvent.pointerMove(rail, { clientY: 1000, pointerId: 7 })
    fireEvent.pointerUp(rail, { pointerId: 7 })
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 1000, left: 0, behavior: 'instant' })
    expect(rail.style.getPropertyValue('--editorial-progress-offset')).toBe('480.00px')
    expect(rail).not.toHaveClass('is-dragging')
    expect(frames).toHaveLength(0)
  })

  it.each(['pointercancel', 'lostpointercapture', 'blur', 'resize', 'unmount'])('cancels queued dragging on %s', (type) => {
    const { view, rail, thumb } = prepareRail()
    fireEvent.pointerDown(thumb, { button: 0, clientY: 120, pointerId: 7 })
    fireEvent.pointerMove(rail, { clientY: 500, pointerId: 7 })
    window.scrollTo.mockClear()
    if (type === 'unmount') view.unmount()
    else if (type === 'blur' || type === 'resize') fireEvent(window, new Event(type))
    else fireEvent(rail, new PointerEvent(type, { bubbles: true, pointerId: 7 }))
    flushFrames()
    expect(window.scrollTo).not.toHaveBeenCalled()
    expect(rail).not.toHaveClass('is-dragging')
  })

  it('caches rail geometry during ordinary scroll and refreshes it on resize', () => {
    const { rail, thumb } = prepareRail()
    const readPage = vi.fn(() => 3000)
    const readRail = vi.fn(() => 800)
    const readThumb = vi.fn(() => 120)
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: readPage })
    Object.defineProperty(rail, 'clientHeight', { configurable: true, get: readRail })
    Object.defineProperty(thumb, 'offsetHeight', { configurable: true, get: readThumb })
    window.scrollY = 500
    fireEvent.scroll(window)
    flushFrames()
    expect(rail.style.getPropertyValue('--editorial-progress-offset')).toBe('240.00px')
    for (const read of [readPage, readRail, readThumb]) expect(read).not.toHaveBeenCalled()
    fireEvent.resize(window)
    flushFrames()
    expect(rail.style.getPropertyValue('--editorial-progress-offset')).toBe('170.00px')
    expect(rail.style.getPropertyValue('--editorial-progress-travel')).toBe('680.00px')
    for (const read of [readPage, readRail, readThumb]) expect(read).toHaveBeenCalledOnce()
  })

  it('lets the browser animate scroll progress while still updating accessible position', () => {
    vi.stubGlobal('CSS', { supports: () => true })
    const { rail } = prepareRail()
    window.scrollY = 500
    fireEvent.scroll(window)
    flushFrames()
    expect(rail).toHaveAttribute('aria-valuenow', '50')
    expect(rail.style.getPropertyValue('--editorial-progress-travel')).toBe('480.00px')
    expect(rail.style.getPropertyValue('--editorial-progress-offset')).toBe('')
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

  it('keeps row cards moving vertically before and after horizontal entry without extra layout reads', () => {
    let notify
    const observe = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { notify = callback }
      observe = observe
      disconnect() {}
    })
    const view = render(<MemoryRouter><main>
      <div data-scroll-row="" data-testid="row">
        <div className="album-card" data-testid="visible-card" />
        <div className="album-card" data-testid="clipped-card" />
      </div>
      <div data-scroll-row=""><div className="album-card" data-testid="distant-card" /></div>
    </main><MotionExperience /></MemoryRouter>)
    const visible = screen.getByTestId('visible-card')
    const clipped = screen.getByTestId('clipped-card')
    const distant = screen.getByTestId('distant-card')
    const readTop = vi.fn(() => 800)
    for (const card of [visible, clipped]) {
      Object.defineProperty(card, 'offsetTop', { configurable: true, get: readTop })
      Object.defineProperty(card, 'offsetHeight', { configurable: true, value: 300 })
    }
    Object.defineProperty(distant, 'offsetTop', { configurable: true, value: 5000 })
    flushFrames()
    expect(observe).toHaveBeenCalledWith(visible)
    expect(observe).toHaveBeenCalledWith(clipped)
    expect(clipped).toHaveClass('editorial-motion-frame', 'editorial-motion-media')
    expect(clipped).not.toHaveClass('is-motion-visible')
    const initialPose = clipped.style.cssText
    expect(initialPose).toBe(visible.style.cssText)
    expect(Number.parseFloat(clipped.style.getPropertyValue('--editorial-card-y'))).toBeGreaterThan(20)
    readTop.mockClear()
    const distantWrite = vi.spyOn(distant.style, 'setProperty')

    act(() => notify([{ target: visible, isIntersecting: true }, { target: clipped, isIntersecting: false }]))
    window.scrollY = 450
    fireEvent.scroll(window)
    flushFrames()
    expect(clipped.style.cssText).not.toBe(initialPose)
    expect(clipped.style.cssText).toBe(visible.style.cssText)
    expect(clipped.style.getPropertyValue('--editorial-card-y')).toBe('0.00px')
    expect(readTop).not.toHaveBeenCalled()
    expect(distantWrite).not.toHaveBeenCalled()

    const write = vi.spyOn(clipped.style, 'setProperty')
    act(() => notify([{ target: visible, isIntersecting: false }, { target: clipped, isIntersecting: true }]))
    fireEvent.scroll(screen.getByTestId('row'))
    flushFrames()
    expect(clipped).toHaveClass('is-motion-visible')
    expect(visible).not.toHaveClass('is-motion-visible')
    expect(write).not.toHaveBeenCalled()
    expect(clipped.style.cssText).toBe(visible.style.cssText)

    window.scrollY = 0
    fireEvent.scroll(window)
    flushFrames()
    expect(clipped.style.cssText).toBe(initialPose)
    expect(visible.style.cssText).toBe(initialPose)
    expect(readTop).not.toHaveBeenCalled()
    view.unmount()
    expect(clipped).not.toHaveClass('editorial-motion-frame', 'editorial-motion-media', 'is-motion-visible')
    expect(clipped.style.getPropertyValue('--editorial-card-y')).toBe('')
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

  it.each(['(max-width: 720px)', '(pointer: coarse)'])('keeps scroll animations on every gallery route with %s', (deviceQuery) => {
    window.matchMedia = vi.fn(query => ({ matches: query.includes(deviceQuery) }))
    for (const path of ['/', '/videos', '/search', '/stats', '/explore', '/album/example', '/video/example', '/sharedalbum/example', '/dashboard']) {
      const view = renderExperience(path)
      const targets = [...view.container.querySelectorAll('.editorial-motion-frame')]
      expect(targets.length).toBeGreaterThan(0)
      expect(view.container.querySelector('.linen-media-frame')).toHaveClass('editorial-motion-frame')
      expect(view.container.querySelector('[role="dialog"] [data-page-scroll-media]')).not.toHaveClass('editorial-motion-frame')
      targets.forEach(target => {
        Object.defineProperty(target, 'offsetTop', { configurable: true, value: 600 })
        Object.defineProperty(target, 'offsetHeight', { configurable: true, value: 300 })
      })
      window.scrollY = 0
      flushFrames()
      const before = targets.map(target => target.style.cssText)
      window.scrollY = 300
      fireEvent.scroll(window)
      flushFrames()
      targets.forEach((target, index) => expect(target.style.cssText).not.toBe(before[index]))
      window.scrollY = 0
      fireEvent.scroll(window)
      flushFrames()
      targets.forEach((target, index) => expect(target.style.cssText).toBe(before[index]))
      view.unmount()
      targets.forEach(target => expect(target).not.toHaveClass('editorial-motion-frame'))
    }
  })

  it('keeps motion after a mobile resize and responds to reduced-motion changes without stale layers', () => {
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
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    fireEvent.resize(window)
    flushFrames()
    expect(view.container.querySelectorAll('.is-motion-visible').length).toBeGreaterThan(0)
    expect(screen.getByRole('scrollbar')).toBeInTheDocument()
    const reduced = queries.get('(prefers-reduced-motion: reduce)')
    act(() => { reduced.matches = true; reduced.notify() })
    expect(document.documentElement).not.toHaveClass('editorial-scrollbar-active')
    expect(view.container.querySelectorAll('.editorial-motion-frame')).toHaveLength(0)
    act(() => { reduced.matches = false; reduced.notify() })
    flushFrames()
    expect(view.container.querySelectorAll('.is-motion-visible').length).toBeGreaterThan(0)
  })
})
