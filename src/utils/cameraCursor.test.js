import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCameraCursor } from './cameraCursor'

describe('camera cursor interaction and lifecycle', () => {
    let dispose
    let fixture
    let hit
    let frames
    let queries
    let nextFrame

    const cursor = () => document.querySelector('.camera-cursor')
    const active = () => document.documentElement.hasAttribute('data-camera-cursor-active')
    function element(tag = 'div', attributes = {}) {
        const node = document.createElement(tag)
        Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value))
        fixture.append(node)
        return node
    }
    function flush() {
        const queued = [...frames.values()]
        frames.clear()
        queued.forEach(callback => callback())
    }
    function pointer(target, type = 'pointermove', options = {}) {
        hit = target
        const event = new Event(type, { bubbles: true })
        Object.assign(event, { clientX: 120, clientY: 90, pointerType: 'mouse', button: 0, ...options })
        target.dispatchEvent(event)
        flush()
    }

    beforeEach(() => {
        vi.useFakeTimers()
        fixture = document.createElement('section')
        document.body.append(fixture)
        hit = fixture
        frames = new Map()
        nextFrame = 0
        queries = new Map()
        vi.spyOn(window, 'matchMedia').mockImplementation(query => {
            const result = new EventTarget()
            result.matches = query === '(any-pointer: fine)'
            queries.set(query, result)
            return result
        })
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            frames.set(++nextFrame, callback)
            return nextFrame
        })
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id))
        Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => hit) })
        dispose = installCameraCursor()
    })

    afterEach(() => {
        dispose()
        fixture.remove()
        delete document.elementFromPoint
        delete document.fullscreenElement
        delete document.pointerLockElement
        vi.useRealTimers()
    })

    it('keeps the system cursor until a mouse arrives, then follows without a loop or labels', () => {
        expect(active()).toBe(false)
        expect(frames.size).toBe(0)
        pointer(fixture)
        expect(active()).toBe(true)
        expect(cursor()).toHaveAttribute('data-state', 'camera')
        expect(cursor().style.transform).toBe('translate3d(120px, 90px, 0)')
        expect(cursor()).toHaveAttribute('aria-hidden', 'true')
        expect(cursor().textContent).toBe('')
        expect(frames.size).toBe(0)
    })

    it('flashes once per entered photo, including re-entry after native text', () => {
        const first = element('button', { 'data-camera-cursor': 'photo' })
        const child = document.createElement('span')
        first.append(child)
        pointer(first)
        expect(cursor()).toHaveAttribute('data-state', 'photo')
        const original = cursor().querySelector('svg')
        expect(original.querySelector('.camera-cursor-flash')).not.toBeNull()
        pointer(child)
        expect(cursor().querySelector('svg')).toBe(original)
        const second = element('button', { 'data-camera-cursor': 'photo' })
        pointer(second)
        expect(cursor().querySelector('svg')).not.toBe(original)
        const secondIcon = cursor().querySelector('svg')
        pointer(element('p'))
        expect(active()).toBe(false)
        pointer(second)
        expect(cursor().querySelector('svg')).not.toBe(secondIcon)
    })

    it.each([
        ['input', { type: 'text' }], ['input', { type: 'range' }], ['input', { type: 'password' }],
        ['textarea', {}], ['select', {}], ['p', {}], ['div', { contenteditable: 'true' }],
        ['button', { disabled: '' }], ['button', { 'aria-disabled': 'true' }],
        ['div', { inert: '' }], ['div', { 'data-camera-cursor': 'native' }],
        ['video', { controls: '' }], ['canvas', {}], ['iframe', {}], ['dialog', { open: '' }],
    ])('restores the native cursor over %s %j', (tag, attributes) => {
        pointer(fixture)
        pointer(element(tag, attributes))
        expect(active()).toBe(false)
        expect(cursor()).not.toHaveClass('is-visible')
    })

    it.each(['canvas', 'video'])('keeps the album flash over a decorative %s and its image', tag => {
        const album = element('a', { href: '/album/example', 'data-camera-cursor': 'photo' })
        const image = document.createElement('img')
        const preview = document.createElement(tag)
        const layer = document.createElement('div')
        layer.setAttribute('aria-hidden', 'true')
        layer.append(preview)
        album.append(image, layer)

        pointer(image)
        const flash = cursor().querySelector('svg')
        pointer(preview)
        expect(active()).toBe(true)
        expect(cursor()).toHaveAttribute('data-state', 'photo')
        expect(cursor().querySelector('svg')).toBe(flash)
        layer.style.opacity = '0'
        pointer(preview)
        expect(active()).toBe(true)
        expect(cursor().querySelector('svg')).toBe(flash)
        layer.remove()
        pointer(image)
        expect(cursor().querySelector('svg')).toBe(flash)
    })

    it.each(['canvas', 'video'])('preserves native %s interaction inside a marked album', tag => {
        const album = element('button', { 'data-camera-cursor': 'photo' })
        const media = document.createElement(tag)
        album.append(media)
        pointer(media)
        expect(active()).toBe(false)
        media.setAttribute('aria-hidden', 'true')
        pointer(media)
        expect(active()).toBe(true)
        album.disabled = true
        pointer(media)
        expect(active()).toBe(false)
    })

    it('restores video controls under a stationary pointer even on decorative album media', async () => {
        const album = element('a', { href: '/video/example', 'data-camera-cursor': 'photo' })
        const video = document.createElement('video')
        video.setAttribute('aria-hidden', 'true')
        album.append(video)
        pointer(video)
        expect(active()).toBe(true)
        video.controls = true
        await Promise.resolve()
        flush()
        expect(active()).toBe(false)
        video.controls = false
        await Promise.resolve()
        flush()
        expect(active()).toBe(true)
    })

    it.each(['touch', 'pen'])('does not replace a %s pointer on a hybrid device', type => {
        pointer(fixture)
        pointer(fixture, 'pointerdown', { pointerType: type })
        expect(active()).toBe(false)
        pointer(fixture, 'pointermove', { pointerType: type })
        expect(active()).toBe(false)
        pointer(fixture)
        expect(active()).toBe(true)
    })

    it('respects capability and high-contrast changes', () => {
        pointer(fixture)
        const fine = queries.get('(any-pointer: fine)')
        fine.matches = false
        fine.dispatchEvent(new Event('change'))
        pointer(fixture)
        expect(active()).toBe(false)
        fine.matches = true
        const contrast = queries.get('(forced-colors: active)')
        contrast.matches = true
        contrast.dispatchEvent(new Event('change'))
        pointer(fixture)
        expect(active()).toBe(false)
    })

    it('uses real control states inside a portaled viewer', () => {
        const portal = element('div', { role: 'dialog', 'aria-modal': 'true' })
        for (const state of ['close', 'next', 'previous']) {
            const button = document.createElement('button')
            button.dataset.cameraCursor = state
            const child = document.createElement('span')
            button.append(child)
            portal.append(button)
            pointer(child)
            expect(active()).toBe(true)
            expect(cursor()).toHaveAttribute('data-state', state)
        }
        const link = element('a', { href: '/contact' })
        const title = document.createElement('h2')
        link.append(title)
        pointer(title)
        expect(cursor()).toHaveAttribute('data-state', 'link')
        pointer(element('input', { type: 'checkbox' }))
        expect(cursor()).toHaveAttribute('data-state', 'link')
        pointer(element('button', { 'aria-busy': 'true' }))
        expect(cursor()).toHaveAttribute('data-state', 'loading')
    })

    it('keeps vertical dragging meaningful through pointer capture and releases click feedback', () => {
        const rail = element('div', { 'data-camera-cursor': 'drag-y' })
        pointer(rail)
        expect(cursor()).toHaveAttribute('data-state', 'drag-y')
        pointer(rail, 'pointerdown')
        expect(cursor()).toHaveAttribute('data-state', 'drag-y-held')
        expect(cursor()).toHaveClass('is-pressed')
        pointer(fixture)
        expect(cursor()).toHaveAttribute('data-state', 'drag-y-held')
        pointer(rail, 'pointerup')
        expect(cursor()).toHaveAttribute('data-state', 'drag-y')
        vi.advanceTimersByTime(100)
        expect(cursor()).not.toHaveClass('is-pressed')
    })

    it('restores the native pointer when tabbing, leaving the page, or losing focus', () => {
        pointer(fixture)
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
        expect(active()).toBe(false)
        pointer(fixture)
        pointer(fixture, 'pointerout', { relatedTarget: null })
        expect(active()).toBe(false)
        pointer(fixture)
        window.dispatchEvent(new Event('blur'))
        expect(active()).toBe(false)
        pointer(fixture)
        pointer(fixture, 'pointercancel')
        expect(active()).toBe(false)
    })

    it.each(['fullscreenElement', 'pointerLockElement'])('leaves %s in control of its pointer', property => {
        Object.defineProperty(document, property, { configurable: true, value: fixture })
        pointer(fixture)
        expect(active()).toBe(false)
    })

    it('refreshes a stationary pointer after DOM changes without observing its own SVG forever', async () => {
        pointer(fixture)
        hit = element('button', { 'data-camera-cursor': 'photo' })
        await Promise.resolve()
        flush()
        expect(cursor()).toHaveAttribute('data-state', 'photo')
        await Promise.resolve()
        expect(frames.size).toBe(0)
        hit.remove()
        await Promise.resolve()
        flush()
        expect(active()).toBe(false)
    })

    it('removes pending work, listeners, overlay, and the cursor override on unmount', async () => {
        pointer(fixture, 'pointerdown')
        pointer(fixture, 'pointerup')
        document.dispatchEvent(new Event('scroll'))
        dispose()
        expect(active()).toBe(false)
        expect(cursor()).toBeNull()
        expect(frames.size).toBe(0)
        pointer(fixture)
        element('button')
        await Promise.resolve()
        expect(frames.size).toBe(0)
    })
})
