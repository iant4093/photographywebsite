import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { installFooterOverscroll } from './footerOverscroll'

describe('the deliberate footer secret', () => {
    let dispose
    let onAttempt
    let onTrigger
    let now
    let footer
    const advance = (ms = 400) => { now += ms }
    const wheel = (props = {}, target = document.body) => fireEvent.wheel(target, { deltaY: 120, ...props })
    const attempts = () => { for (let i = 0; i < 3; i++) { advance(); wheel() } }
    const swipe = (from = 500, to = 350, target = document.body) => {
        fireEvent.touchStart(target, { touches: [{ identifier: 1, clientX: 150, clientY: from }] })
        fireEvent.touchMove(target, { touches: [{ identifier: 1, clientX: 150, clientY: to }] })
        fireEvent.touchEnd(target, { touches: [], changedTouches: [{ identifier: 1, clientX: 150, clientY: to }] })
    }

    beforeEach(() => {
        now = 0
        vi.spyOn(performance, 'now').mockImplementation(() => now)
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1200 })
        Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2000 })
        footer = document.createElement('footer')
        footer.className = 'linen-footer'
        footer.getBoundingClientRect = () => ({ top: 650, bottom: 800, height: 150 })
        document.body.append(footer)
        onAttempt = vi.fn()
        onTrigger = vi.fn()
        dispose = installFooterOverscroll({ onAttempt, onTrigger })
        advance(800)
    })
    afterEach(() => {
        dispose()
        document.body.replaceChildren()
        document.body.style.overflow = ''
    })

    it('requires three distinct downward gestures after settling at the footer', () => {
        wheel()
        expect(onAttempt).toHaveBeenCalledTimes(1)
        advance(); wheel()
        expect(onTrigger).not.toHaveBeenCalled()
        advance(); wheel()
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('does not count the gesture that lands at the bottom or its momentum', () => {
        now = 100
        for (let i = 0; i < 200; i++) { wheel({ deltaY: 300 - i }); advance(20) }
        expect(onAttempt).not.toHaveBeenCalled()
        expect(onTrigger).not.toHaveBeenCalled()
        attempts()
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('counts a long continuous wheel stream as only one attempt', () => {
        for (let i = 0; i < 200; i++) { wheel(); advance(20) }
        expect(onAttempt).toHaveBeenCalledTimes(1)
        expect(onTrigger).not.toHaveBeenCalled()
    })
    it('ignores tiny nudges, horizontal gestures, and zoom gestures', () => {
        for (const props of [{ deltaY: 10 }, { deltaX: 200 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
            for (let i = 0; i < 3; i++) { advance(); wheel(props) }
        }
        expect(onAttempt).not.toHaveBeenCalled()
    })
    it('handles wheel line units and collects small deltas within a fresh gesture', () => {
        wheel({ deltaY: 7, deltaMode: 1 })
        advance()
        for (let i = 0; i < 10; i++) { wheel({ deltaY: 10 }); advance(20) }
        advance(); wheel({ deltaY: 1, deltaMode: 2 })
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('resets after scrolling up or waiting too long between attempts', () => {
        wheel(); advance(); wheel()
        wheel({ deltaY: -50 })
        advance(); wheel()
        expect(onTrigger).not.toHaveBeenCalled()
        advance(6000); wheel(); advance(); wheel()
        expect(onTrigger).not.toHaveBeenCalled()
        advance(); wheel()
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('requires the actual page bottom, not just a visible footer', () => {
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1000 })
        attempts()
        expect(onAttempt).not.toHaveBeenCalled()
    })
    it('does not run without the site footer', () => {
        footer.remove()
        attempts()
        expect(onAttempt).not.toHaveBeenCalled()
    })
    it('ignores nested scrolling, form controls, and open dialogs', () => {
        const panel = document.createElement('div')
        panel.style.overflowY = 'auto'
        Object.defineProperty(panel, 'scrollHeight', { value: 500 })
        Object.defineProperty(panel, 'clientHeight', { value: 100 })
        document.body.append(panel)
        for (let i = 0; i < 3; i++) { advance(); wheel({}, panel) }
        const input = document.createElement('textarea')
        document.body.append(input)
        for (let i = 0; i < 3; i++) { advance(); wheel({}, input) }
        const dialog = document.createElement('div')
        dialog.setAttribute('aria-modal', 'true')
        document.body.append(dialog)
        attempts()
        expect(onAttempt).not.toHaveBeenCalled()
    })
    it('ignores body scroll locks', () => {
        document.body.style.overflow = 'hidden'
        attempts()
        expect(onAttempt).not.toHaveBeenCalled()
    })
    it('supports three fresh upward finger swipes at the bottom', () => {
        swipe(); advance(); swipe()
        expect(onTrigger).not.toHaveBeenCalled()
        advance(); swipe()
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('does not count arriving swipes, short swipes, downward swipes, or multi-touch', () => {
        now = 100; swipe()
        advance(800); swipe(500, 480)
        advance(); swipe(300, 500)
        fireEvent.touchStart(document.body, { touches: [{ identifier: 1, clientY: 500 }, { identifier: 2, clientY: 500 }] })
        fireEvent.touchEnd(document.body, { touches: [], changedTouches: [{ identifier: 1, clientY: 300 }] })
        expect(onAttempt).not.toHaveBeenCalled()
    })
    it('supports deliberate keyboard presses but ignores a held key', () => {
        for (let i = 0; i < 20; i++) { advance(); fireEvent.keyDown(document.body, { key: 'PageDown', repeat: true }) }
        expect(onAttempt).not.toHaveBeenCalled()
        for (const key of ['End', 'PageDown', ' ']) { advance(); fireEvent.keyDown(document.body, { key }) }
        expect(onTrigger).toHaveBeenCalledTimes(1)
    })
    it('removes all listeners on disposal', () => {
        dispose()
        attempts()
        expect(onAttempt).not.toHaveBeenCalled()
    })
})
