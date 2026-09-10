import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRowScrollController, rowScrollTarget } from './rowScroll'

describe('native gallery arrow scrolling', () => {
    let element, controller, media, frame
    beforeEach(() => {
        vi.useFakeTimers()
        frame = vi.fn()
        vi.stubGlobal('requestAnimationFrame', frame)
        media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
        vi.stubGlobal('matchMedia', () => media)
        element = document.createElement('div')
        element.scrollTo = vi.fn()
        Object.defineProperties(element, {
            clientWidth: { value: 1280 }, scrollWidth: { value: 3112 },
        })
        for (let i = 0; i < 8; i++) {
            const card = document.createElement('div')
            Object.defineProperty(card, 'offsetLeft', { value: 32 + i * 384 })
            element.append(card)
        }
        controller = createRowScrollController(element)
    })
    afterEach(() => { controller.destroy(); vi.useRealTimers(); vi.unstubAllGlobals() })

    it('lands on card boundaries with overlap and clamps the final partial page', () => {
        expect(rowScrollTarget(element, 'right')).toBe(768)
        expect(rowScrollTarget(element, 'right', 768)).toBe(1536)
        expect(rowScrollTarget(element, 'right', 1536)).toBe(1832)
        expect(rowScrollTarget(element, 'right', 1832)).toBe(1832)
        expect(rowScrollTarget(element, 'left', 1832)).toBe(1152)
        expect(rowScrollTarget(element, 'left', 768)).toBe(0)
        expect(rowScrollTarget(element, 'left', -20)).toBe(0)
    })

    it('advances one card in narrow rows and handles nonoverflowing rows', () => {
        const narrow = { children: element.children, firstElementChild: element.firstElementChild,
            clientWidth: 300, scrollWidth: 3112, scrollLeft: 0 }
        expect(rowScrollTarget(narrow, 'right')).toBe(384)
        expect(rowScrollTarget(narrow, 'left', 384)).toBe(0)
        expect(rowScrollTarget({ children: [], clientWidth: 800, scrollWidth: 200, scrollLeft: 0 }, 'right')).toBe(0)
    })

    it('delegates an entire glide to the browser without scheduling animation frames', () => {
        controller.scroll('right')
        expect(element.scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 768, behavior: 'smooth' })
        vi.advanceTimersByTime(2000)
        expect(element.scrollTo).toHaveBeenCalledOnce()
        expect(element.scrollLeft).toBe(0)
        expect(frame).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('extends rapid presses and reverses from the current position', () => {
        controller.scroll('right')
        element.scrollLeft = 200
        controller.scroll('right')
        expect(element.scrollTo).toHaveBeenLastCalledWith({ left: 1536, behavior: 'smooth' })
        controller.scroll('left')
        expect(element.scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'smooth' })
        expect(element.scrollLeft).toBe(200)
        expect(vi.getTimerCount()).toBe(1)
    })

    it('does not restart the same endpoint while the final glide is in flight', () => {
        controller.scroll('right'); controller.scroll('right'); controller.scroll('right')
        const calls = element.scrollTo.mock.calls.length
        controller.scroll('right')
        expect(element.scrollTo).toHaveBeenCalledTimes(calls)
        expect(element.scrollTo).toHaveBeenLastCalledWith({ left: 1832, behavior: 'smooth' })
    })

    it.each(['wheel', 'pointerdown', 'touchstart'])('yields to %s at the current position without continuing writes', type => {
        controller.scroll('right')
        element.scrollLeft = 200
        element.dispatchEvent(new Event(type))
        expect(element.scrollTo).toHaveBeenLastCalledWith({ left: 200, behavior: 'instant' })
        const calls = element.scrollTo.mock.calls.length
        element.dispatchEvent(new Event(type))
        vi.advanceTimersByTime(2000)
        expect(element.scrollTo).toHaveBeenCalledTimes(calls)
        expect(frame).not.toHaveBeenCalled()
    })

    it('forgets completed and interrupted native glides, including without scrollend support', () => {
        controller.scroll('right')
        element.scrollLeft = 768
        element.dispatchEvent(new Event('scrollend'))
        expect(vi.getTimerCount()).toBe(0)
        controller.scroll('right')
        element.scrollLeft = 1000
        element.dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(200)
        expect(vi.getTimerCount()).toBe(0)
        controller.scroll('right')
        expect(element.scrollTo).toHaveBeenLastCalledWith({ left: 1832, behavior: 'smooth' })
        element.scrollLeft = 1832
        element.dispatchEvent(new Event('scroll'))
        expect(vi.getTimerCount()).toBe(0)
    })

    it('honors reduced motion and removes active work on resize, hide, keys and unmount', () => {
        media.matches = true
        controller.scroll('right')
        expect(element.scrollTo).toHaveBeenLastCalledWith({ left: 768, behavior: 'instant' })
        expect(vi.getTimerCount()).toBe(0)
        media.matches = false
        for (const interrupt of [
            () => window.dispatchEvent(new Event('resize')),
            () => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })),
            () => {
                vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
                document.dispatchEvent(new Event('visibilitychange'))
            },
            () => media.addEventListener.mock.calls[0][1](),
            () => controller.destroy(),
        ]) {
            controller.scroll('right')
            interrupt()
            expect(vi.getTimerCount()).toBe(0)
        }
        expect(media.removeEventListener).toHaveBeenCalledWith('change', media.addEventListener.mock.calls[0][1])
    })
})
