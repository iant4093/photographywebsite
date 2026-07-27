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
})
