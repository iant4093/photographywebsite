import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodedImageBytes, observeRetainedImage, RECENT_IMAGE_LIFETIME_MS, MAX_RECENT_IMAGES } from './imageRetention'

describe('bounded recent image retention', () => {
    let notify, observer, disposers, options
    const image = (width, height) => ({ naturalWidth: width, naturalHeight: height, srcset: '' })
    const enter = elements => notify(elements.map(target => ({ target, isIntersecting: true })))
    const leave = elements => notify(elements.map(target => ({ target, isIntersecting: false })))
    function register(width = 640, height = 427) {
        const element = document.createElement('div')
        const change = vi.fn()
        const controller = observeRetainedImage(element, change)
        disposers.push(controller.dispose)
        controller.loaded(image(width, height))
        return { element, change, ...controller }
    }
    beforeEach(() => {
        vi.useFakeTimers()
        disposers = []
        observer = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback, config) { notify = callback; options = config; return observer }
        })
    })
    afterEach(() => {
        disposers.forEach(dispose => dispose())
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('keeps the same images through rapid forward/reverse scrolling and cancels stale eviction', () => {
        const a = register()
        enter([a.element])
        for (let pass = 0; pass < 8; pass++) {
            leave([a.element])
            vi.advanceTimersByTime(1000)
            enter([a.element])
        }
        vi.advanceTimersByTime(RECENT_IMAGE_LIFETIME_MS)
        expect(a.change).not.toHaveBeenCalledWith(false)
        expect(vi.getTimerCount()).toBe(0)
        leave([a.element])
        vi.advanceTimersByTime(RECENT_IMAGE_LIFETIME_MS)
        expect(a.change).toHaveBeenLastCalledWith(false)
    })

    it('shares one observer and uses horizontal overscan without changing the vertical buffer', () => {
        const a = register(), b = register()
        expect(observer.observe).toHaveBeenCalledTimes(2)
        expect(options).toMatchObject({ rootMargin: '800px', scrollMargin: '0px 360px' })
        enter([a.element])
        expect(b.change).not.toHaveBeenCalled()
        leave([b.element])
        expect(vi.getTimerCount()).toBe(0)
    })

    it('bounds recently distant images by count while never evicting the approaching viewport', () => {
        const list = Array.from({ length: MAX_RECENT_IMAGES + 2 }, () => register(100, 100))
        enter(list.map(item => item.element))
        leave(list.slice(0, -1).map(item => item.element))
        expect(list[0].change).toHaveBeenLastCalledWith(false)
        expect(list[1].change).not.toHaveBeenCalledWith(false)
        expect(list.at(-1).change).not.toHaveBeenCalledWith(false)
        expect(vi.getTimerCount()).toBe(1)
    })

    it('uses decoded pixel sizes to evict old large images before the count limit', () => {
        const list = Array.from({ length: 4 }, () => register(2000, 1000))
        enter(list.map(item => item.element))
        leave(list.map(item => item.element))
        expect(list[0].change).toHaveBeenLastCalledWith(false)
        expect(list[1].change).not.toHaveBeenCalledWith(false)
        expect(list[3].change).not.toHaveBeenCalledWith(false)
    })

    it('rechecks the memory budget when a distant pending image finishes loading', () => {
        const a = register(), b = register()
        enter([a.element, b.element])
        leave([a.element, b.element])
        b.loaded(image(6000, 4000))
        expect(a.change).toHaveBeenLastCalledWith(false)
        expect(b.change).toHaveBeenLastCalledWith(false)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('protects a returning image before pruning new departures in the same observer batch', () => {
        const a = register(2400, 2000), b = register(2400, 2000)
        enter([a.element, b.element])
        leave([a.element])
        notify([{ target: b.element, isIntersecting: false }, { target: a.element, isIntersecting: true }])
        expect(a.change).not.toHaveBeenCalledWith(false)
        expect(b.change).not.toHaveBeenCalledWith(false)
    })

    it('releases distant images when the tab hides and removes pending work on final unmount', () => {
        const a = register()
        enter([a.element]); leave([a.element])
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
        document.dispatchEvent(new Event('visibilitychange'))
        expect(a.change).toHaveBeenLastCalledWith(false)
        enter([a.element]); leave([a.element])
        disposers.splice(0).forEach(dispose => dispose())
        expect(observer.unobserve).toHaveBeenCalledWith(a.element)
        expect(observer.disconnect).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('bounds featured loads to two, prioritizes visible cards and releases slots on completion or removal', () => {
        const list = Array.from({ length: 5 }, () => {
            const element = document.createElement('div'), change = vi.fn()
            const controller = observeRetainedImage(element, change, true)
            disposers.push(controller.dispose)
            return { element, change, ...controller }
        })
        expect(options).toMatchObject({ rootMargin: '120px 0px', scrollMargin: '0px 100px' })
        enter(list.map(item => item.element))
        vi.advanceTimersByTime(20)
        expect(list.map(item => item.change.mock.calls.length)).toEqual([1, 1, 0, 0, 0])
        leave([list[2].element])
        list[0].loaded(image(640, 400))
        vi.advanceTimersByTime(20)
        expect(list[2].change).not.toHaveBeenCalled()
        expect(list[3].change).toHaveBeenCalledWith(true)
        list[1].dispose(); disposers.splice(1, 1)
        vi.advanceTimersByTime(20)
        expect(list[4].change).toHaveBeenCalledWith(true)
    })

    it('pauses a queued featured frame when hidden before animation callbacks run', () => {
        const element = document.createElement('div'), change = vi.fn()
        const controller = observeRetainedImage(element, change, true)
        disposers.push(controller.dispose)
        enter([element])
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
        vi.advanceTimersByTime(20)
        expect(change).not.toHaveBeenCalled()
        hidden.mockReturnValue(false)
        document.dispatchEvent(new Event('visibilitychange'))
        vi.advanceTimersByTime(20)
        expect(change).toHaveBeenCalledWith(true)
    })

    it('falls back to normal image loading when observers are unavailable', () => {
        vi.stubGlobal('IntersectionObserver', undefined)
        const a = register()
        expect(a.change).toHaveBeenCalledWith(true)
    })

    it('accounts for the selected high-DPI srcset rather than density-corrected natural dimensions', () => {
        const sample = { ...image(320, 200), currentSrc: 'https://media.test/960.jpg',
            srcset: 'https://media.test/640.jpg 640w, https://media.test/960.jpg 960w' }
        expect(decodedImageBytes(sample)).toBe(960 * 600 * 4)
        expect(decodedImageBytes(image(1200, 800))).toBe(1200 * 800 * 4)
        expect(decodedImageBytes(image(0, 0))).toBeGreaterThan(0)
    })
})

describe('album viewport loading priority', () => {
    let observers, disposers, connection
    const image = { naturalWidth: 640, naturalHeight: 427, srcset: '' }
    const notify = (margin, entries) => observers.find(item => item.config.rootMargin === margin).callback(
        entries.map(([target, isIntersecting]) => ({ target, isIntersecting })),
    )
    function register(eager = false) {
        const element = document.createElement('div'), change = vi.fn()
        const control = observeRetainedImage(element, change, false, { viewportFirst: true, eager })
        disposers.push(control.dispose)
        return { element, change, ...control }
    }
    beforeEach(() => {
        vi.useFakeTimers()
        observers = []; disposers = []
        connection = Object.assign(new EventTarget(), { downlink: 10, rtt: 50, effectiveType: '4g', saveData: false })
        vi.stubGlobal('navigator', { connection })
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback, config) { this.callback = callback; this.config = config; observers.push(this) }
            observe = vi.fn()
            unobserve = vi.fn()
            disconnect = vi.fn()
        })
    })
    afterEach(() => {
        disposers.forEach(dispose => dispose())
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('waits for viewport information and eager/visible images before background downloads', () => {
        const first = register(true), second = register(), below = register()
        notify('800px', [[first.element, true], [second.element, true], [below.element, true]])
        vi.advanceTimersByTime(20)
        expect(second.change).not.toHaveBeenCalled()
        expect(below.change).not.toHaveBeenCalled()
        notify('0px', [[first.element, true], [second.element, true], [below.element, false]])
        vi.advanceTimersByTime(20)
        expect(second.change).toHaveBeenCalledWith(true)
        expect(below.change).not.toHaveBeenCalled()
        first.loaded(image)
        vi.advanceTimersByTime(20)
        expect(below.change).not.toHaveBeenCalled()
        second.loaded(image)
        vi.advanceTimersByTime(20)
        expect(below.change).toHaveBeenCalledWith(true)
    })

    it.each([
        [{ downlink: 10, rtt: 50 }, 2],
        [{ downlink: 1.5 }, 1],
        [{ rtt: 300 }, 1],
        [{ effectiveType: 'slow-2g' }, 1],
        [{ effectiveType: '3g' }, 1],
        [{ saveData: true }, 0],
    ])('bounds speculative downloads for %j', (settings, expected) => {
        Object.assign(connection, settings)
        const list = Array.from({ length: 4 }, () => register())
        notify('800px', list.map(item => [item.element, true]))
        notify('0px', list.map(item => [item.element, false]))
        vi.advanceTimersByTime(20)
        expect(list.filter(item => item.change.mock.calls.length)).toHaveLength(expected)
        if (expected) {
            list[0].loaded(image)
            vi.advanceTimersByTime(20)
            expect(list.filter(item => item.change.mock.calls.length)).toHaveLength(expected + 1)
        }
    })

    it('promotes newly visible photos immediately while offscreen downloads occupy their slots', () => {
        connection.downlink = 1
        const a = register(), b = register(), c = register()
        notify('800px', [[a.element, true], [b.element, true], [c.element, true]])
        notify('0px', [[a.element, false], [b.element, false], [c.element, false]])
        vi.advanceTimersByTime(20)
        expect(a.change).toHaveBeenCalledWith(true)
        expect(b.change).not.toHaveBeenCalled()
        notify('0px', [[b.element, true]])
        vi.advanceTimersByTime(20)
        expect(b.change).toHaveBeenCalledWith(true)
        a.loaded(image)
        vi.advanceTimersByTime(20)
        expect(c.change).not.toHaveBeenCalled()
        b.loaded(image)
        vi.advanceTimersByTime(20)
        expect(c.change).toHaveBeenCalledWith(true)
    })

    it('does not wait for a second load event when an already-complete image is observed again', () => {
        const cached = register(), below = register()
        cached.loaded(image)
        notify('800px', [[cached.element, true], [below.element, true]])
        notify('0px', [[cached.element, true], [below.element, false]])
        vi.advanceTimersByTime(20)
        expect(cached.change).toHaveBeenCalledWith(true)
        expect(below.change).toHaveBeenCalledWith(true)
    })

    it('keeps nearby revisits resident, drops departed queued work and releases a removed blocker', () => {
        const first = register(true), below = register(), departing = register()
        notify('800px', [[first.element, true], [below.element, true], [departing.element, true]])
        notify('0px', [[first.element, true], [below.element, false], [departing.element, false]])
        vi.advanceTimersByTime(20)
        notify('800px', [[departing.element, false]])
        first.dispose(); disposers.shift()
        vi.advanceTimersByTime(20)
        expect(below.change).toHaveBeenCalledWith(true)
        expect(departing.change).not.toHaveBeenCalled()
        below.loaded(image)
        notify('800px', [[below.element, false]])
        vi.advanceTimersByTime(500)
        notify('800px', [[below.element, true]])
        expect(below.change).not.toHaveBeenCalledWith(false)
        notify('800px', [[below.element, false]])
        vi.advanceTimersByTime(RECENT_IMAGE_LIFETIME_MS)
        expect(below.change).toHaveBeenLastCalledWith(false)
    })

    it('resumes after Save-Data changes and pauses while hidden without leaking observers', () => {
        connection.saveData = true
        const a = register(), b = register()
        notify('800px', [[a.element, true], [b.element, true]])
        notify('0px', [[a.element, false], [b.element, false]])
        vi.advanceTimersByTime(20)
        expect(a.change).not.toHaveBeenCalled()
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
        connection.saveData = false
        connection.dispatchEvent(new Event('change'))
        vi.advanceTimersByTime(20)
        expect(a.change).not.toHaveBeenCalled()
        hidden.mockReturnValue(false)
        document.dispatchEvent(new Event('visibilitychange'))
        vi.advanceTimersByTime(20)
        expect(a.change).toHaveBeenCalledWith(true)
        disposers.splice(0).forEach(dispose => dispose())
        observers.forEach(observer => expect(observer.disconnect).toHaveBeenCalledOnce())
        expect(vi.getTimerCount()).toBe(0)
    })
})
