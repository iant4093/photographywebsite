import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCameraCursor } from './cameraCursor'

describe('camera cursor interaction and lifecycle', () => {
    let dispose
    let fixture
    let hit
    let frames
    let queries
    let nextFrame
    let textRects

    const cursor = () => document.documentElement
    const icon = () => cursor().style.getPropertyValue('--camera-cursor-image')
    const active = () => document.documentElement.hasAttribute('data-camera-cursor-active')
    function element(tag = 'div', attributes = {}) {
        const node = document.createElement(tag)
        Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value))
        fixture.append(node)
        return node
    }
    function text(node, value, rects = [{ left: 100, right: 200, top: 80, bottom: 100, width: 100, height: 20 }]) {
        const content = document.createTextNode(value)
        node.append(content)
        textRects.set(content, rects)
        return content
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
        textRects = new WeakMap()
        const createRange = document.createRange.bind(document)
        vi.spyOn(document, 'createRange').mockImplementation(() => {
            const range = createRange()
            range.getClientRects = () => textRects.get(range.startContainer) || []
            return range
        })
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
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'camera')
        expect(icon()).toContain('data:image/svg+xml,')
        expect(icon()).toContain('16 16, auto')
        expect(document.querySelector('.camera-cursor')).toBeNull()
        expect(frames.size).toBe(0)
    })

    it('moves repeatedly over one album without repeating hit tests, ancestor searches, or root writes', () => {
        const album = element('a', { href: '/album/example', 'data-camera-cursor': 'photo' })
        pointer(album)
        const search = vi.spyOn(album, 'closest')
        const rootWrite = vi.spyOn(document.documentElement, 'setAttribute')
        document.elementFromPoint.mockClear()
        window.requestAnimationFrame.mockClear()
        const originalIcon = icon()
        for (let index = 0; index < 100; index += 1) pointer(album, 'pointermove', { clientX: 130 + index })
        expect(document.elementFromPoint).not.toHaveBeenCalled()
        expect(search).not.toHaveBeenCalled()
        expect(rootWrite).not.toHaveBeenCalled()
        expect(icon()).toBe(originalIcon)
        expect(window.requestAnimationFrame).not.toHaveBeenCalled()
        expect(frames.size).toBe(0)
    })

    it('reuses text rectangles across movement and invalidates them when layout or text changes', async () => {
        const paragraph = element('p')
        const content = text(paragraph, 'Photo Albums')
        pointer(paragraph, 'pointermove', { clientX: 250 })
        document.createRange.mockClear()
        for (let index = 0; index < 100; index += 1) pointer(paragraph, 'pointermove', { clientX: 250 + index })
        pointer(paragraph)
        expect(active()).toBe(false)
        expect(document.createRange).not.toHaveBeenCalled()

        document.dispatchEvent(new Event('scroll'))
        flush()
        expect(document.createRange).toHaveBeenCalledOnce()
        document.createRange.mockClear()
        content.data = ''
        await Promise.resolve()
        flush()
        expect(document.createRange).toHaveBeenCalledOnce()
        expect(active()).toBe(true)
    })

    it('reclassifies changed native and disabled states without waiting for another mouse move', async () => {
        const button = element('button')
        pointer(button)
        expect(active()).toBe(true)
        button.disabled = true
        await Promise.resolve()
        flush()
        expect(active()).toBe(false)
        button.disabled = false
        button.dataset.cameraCursor = 'photo'
        await Promise.resolve()
        flush()
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'photo')
    })

    it('switches magnifier direction after a zoom without needing pointer movement', async () => {
        const photo = element('button', { 'data-camera-cursor': 'zoom-in' })
        pointer(photo)
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'zoom-in')
        const zoomInIcon = icon()
        photo.dataset.cameraCursor = 'zoom-out'
        await Promise.resolve()
        flush()
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'zoom-out')
        expect(icon()).not.toBe(zoomInIcon)
    })

    it('reuses the native photo icon across albums and restores it after native text', () => {
        const first = element('button', { 'data-camera-cursor': 'photo' })
        const child = document.createElement('span')
        first.append(child)
        pointer(first)
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'photo')
        const original = icon()
        expect(decodeURIComponent(original)).toContain('camera-cursor-flash')
        pointer(child)
        expect(icon()).toBe(original)
        const second = element('button', { 'data-camera-cursor': 'photo' })
        pointer(second)
        expect(icon()).toBe(original)
        const secondIcon = icon()
        const paragraph = element('p')
        text(paragraph, 'Select this text')
        pointer(paragraph)
        expect(active()).toBe(false)
        pointer(second)
        expect(icon()).toBe(secondIcon)
    })

    it.each([
        ['input', { type: 'text' }], ['input', { type: 'range' }], ['input', { type: 'password' }],
        ['textarea', {}], ['select', {}], ['div', { contenteditable: 'true' }],
        ['button', { disabled: '' }], ['button', { 'aria-disabled': 'true' }],
        ['div', { inert: '' }], ['div', { 'data-camera-cursor': 'native' }],
        ['video', { controls: '' }], ['canvas', {}], ['iframe', {}], ['dialog', { open: '' }],
    ])('restores the native cursor over %s %j', (tag, attributes) => {
        pointer(fixture)
        pointer(element(tag, attributes))
        expect(active()).toBe(false)
    })

    it('keeps the camera beside a heading while preserving text selection over its letters', () => {
        const heading = element('h2')
        text(heading, 'Photo Albums')
        pointer(heading, 'pointermove', { clientX: 250 })
        expect(active()).toBe(true)
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'camera')
        pointer(heading)
        expect(active()).toBe(false)
        pointer(heading, 'pointermove', { clientX: 200 })
        expect(active()).toBe(true)
    })

    it('keeps the camera after a short final line and between lines in a paragraph', () => {
        const paragraph = element('p')
        text(paragraph, "Hi, I'm Ian — welcome to my photography portfolio. Take a look around!", [
            { left: 100, right: 450, top: 80, bottom: 100, width: 350, height: 20 },
            { left: 100, right: 180, top: 120, bottom: 140, width: 80, height: 20 },
        ])
        pointer(paragraph, 'pointermove', { clientX: 250, clientY: 130 })
        expect(active()).toBe(true)
        pointer(paragraph, 'pointermove', { clientX: 120, clientY: 130 })
        expect(active()).toBe(false)
        pointer(paragraph, 'pointermove', { clientY: 110 })
        expect(active()).toBe(true)
        pointer(paragraph, 'pointermove', { clientY: 150 })
        expect(active()).toBe(true)
    })

    it('keeps empty blocks, whitespace-only nodes, and hidden text on the camera', () => {
        const paragraph = element('p')
        pointer(paragraph)
        expect(active()).toBe(true)
        text(paragraph, '   \n  ')
        text(paragraph, 'Hidden text', [])
        text(paragraph, 'Collapsed text', [{ left: 120, right: 120, top: 90, bottom: 90, width: 0, height: 0 }])
        pointer(paragraph)
        expect(active()).toBe(true)
    })

    it('checks nested text fragments without overriding links or album flash targets', () => {
        const paragraph = element('p')
        const emphasis = document.createElement('strong')
        paragraph.append(emphasis)
        text(emphasis, 'Photography')
        pointer(emphasis)
        expect(active()).toBe(false)
        pointer(emphasis, 'pointermove', { clientX: 250 })
        expect(active()).toBe(true)
        const link = document.createElement('a')
        link.href = '/videos'
        paragraph.append(link)
        text(link, 'View videos')
        pointer(link)
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'link')
        paragraph.dataset.cameraCursor = 'photo'
        pointer(emphasis)
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'photo')
    })

    it('rechecks text geometry after wrapping and scrolling under a stationary pointer', () => {
        const paragraph = element('p')
        const content = text(paragraph, 'Responsive introduction')
        pointer(paragraph)
        expect(active()).toBe(false)
        textRects.set(content, [{ left: 100, right: 110, top: 80, bottom: 100, width: 10, height: 20 }])
        window.dispatchEvent(new Event('resize'))
        flush()
        expect(active()).toBe(true)
        textRects.set(content, [{ left: 100, right: 200, top: 80, bottom: 100, width: 100, height: 20 }])
        document.dispatchEvent(new Event('scroll'))
        flush()
        expect(active()).toBe(false)
    })

    it('rechecks edited text under a stationary pointer', async () => {
        const paragraph = element('p')
        const content = text(paragraph, 'Introduction')
        pointer(paragraph)
        expect(active()).toBe(false)
        await Promise.resolve()
        flush()
        content.data = ''
        await Promise.resolve()
        flush()
        expect(active()).toBe(true)
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
        const flash = icon()
        pointer(preview)
        expect(active()).toBe(true)
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'photo')
        expect(icon()).toBe(flash)
        layer.style.opacity = '0'
        pointer(preview)
        expect(active()).toBe(true)
        expect(icon()).toBe(flash)
        layer.remove()
        pointer(image)
        expect(icon()).toBe(flash)
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
            expect(cursor()).toHaveAttribute('data-camera-cursor-state', state)
        }
        const link = element('a', { href: '/contact' })
        const title = document.createElement('h2')
        link.append(title)
        pointer(title)
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'link')
        pointer(element('input', { type: 'checkbox' }))
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'link')
        pointer(element('button', { 'aria-busy': 'true' }))
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'loading')
    })

    it('keeps vertical dragging meaningful through pointer capture and releases click feedback', () => {
        const rail = element('div', { 'data-camera-cursor': 'drag-y' })
        pointer(rail)
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'drag-y')
        pointer(rail, 'pointerdown')
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'drag-y-held')
        expect(decodeURIComponent(icon())).toContain('scale(0.8)')
        pointer(fixture)
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'drag-y-held')
        pointer(rail, 'pointerup')
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'drag-y')
        vi.advanceTimersByTime(100)
        expect(decodeURIComponent(icon())).toContain('scale(1)')
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

    it('refreshes a stationary pointer after DOM changes without observing its own cursor styles', async () => {
        pointer(fixture)
        hit = element('button', { 'data-camera-cursor': 'photo' })
        await Promise.resolve()
        flush()
        expect(cursor()).toHaveAttribute('data-camera-cursor-state', 'photo')
        await Promise.resolve()
        expect(frames.size).toBe(0)
        hit.remove()
        await Promise.resolve()
        flush()
        expect(active()).toBe(false)
    })

    it('removes pending work, listeners, and the native cursor override on unmount', async () => {
        pointer(fixture, 'pointerdown')
        pointer(fixture, 'pointerup')
        document.dispatchEvent(new Event('scroll'))
        dispose()
        expect(active()).toBe(false)
        expect(icon()).toBe('')
        expect(cursor()).not.toHaveAttribute('data-camera-cursor-state')
        expect(frames.size).toBe(0)
        pointer(fixture)
        element('button')
        await Promise.resolve()
        expect(frames.size).toBe(0)
    })
})
