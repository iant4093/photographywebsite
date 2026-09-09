import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerMobileAlbumPreview, MOBILE_PREVIEW_DWELL_MS } from './mobileAlbumPreview'
import { MOBILE_PREVIEW_QUERY, REDUCED_MOTION_QUERY } from './albumPreviewPolicy'

describe('shared mobile album preview focus', () => {
    let queries, observers, releases, cards, connection, covered
    const settle = () => vi.advanceTimersByTimeAsync(MOBILE_PREVIEW_DWELL_MS)
    const intersect = (entries) => observers.at(-1).callback(entries.map(([target, ratio = 1]) => ({
        target, isIntersecting: ratio > 0, intersectionRatio: ratio,
    })))
    function card(x = 195, y = 422) {
        const element = document.createElement('div')
        document.body.append(element)
        element.getBoundingClientRect = vi.fn(() => ({ left: x - 130, top: y - 98, width: 260, height: 196 }))
        const callbacks = { start: vi.fn(), stop: vi.fn() }
        cards.push(element)
        releases.push(registerMobileAlbumPreview(element, callbacks))
        return { element, ...callbacks }
    }
    function pointer(type, pointerId = 1) {
        const event = new Event(type, { bubbles: true })
        Object.assign(event, { pointerId, pointerType: 'touch' })
        document.dispatchEvent(event)
    }
    beforeEach(() => {
        vi.useFakeTimers()
        queries = new Map()
        observers = []; releases = []; cards = []; covered = false
        vi.stubGlobal('innerWidth', 390)
        vi.stubGlobal('innerHeight', 844)
        vi.spyOn(window, 'matchMedia').mockImplementation(query => {
            if (!queries.has(query)) {
                const result = new EventTarget()
                result.matches = query === MOBILE_PREVIEW_QUERY
                queries.set(query, result)
            }
            return queries.get(query)
        })
        connection = new EventTarget()
        connection.saveData = false
        Object.defineProperty(navigator, 'connection', { configurable: true, value: connection })
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback) { this.callback = callback; observers.push(this) }
            observe = vi.fn()
            unobserve = vi.fn()
            disconnect = vi.fn()
        })
        Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn((x, y) => {
            if (covered) return document.body
            return cards.find(element => {
                const rect = element.getBoundingClientRect()
                return rect.left <= x && x < rect.left + rect.width && rect.top <= y && y < rect.top + rect.height
            })
        }) })
    })
    afterEach(() => {
        releases.forEach(release => release())
        cards.forEach(element => element.remove())
        document.documentElement.removeAttribute('data-menu-scroll-lock')
        document.documentElement.removeAttribute('data-lightbox-scroll-lock')
        delete navigator.connection
        delete document.elementFromPoint
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('uses one observer and starts only the closest centered card after a full dwell', async () => {
        const side = card(50, 422)
        const center = card()
        intersect([[side.element], [center.element]])
        await vi.advanceTimersByTimeAsync(MOBILE_PREVIEW_DWELL_MS - 1)
        expect(center.start).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(center.start).toHaveBeenCalledOnce()
        expect(side.start).not.toHaveBeenCalled()
        expect(observers).toHaveLength(1)
        intersect([[center.element]])
        await settle()
        expect(center.start).toHaveBeenCalledOnce()
    })

    it('does no geometry work during a slow reverse scroll, stops immediately, then waits again', async () => {
        const target = card()
        intersect([[target.element]])
        await settle()
        target.element.getBoundingClientRect.mockClear()
        for (let step = 0; step < 12; step++) {
            target.element.dispatchEvent(new Event('scroll'))
            await vi.advanceTimersByTimeAsync(100)
        }
        expect(target.stop).toHaveBeenCalledOnce()
        expect(target.start).toHaveBeenCalledOnce()
        expect(target.element.getBoundingClientRect).not.toHaveBeenCalled()
        await settle()
        expect(target.start).toHaveBeenCalledTimes(2)
    })

    it('never overlaps previews when horizontal scrolling moves focus to another card', async () => {
        const first = card()
        const second = card(700)
        intersect([[first.element]])
        await settle()
        document.dispatchEvent(new Event('scroll'))
        first.element.getBoundingClientRect.mockReturnValue({ left: -700, top: 324, width: 260, height: 196 })
        second.element.getBoundingClientRect.mockReturnValue({ left: 65, top: 324, width: 260, height: 196 })
        intersect([[first.element, 0], [second.element]])
        expect(first.stop).toHaveBeenCalledOnce()
        expect(second.start).not.toHaveBeenCalled()
        await settle()
        expect(second.start).toHaveBeenCalledOnce()
        expect(first.stop.mock.invocationCallOrder[0]).toBeLessThan(second.start.mock.invocationCallOrder[0])
    })

    it('waits until every finger is released and cancels before navigation on a tap', async () => {
        const target = card()
        intersect([[target.element]])
        pointer('pointerdown', 1)
        pointer('pointerdown', 2)
        pointer('pointerup', 1)
        await settle()
        expect(target.start).not.toHaveBeenCalled()
        pointer('pointercancel', 2)
        await settle()
        expect(target.start).toHaveBeenCalledOnce()
        pointer('pointerdown')
        expect(target.stop).toHaveBeenCalledOnce()
    })

    it.each([0, 0.59])('does not preview a horizontally clipped card with visibility %s', async ratio => {
        const target = card()
        intersect([[target.element, ratio]])
        await settle()
        expect(target.start).not.toHaveBeenCalled()
    })

    it('ignores peripheral, covered, and disconnected cards', async () => {
        const edge = card(195, 760)
        intersect([[edge.element]])
        await settle()
        expect(edge.start).not.toHaveBeenCalled()
        const center = card()
        covered = true
        intersect([[center.element]])
        await settle()
        expect(center.start).not.toHaveBeenCalled()
        covered = false
        center.element.remove()
        intersect([[center.element]])
        await settle()
        expect(center.start).not.toHaveBeenCalled()
    })

    it.each(['data-menu-scroll-lock', 'data-lightbox-scroll-lock'])('suspends under %s and resumes only after another dwell', async attribute => {
        const target = card()
        intersect([[target.element]])
        await settle()
        document.documentElement.setAttribute(attribute, '')
        await Promise.resolve()
        expect(target.stop).toHaveBeenCalledOnce()
        await settle()
        expect(target.start).toHaveBeenCalledOnce()
        document.documentElement.removeAttribute(attribute)
        await Promise.resolve()
        await settle()
        expect(target.start).toHaveBeenCalledTimes(2)
    })

    it.each(['motion', 'data', 'desktop', 'hidden'])('cancels on a live %s preference/visibility change', async reason => {
        const target = card()
        intersect([[target.element]])
        await settle()
        if (reason === 'motion' || reason === 'desktop') {
            const query = queries.get(reason === 'motion' ? REDUCED_MOTION_QUERY : MOBILE_PREVIEW_QUERY)
            query.matches = reason === 'motion'
            query.dispatchEvent(new Event('change'))
        } else if (reason === 'data') {
            connection.saveData = true
            connection.dispatchEvent(new Event('change'))
        } else {
            vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
            document.dispatchEvent(new Event('visibilitychange'))
        }
        await settle()
        expect(target.stop).toHaveBeenCalledOnce()
        expect(target.start).toHaveBeenCalledOnce()
    })

    it('releases observers, listeners, active previews and pending timers when the last card unmounts', async () => {
        const target = card()
        intersect([[target.element]])
        await settle()
        releases.splice(0).forEach(release => release())
        expect(target.stop).toHaveBeenCalledOnce()
        expect(observers[0].disconnect).toHaveBeenCalledOnce()
        document.dispatchEvent(new Event('scroll'))
        await settle()
        expect(target.start).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('cancels a desktop hover before enabling focus previews after a breakpoint change', async () => {
        const query = window.matchMedia(MOBILE_PREVIEW_QUERY)
        query.matches = false
        const target = card()
        expect(observers).toHaveLength(0)
        query.matches = true
        query.dispatchEvent(new Event('change'))
        expect(target.stop).toHaveBeenCalledOnce()
        intersect([[target.element]])
        await settle()
        expect(target.start).toHaveBeenCalledOnce()
    })
})
