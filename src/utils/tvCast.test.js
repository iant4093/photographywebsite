import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeCastSdk } from '../test/fakeCastSdk'
import {
    CAST_IDLE, CAST_SDK_URL, canCast, castImage, createCastController, hasAirPlay, isAppleTouchDevice, loadCastSdk,
    resetCastSdk, watchAirPlay,
} from './tvCast'

const srcSet = (name) => [640, 960, 1440, 1920].map((width) => ({ width, url: `https://cdn.test/${name}-${width}.webp` }))
const photo = (name, extra = {}) => ({ id: name, url: `https://cdn.test/${name}.jpg`, previewSrcSet: srcSet(name), width: 3000, height: 2000, albumTitle: `Album ${name}`, ...extra })

afterEach(() => {
    resetCastSdk()
    document.head.querySelectorAll('script').forEach((script) => script.remove())
    delete window.__onGCastApiAvailable
})

describe('Cast support', () => {
    it('casts from Chromium browsers but not from iOS', () => {
        expect(canCast({ chrome: {}, navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140' } })).toBe(true)
        expect(canCast({ chrome: {}, navigator: { userAgent: 'Mozilla/5.0 (iPhone) CriOS/140' } })).toBe(false)
        expect(canCast({ navigator: { userAgent: 'Firefox' } })).toBe(false)
        expect(canCast(undefined)).toBe(false)
    })

    it('loads the sender once and reports whether it is usable', async () => {
        const win = { __onGCastApiAvailable: vi.fn() }
        const first = loadCastSdk(win, document)
        expect(loadCastSdk(win, document)).toBe(first)
        const script = document.head.querySelector('script')
        expect(script.src).toBe(CAST_SDK_URL)
        Object.assign(win, fakeCastSdk().win)
        win.__onGCastApiAvailable(true)
        await expect(first).resolves.toBe(true)

        resetCastSdk()
        const blocked = loadCastSdk({}, document)
        document.head.querySelectorAll('script')[1].onerror()
        await expect(blocked).resolves.toBe(false)
    })

    it('chains an earlier availability callback, and resolves at once when already loaded', async () => {
        const previous = vi.fn()
        const win = { __onGCastApiAvailable: previous }
        const pending = loadCastSdk(win, document)
        win.__onGCastApiAvailable(false)
        expect(previous).toHaveBeenCalledWith(false)
        await expect(pending).resolves.toBe(false)
        resetCastSdk()
        await expect(loadCastSdk(fakeCastSdk().win, document)).resolves.toBe(true)
    })

    it('sends the 1920 preview, or the original when there is no preview set', () => {
        expect(castImage(photo('a'))).toEqual({ url: 'https://cdn.test/a-1920.webp', contentType: 'image/webp' })
        expect(castImage({ url: 'https://cdn.test/raw.PNG?v=1' })).toEqual({ url: 'https://cdn.test/raw.PNG?v=1', contentType: 'image/png' })
        expect(castImage({ url: 'https://cdn.test/raw.jpg' }).contentType).toBe('image/jpeg')
        expect(castImage({})).toBeNull()
    })
})

describe('Cast controller', () => {
    it('reports the TV state and sends photos to the default receiver', () => {
        const { win, context, session } = fakeCastSdk()
        const onChange = vi.fn()
        const controller = createCastController(onChange, win)
        expect(context.setOptions).toHaveBeenCalledWith({ receiverApplicationId: 'CC1AD845', autoJoinPolicy: 'origin_scoped' })
        expect(onChange).toHaveBeenLastCalledWith({ available: true, connecting: false, connected: false, device: '' })

        controller.show(photo('a'))
        expect(session.loadMedia).not.toHaveBeenCalled()

        context.emit('CONNECTING')
        expect(onChange).toHaveBeenLastCalledWith({ ...CAST_IDLE, available: true, connecting: true })
        context.emit('CONNECTED')
        expect(onChange).toHaveBeenLastCalledWith({ available: true, connecting: false, connected: true, device: 'Living Room TV' })

        controller.show(photo('a'))
        const request = session.loadMedia.mock.calls[0][0]
        expect(request.media).toMatchObject({ contentId: 'https://cdn.test/a-1920.webp', contentType: 'image/webp' })
        expect(request.media.metadata).toMatchObject({ title: 'Album a', artist: 'Ian Truong', width: 3000, height: 2000 })

        controller.show(photo('b', { width: 0 }), { caption: false })
        const second = session.loadMedia.mock.calls[1][0].media.metadata
        expect(second.title).toBeUndefined()
        expect(second.width).toBeUndefined()
        controller.show({})
        expect(session.loadMedia).toHaveBeenCalledTimes(2)

        controller.open()
        expect(context.requestSession).toHaveBeenCalled()
        controller.dispose({ stop: true })
        expect(context.endCurrentSession).toHaveBeenCalledWith(true)
        expect(context.removeEventListener).toHaveBeenCalledTimes(2)
    })

    it('hides itself with no TV in range and leaves an idle session alone', () => {
        const { win, context } = fakeCastSdk({ state: 'NO_DEVICES_AVAILABLE' })
        const onChange = vi.fn()
        const controller = createCastController(onChange, win)
        expect(onChange).toHaveBeenLastCalledWith(CAST_IDLE)
        controller.dispose({ stop: true })
        controller.dispose()
        expect(context.endCurrentSession).not.toHaveBeenCalled()
    })
})

describe('AirPlay', () => {
    it('follows Safari AirPlay availability', () => {
        expect(hasAirPlay({})).toBe(false)
        expect(watchAirPlay(vi.fn(), {}, document)).toBeNull()
        const created = []
        const doc = { createElement: (tag) => { const element = document.createElement(tag); created.push(element); return element } }
        const onChange = vi.fn()
        const win = { WebKitPlaybackTargetAvailabilityEvent: class {} }
        expect(hasAirPlay(win)).toBe(true)
        const stop = watchAirPlay(onChange, win, doc)
        const probe = created[0]
        expect(probe.getAttribute('x-webkit-airplay')).toBe('allow')
        probe.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'not-available' }))
        expect(onChange).toHaveBeenLastCalledWith(false)
        probe.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'available' }))
        expect(onChange).toHaveBeenLastCalledWith(true)
        stop()
        probe.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'not-available' }))
        expect(onChange).toHaveBeenCalledTimes(2)
    })

    it('tells touch devices from Macs', () => {
        expect(isAppleTouchDevice({ navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } })).toBe(true)
        expect(isAppleTouchDevice({ navigator: { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 } })).toBe(true)
        expect(isAppleTouchDevice({ navigator: { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 } })).toBe(false)
        expect(isAppleTouchDevice({})).toBe(false)
    })
})
