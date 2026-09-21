import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteScrollPositions, watchScrollPosition } from './routeScroll'

describe('route scroll restoration', () => {
    let maximum, resize, stops
    const start = options => {
        const stop = watchScrollPosition({ route: '/', key: 'home', ...options })
        stops.push(stop)
        return stop
    }
    const scroll = top => { window.scrollY = top; window.dispatchEvent(new Event('scroll')) }
    const frame = () => vi.advanceTimersByTime(20)

    beforeEach(() => {
        vi.useFakeTimers()
        clearRouteScrollPositions()
        stops = []
        maximum = 5000
        document.body.innerHTML = '<main id="main-content"><div></div></main>'
        document.documentElement.removeAttribute('data-lightbox-scroll-lock')
        Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 })
        Object.defineProperty(window, 'scrollX', { configurable: true, writable: true, value: 0 })
        window.scrollTo = vi.fn(({ top }) => { window.scrollY = Math.min(top, maximum) })
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback) { resize = callback }
            observe() {}
            disconnect() {}
        })
    })
    afterEach(() => {
        for (const stop of stops) stop()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('waits for delayed data without replacing the destination with a clamped offset', () => {
        const leave = start({})
        scroll(2600)
        leave()
        maximum = 100
        scroll(0)
        start({ restore: true })
        frame()
        expect(window.scrollY).toBe(100)
        window.dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(2000)
        maximum = 5000
        resize()
        frame()
        expect(window.scrollY).toBe(2600)
    })

    it('does not restore into the lazy-route fallback or lose scroll during DOM removal', () => {
        const leave = start({})
        scroll(1900)
        window.scrollY = 0 // Removing a long page can clamp before cleanup.
        leave()
        document.querySelector('main').innerHTML = '<div data-route-loading></div>'
        start({ restore: true })
        frame()
        expect(window.scrollY).toBe(0)
        document.querySelector('main').innerHTML = '<div>Albums ready</div>'
        resize()
        frame()
        expect(window.scrollY).toBe(1900)
    })

    it('keeps separate visits and queries separate, including saved zero', () => {
        const first = start({ key: 'first', route: '/search?q=birds' })
        scroll(1200)
        first()
        const second = start({ key: 'second', route: '/search?q=birds' })
        scroll(0)
        second()
        const other = start({ key: 'other', route: '/search?q=mountains' })
        scroll(600)
        other()
        const back = start({ key: 'first', route: '/search?q=birds', restore: true })
        frame()
        expect(window.scrollY).toBe(1200)
        back()
        start({ key: 'second', route: '/search?q=birds', restore: true })
        frame()
        expect(window.scrollY).toBe(0)
    })

    it('ignores fixed-body modal scroll and stops restoring as soon as the user scrolls', () => {
        const leave = start({})
        scroll(800)
        document.documentElement.setAttribute('data-lightbox-scroll-lock', '')
        scroll(0)
        leave()
        document.documentElement.removeAttribute('data-lightbox-scroll-lock')
        maximum = 100
        start({ restore: true })
        frame()
        window.dispatchEvent(new Event('wheel'))
        scroll(60)
        maximum = 5000
        resize()
        frame()
        expect(window.scrollY).toBe(60)
    })

    it('restores explicit hub returns and nested scroll containers', () => {
        const pane = document.querySelector('main > div')
        const leave = start({ route: '/admin', key: 'admin' })
        scroll(900)
        pane.scrollTop = 420
        pane.scrollLeft = 180
        pane.dispatchEvent(new Event('scroll'))
        leave()
        pane.scrollTop = 0
        pane.scrollLeft = 0
        scroll(0)
        start({ route: '/admin', key: 'return', restore: true, restoreRoute: true })
        frame()
        expect(window.scrollY).toBe(900)
        expect(pane.scrollTop).toBe(420)
        expect(pane.scrollLeft).toBe(180)
    })

    it('keeps filter updates in place and persists positions for reload', async () => {
        scroll(710)
        const leave = start({ preserve: true })
        expect(window.scrollY).toBe(710)
        leave()
        vi.resetModules()
        const fresh = await import('./routeScroll')
        scroll(0)
        stops.push(fresh.watchScrollPosition({ key: 'home', route: '/', restore: true }))
        frame()
        expect(window.scrollY).toBe(710)
    })

    it('waits for hash targets added after the lazy route loads', () => {
        start({ hash: '#photo-albums' })
        frame()
        const anchor = document.createElement('section')
        anchor.id = 'photo-albums'
        anchor.scrollIntoView = vi.fn()
        document.querySelector('main').append(anchor)
        resize()
        frame()
        expect(anchor.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    })

    it('cancels queued retries when another navigation occurs', () => {
        const leave = start({})
        scroll(2200)
        leave()
        const restore = start({ restore: true })
        restore()
        start({ key: 'new', route: '/videos' })
        frame()
        expect(window.scrollY).toBe(0)
    })
})
