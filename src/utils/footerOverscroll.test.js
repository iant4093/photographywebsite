import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { installFooterOverscroll } from './footerOverscroll'

describe('continuous pulling past the footer', () => {
    let dispose, onAttempt, onTrigger, onProgress, footer
    const advance = (ms = 50) => vi.advanceTimersByTime(ms)
    const wheel = (props = {}, target = document.body) => fireEvent.wheel(target, { deltaY: 120, ...props })
    const pullWheel = (count = 24, props = {}, target = document.body) => {
        for (let i = 0; i < count; i++) { wheel(props, target); advance() }
    }
    const point = (y, x = 150) => ({ identifier: 1, clientX: x, clientY: y })
    const startTouch = (y = 650, target = document.body) => fireEvent.touchStart(target, { touches: [point(y)] })
    const moveTouch = (y, target = document.body) => fireEvent.touchMove(target, { touches: [point(y)] })
    const endTouch = () => fireEvent.touchEnd(document.body, { touches: [], changedTouches: [point(400)] })
    const pullTouch = (start = 650, target = document.body) => {
        startTouch(start, target)
        for (let y = start - 20; y >= start - 240; y -= 20) { advance(); moveTouch(y, target) }
    }

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1200 })
        Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2000 })
        footer = document.createElement('footer')
        footer.className = 'linen-footer'
        footer.getBoundingClientRect = () => ({ top: 650, bottom: 800, height: 150 })
        document.body.append(footer)
        onAttempt = vi.fn(); onTrigger = vi.fn(); onProgress = vi.fn()
        dispose = installFooterOverscroll({ onAttempt, onTrigger, onProgress })
        advance(300)
    })
    afterEach(() => {
        dispose()
        document.body.replaceChildren()
        document.body.style.overflow = ''
        vi.useRealTimers()
    })

    it('triggers from one sustained wheel pull, with buildup before the animation', () => {
        pullWheel(2, { deltaY: 60 })
        expect(onProgress).toHaveBeenLastCalledWith(expect.any(Number))
        expect(onProgress.mock.calls.at(-1)[0]).toBeGreaterThan(0.2)
        expect(onTrigger).not.toHaveBeenCalled()
        pullWheel(2, { deltaY: 60 })
        expect(onAttempt).toHaveBeenCalledTimes(1)
        expect(onTrigger).toHaveBeenCalledTimes(1)
        pullWheel(40)
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('lets sustained active scrolling continue after reaching the bottom, without a pause', () => {
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1000 })
        pullWheel(10)
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1200 })
        fireEvent.scroll(window)
        pullWheel(30)
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('rejects a decaying fling arriving at the footer, including its long tail', () => {
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1000 })
        wheel({ deltaY: 500 }); advance()
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1200 })
        fireEvent.scroll(window)
        for (let i = 0; i < 80; i++) { wheel({ deltaY: Math.max(18, 450 * 0.9 ** i) }); advance(20) }
        expect(onTrigger).not.toHaveBeenCalled()
        expect(onAttempt).not.toHaveBeenCalled()
        pullWheel(24)
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('accepts the natural rise and taper of one modest trackpad pull', () => {
        for (const deltaY of [5, 10, 18, 27, 35, 32, 28, 24, 18, 12, 8, 4]) {
            wheel({ deltaY }); advance(16)
        }
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('does not activate from one oversized wheel event', () => {
        wheel({ deltaY: 100000 }); advance(1100)
        expect(onTrigger).not.toHaveBeenCalled()
        expect(onProgress).toHaveBeenLastCalledWith(0)
    })
    it('preserves partial progress across a brief pause and tiny reverse jitter', () => {
        for (const deltaY of [10, 20, 30, 35]) { wheel({ deltaY }); advance(16) }
        wheel({ deltaY: -1 }); advance(600)
        for (const deltaY of [8, 16, 25, 30, 32]) { wheel({ deltaY }); advance(16) }
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('releases pressure after a real pause or reversing direction', () => {
        pullWheel(2, { deltaY: 50 })
        advance(1100)
        expect(onProgress).toHaveBeenLastCalledWith(0)
        pullWheel(2, { deltaY: 50 })
        expect(onTrigger).not.toHaveBeenCalled()
        wheel({ deltaY: -30 }); advance()
        expect(onProgress).toHaveBeenLastCalledWith(0)
        pullWheel(2, { deltaY: 50 })
        expect(onTrigger).not.toHaveBeenCalled()
    })
    it('accepts slower continuous trackpad input as the resistance builds', () => {
        pullWheel(110, { deltaY: 12 })
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it.each([{ deltaY: 0.2 }, { deltaX: 200 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }])('ignores accidental or modified scrolling: %j', props => {
        pullWheel(40, props)
        expect(onAttempt).not.toHaveBeenCalled()
        expect(onTrigger).not.toHaveBeenCalled()
    })
    it.each([{ deltaY: 5, deltaMode: 1 }, { deltaY: 1, deltaMode: 2 }])('supports wheel units: %j', props => {
        pullWheel(24, props)
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('requires the actual page bottom and a visible site footer', () => {
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1000 })
        pullWheel()
        footer.remove()
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1200 })
        pullWheel()
        expect(onAttempt).not.toHaveBeenCalled()
    })
    it('ignores nested scrolling, form controls, open dialogs, and scroll locks', () => {
        const panel = document.createElement('div')
        panel.style.overflowY = 'auto'
        Object.defineProperty(panel, 'scrollHeight', { value: 500 })
        Object.defineProperty(panel, 'clientHeight', { value: 100 })
        const input = document.createElement('textarea')
        document.body.append(panel, input)
        pullWheel(24, {}, panel); pullWheel(24, {}, input)
        const dialog = document.createElement('div')
        dialog.setAttribute('aria-modal', 'true'); document.body.append(dialog)
        pullWheel(); dialog.remove()
        document.body.style.overflow = 'hidden'
        pullWheel()
        expect(onAttempt).not.toHaveBeenCalled()
    })
    it('allows a real scroll pull over footer links without activating the link', () => {
        const link = document.createElement('a')
        link.href = '/terms'; footer.append(link)
        const click = vi.fn(); link.addEventListener('click', click)
        pullWheel(24, {}, link)
        expect(onTrigger).toHaveBeenCalledTimes(1)
        expect(click).not.toHaveBeenCalled()
    })
    it('activates during a single long touch pull, before lifting the finger', () => {
        pullTouch()
        expect(onTrigger).toHaveBeenCalledTimes(1)
        moveTouch(350)
        expect(onTrigger).toHaveBeenCalledTimes(1)
        endTouch()
        expect(onProgress).toHaveBeenLastCalledWith(0)
    })
    it('accepts a short comfortable finger pull without a long hold', () => {
        startTouch()
        for (const y of [630, 610, 590, 570]) { advance(30); moveTouch(y) }
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('allows a touch drag to reach the footer and keep pulling in the same gesture', () => {
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1000 })
        startTouch(750); advance(); moveTouch(650)
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1200 })
        fireEvent.scroll(window)
        advance(); moveTouch(600)
        for (let y = 580; y >= 360; y -= 20) { advance(); moveTouch(y) }
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('rejects quick touch flicks and releases short pulls immediately', () => {
        startTouch(); advance(50); moveTouch(350); endTouch()
        expect(onTrigger).not.toHaveBeenCalled()
        for (let i = 0; i < 3; i++) {
            startTouch(); advance(500); moveTouch(610); endTouch()
        }
        expect(onTrigger).not.toHaveBeenCalled()
        expect(onProgress).toHaveBeenLastCalledWith(0)
    })
    it('cancels reversing, horizontal, and multi-touch pulls', () => {
        startTouch(); advance(100); moveTouch(600); moveTouch(620)
        expect(onProgress).toHaveBeenLastCalledWith(0)
        fireEvent.touchMove(document.body, { touches: [point(450, 250)] })
        expect(onProgress).toHaveBeenLastCalledWith(0)
        startTouch()
        fireEvent.touchMove(document.body, { touches: [point(450), { ...point(450), identifier: 2 }] })
        expect(onTrigger).not.toHaveBeenCalled()
    })
    it('supports holding a downward key at the footer, with keyup releasing pressure', () => {
        for (let i = 0; i < 3; i++) {
            fireEvent.keyDown(document.body, { key: 'PageDown' }); advance(100)
            fireEvent.keyUp(document.body, { key: 'PageDown' })
        }
        expect(onTrigger).not.toHaveBeenCalled()
        fireEvent.keyDown(document.body, { key: 'PageDown' })
        for (let i = 0; i < 30; i++) { advance(); fireEvent.keyDown(document.body, { key: 'PageDown', repeat: true }) }
        expect(onTrigger).toHaveBeenCalledTimes(1)
        fireEvent.keyUp(document.body, { key: 'PageDown' })
        expect(onProgress).toHaveBeenLastCalledWith(0)
    })
    it('removes listeners and the pending release timer on disposal', () => {
        pullWheel(2, { deltaY: 20 }); dispose()
        onProgress.mockClear()
        advance(1000); pullWheel(); pullTouch()
        expect(onTrigger).not.toHaveBeenCalled()
        expect(onProgress).not.toHaveBeenCalled()
    })
})
