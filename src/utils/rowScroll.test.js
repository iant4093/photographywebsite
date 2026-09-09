import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRowScrollController, rowScrollTarget, ROW_SCROLL_DURATION_MS } from './rowScroll'

describe('gallery arrow scrolling', () => {
    let element, controller, frames, clock, media, nextFrame
    const step = ms => {
        clock += ms
        const pending = [...frames.values()]
        frames.clear()
        pending.forEach(callback => callback(clock))
        return element.scrollLeft
    }
    const finish = () => { step(0); step(ROW_SCROLL_DURATION_MS) }
    beforeEach(() => {
        frames = new Map()
        clock = nextFrame = 0
        vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++nextFrame, callback); return nextFrame })
        vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id))
        media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
        vi.stubGlobal('matchMedia', () => media)
        element = document.createElement('div')
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
    afterEach(() => { controller.destroy(); vi.unstubAllGlobals() })

    it('lands on card boundaries with overlap and clamps the final partial page', () => {
        expect(rowScrollTarget(element, 'right')).toBe(768)
        expect(rowScrollTarget(element, 'right', 768)).toBe(1536)
        expect(rowScrollTarget(element, 'right', 1536)).toBe(1832)
        expect(rowScrollTarget(element, 'right', 1832)).toBe(1832)
        expect(rowScrollTarget(element, 'left', 1832)).toBe(1152)
        expect(rowScrollTarget(element, 'left', 768)).toBe(0)
        expect(rowScrollTarget(element, 'left', -20)).toBe(0)
    })

    it('advances at least one card in a narrow row and handles empty/nonoverflowing rows', () => {
        const narrow = { children: element.children, firstElementChild: element.firstElementChild,
            clientWidth: 300, scrollWidth: 3112, scrollLeft: 0 }
        expect(rowScrollTarget(narrow, 'right')).toBe(384)
        expect(rowScrollTarget(narrow, 'left', 384)).toBe(0)
        expect(rowScrollTarget({ children: [], clientWidth: 800, scrollWidth: 200, scrollLeft: 0 }, 'right')).toBe(0)
    })

    it('moves monotonically in both directions with a gentle start and finish', () => {
        for (const direction of ['right', 'left']) {
            controller.scroll(direction)
            const samples = [step(0)]
            for (let i = 0; i < 12; i++) samples.push(step(50))
            const sign = direction === 'right' ? 1 : -1
            const deltas = samples.slice(1).map((value, i) => (value - samples[i]) * sign)
            expect(deltas.every(delta => delta >= 0)).toBe(true)
            expect(deltas[0]).toBeLessThan(deltas[5])
            expect(deltas.at(-1)).toBeLessThan(deltas[5])
            expect(element.scrollLeft).toBe(direction === 'right' ? 768 : 0)
            expect(frames.size).toBe(0)
        }
    })

    it('continues from the current frame on repeated presses without snapping or queuing loops', () => {
        controller.scroll('right')
        step(0); step(200)
        const before = element.scrollLeft
        controller.scroll('right')
        expect(element.scrollLeft).toBe(before)
        expect(frames.size).toBe(1)
        const samples = [step(0)]
        for (let i = 0; i < 6; i++) samples.push(step(100))
        expect(samples.every((value, i) => !i || value >= samples[i - 1])).toBe(true)
        expect(element.scrollLeft).toBe(1536)
        expect(frames.size).toBe(0)
    })

    it('reverses from the actual position instead of the previous destination', () => {
        controller.scroll('right')
        step(0); step(200)
        const before = element.scrollLeft
        controller.scroll('left')
        expect(element.scrollLeft).toBe(before)
        step(0); step(150)
        expect(element.scrollLeft).toBeLessThan(before)
        step(450)
        expect(element.scrollLeft).toBe(0)
    })

    it.each(['wheel', 'pointerdown', 'touchstart'])('yields immediately to %s input', type => {
        controller.scroll('right')
        step(0); step(150)
        element.dispatchEvent(new Event(type))
        const before = element.scrollLeft
        step(1000)
        expect(element.scrollLeft).toBe(before)
        expect(frames.size).toBe(0)
    })

    it('cancels for scroll keys, resize, hidden tabs and preference changes', () => {
        const interrupt = [
            () => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })),
            () => window.dispatchEvent(new Event('resize')),
            () => {
                vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
                document.dispatchEvent(new Event('visibilitychange'))
            },
            () => media.addEventListener.mock.calls[0][1](),
        ]
        for (const action of interrupt) {
            controller.scroll('right')
            step(0); step(100)
            action()
            expect(frames.size).toBe(0)
        }
    })

    it('honors reduced motion and leaves no animation or listeners after unmount', () => {
        media.matches = true
        controller.scroll('right')
        expect(element.scrollLeft).toBe(768)
        expect(frames.size).toBe(0)
        media.matches = false
        controller.scroll('right')
        controller.destroy()
        finish()
        expect(element.scrollLeft).toBe(768)
        expect(frames.size).toBe(0)
        expect(media.removeEventListener).toHaveBeenCalledWith('change', media.addEventListener.mock.calls[0][1])
    })
})
