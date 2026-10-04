import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hlsState = vi.hoisted(() => ({ instances: [], supported: true }))
vi.mock('hls.js', () => {
    class Hls {
        static Events = { ERROR: 'hlsError' }
        static isSupported = () => hlsState.supported
        constructor(config) {
            this.config = config
            this.handlers = {}
            this.loadSource = vi.fn()
            this.attachMedia = vi.fn()
            this.destroy = vi.fn()
            this.on = vi.fn((event, callback) => { this.handlers[event] = callback })
            hlsState.instances.push(this)
        }
    }
    return { default: Hls }
})

vi.mock('../utils/heroReel', async (importOriginal) => ({
    ...(await importOriginal()),
    fetchHeroReel: vi.fn(),
}))

import { fetchHeroReel } from '../utils/heroReel'
import HeroReel, { HERO_REEL_UNLOAD_MS } from './HeroReel'

const renditions = [
    { width: 1920, height: 1080, url: 'https://media.example/reel-1920x1080.mp4' },
    { width: 1280, height: 720, url: 'https://media.example/reel-1280x720.mp4' },
    { width: 608, height: 1080, url: 'https://media.example/reel-608x1080.mp4' },
]
const reel = { version: 'a'.repeat(24), cuts: [{ renditions }] }
const streams = {
    landscape: 'https://media.example/reel-0-landscape.m3u8',
    portrait: 'https://media.example/reel-0-portrait.m3u8',
}
const adaptive = { version: 'a'.repeat(24), cuts: [{ streams, renditions: [] }] }

let observerCallback
let sectionSize

function Harness() {
    const ref = useRef(null)
    return (
        <section className="linen-video-hero">
            <HeroReel videoRef={ref} />
        </section>
    )
}

function mount() {
    const view = render(<Harness />)
    const section = view.container.querySelector('section')
    section.getBoundingClientRect = () => ({ width: sectionSize.width, height: sectionSize.height })
    const [video, spare] = view.container.querySelectorAll('video')
    return { ...view, wrapper: view.container.querySelector('.hero-reel'), video, spare }
}

function media(video, values) {
    for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(video, key, { configurable: true, writable: true, value })
    }
}

async function loaded(video) {
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(fetchHeroReel).toHaveBeenCalledTimes(1)
    await act(async () => {})
    return video
}

describe('video hero reel', () => {
    const originalMatchMedia = window.matchMedia
    beforeEach(() => {
        observerCallback = undefined
        hlsState.instances.length = 0
        hlsState.supported = true
        vi.useFakeTimers()
        sectionSize = { width: 1440, height: 780 }
        fetchHeroReel.mockReset().mockResolvedValue(reel)
        window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
        window.devicePixelRatio = 1
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback) { observerCallback = callback }
            observe() {}
            disconnect() { observerCallback = null }
        })
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
        vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    })
    afterEach(() => {
        // Unmount while the media stubs are still installed.
        cleanup()
        vi.useRealTimers()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
        window.matchMedia = originalMatchMedia
    })

    it('renders nothing for reduced motion and never fetches the reel', async () => {
        window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
        const { wrapper, video } = mount()
        expect(wrapper).toBeNull()
        expect(video).toBeUndefined()
        await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
        expect(fetchHeroReel).not.toHaveBeenCalled()
    })

    it('loads after the page settles, plays muted only while visible, and fades in once playing', async () => {
        const { wrapper, video, spare } = mount()
        expect(video).toHaveAttribute('preload', 'none')
        expect(wrapper).toHaveAttribute('aria-hidden', 'true')
        expect(video).toHaveClass('is-active')
        expect(spare).not.toHaveClass('is-active')
        expect(video.getAttribute('src')).toBeNull()
        await loaded(video)
        expect(video.muted).toBe(true)
        expect(video).toHaveAttribute('playsinline')
        expect(video.getAttribute('src')).toBeNull()

        act(() => observerCallback([{ isIntersecting: true }]))
        expect(video.getAttribute('src')).toBe('https://media.example/reel-1280x720.mp4')
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
        expect(wrapper).not.toHaveClass('is-playing')
        act(() => video.dispatchEvent(new Event('playing')))
        expect(wrapper).toHaveClass('is-playing')
        expect(spare.getAttribute('src')).toBeNull()

        act(() => observerCallback([{ isIntersecting: false }]))
        expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
        expect(video.getAttribute('src')).not.toBeNull()
        act(() => observerCallback([{ isIntersecting: true }]))
        await act(async () => { await vi.advanceTimersByTimeAsync(HERO_REEL_UNLOAD_MS + 10) })
        expect(video.getAttribute('src')).not.toBeNull()

        act(() => observerCallback([{ isIntersecting: false }]))
        await act(async () => { await vi.advanceTimersByTimeAsync(HERO_REEL_UNLOAD_MS + 10) })
        expect(video.getAttribute('src')).toBeNull()
        expect(wrapper).not.toHaveClass('is-playing')
        expect(HTMLMediaElement.prototype.load).toHaveBeenCalled()

        act(() => observerCallback([{ isIntersecting: true }]))
        expect(video.getAttribute('src')).toBe('https://media.example/reel-1280x720.mp4')
    })

    it('uses the portrait cut on phones and swaps renditions mid-play without restarting', async () => {
        sectionSize = { width: 390, height: 740 }
        window.devicePixelRatio = 3
        const { wrapper, video, spare } = mount()
        await loaded(video)
        act(() => observerCallback([{ isIntersecting: true }]))
        expect(video.getAttribute('src')).toBe('https://media.example/reel-608x1080.mp4')
        act(() => video.dispatchEvent(new Event('playing')))
        media(video, { paused: false, currentTime: 42.5 })
        HTMLMediaElement.prototype.play.mockClear()

        sectionSize = { width: 900, height: 600 }
        act(() => window.dispatchEvent(new Event('resize')))
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        // The landscape file loads behind the portrait one, which keeps playing.
        expect(video.getAttribute('src')).toBe('https://media.example/reel-608x1080.mp4')
        expect(spare.getAttribute('src')).toBe('https://media.example/reel-1920x1080.mp4')
        expect(spare.preload).toBe('auto')
        expect(HTMLMediaElement.prototype.play.mock.contexts).toEqual([spare])
        expect(video).toHaveClass('is-active')

        media(spare, { duration: 40, paused: false })
        act(() => spare.dispatchEvent(new Event('loadedmetadata')))
        expect(spare.currentTime).toBe(2.5)
        // A slow seek is corrected by aiming ahead.
        media(video, { currentTime: 43 })
        act(() => spare.dispatchEvent(new Event('seeked')))
        expect(spare.currentTime).toBe(3.5)
        expect(video).toHaveClass('is-active')
        media(video, { currentTime: 43.6 })
        media(spare, { currentTime: 3.62 })
        act(() => spare.dispatchEvent(new Event('seeked')))
        expect(spare).toHaveClass('is-active')
        expect(video).not.toHaveClass('is-active')
        expect(video.getAttribute('src')).toBeNull()
        expect(wrapper).toHaveClass('is-playing')

        // The next swap reuses the first layer, and waits for real playback.
        sectionSize = { width: 390, height: 740 }
        media(spare, { currentTime: 10 })
        media(video, { duration: 40, paused: true })
        act(() => window.dispatchEvent(new Event('resize')))
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        expect(video.getAttribute('src')).toBe('https://media.example/reel-608x1080.mp4')
        act(() => video.dispatchEvent(new Event('loadedmetadata')))
        act(() => video.dispatchEvent(new Event('playing')))
        expect(spare).toHaveClass('is-active')
        HTMLMediaElement.prototype.play.mockClear()
        act(() => video.dispatchEvent(new Event('seeked')))
        expect(HTMLMediaElement.prototype.play.mock.contexts).toEqual([video])
        expect(spare).toHaveClass('is-active')
        act(() => video.dispatchEvent(new Event('playing')))
        expect(video).toHaveClass('is-active')
        expect(spare.getAttribute('src')).toBeNull()
    })

    it('swaps a paused reel in place and lets a resize back cancel a pending swap', async () => {
        const { video, spare } = mount()
        await loaded(video)
        act(() => observerCallback([{ isIntersecting: true }]))
        media(video, { paused: false, currentTime: 5 })
        sectionSize = { width: 390, height: 740 }
        act(() => window.dispatchEvent(new Event('resize')))
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        expect(spare.getAttribute('src')).toBe('https://media.example/reel-608x1080.mp4')

        // Rotating back before the swap lands keeps the current file.
        sectionSize = { width: 1440, height: 780 }
        act(() => window.dispatchEvent(new Event('resize')))
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        expect(spare.getAttribute('src')).toBeNull()
        expect(video.getAttribute('src')).toBe('https://media.example/reel-1280x720.mp4')

        // Scrolled away (paused): the swap still keeps the position.
        act(() => observerCallback([{ isIntersecting: false }]))
        media(video, { paused: true })
        HTMLMediaElement.prototype.play.mockClear()
        sectionSize = { width: 390, height: 740 }
        act(() => window.dispatchEvent(new Event('resize')))
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
        // Returning resumes both layers so the pending one can load.
        act(() => observerCallback([{ isIntersecting: true }]))
        expect(HTMLMediaElement.prototype.play.mock.contexts).toEqual([video, spare])
        act(() => observerCallback([{ isIntersecting: false }]))
        HTMLMediaElement.prototype.pause.mockClear()
        act(() => spare.dispatchEvent(new Event('loadedmetadata')))
        expect(spare.currentTime).toBe(5)
        act(() => spare.dispatchEvent(new Event('seeked')))
        expect(HTMLMediaElement.prototype.pause.mock.contexts).toContain(spare)
        expect(spare).toHaveClass('is-active')
        expect(video.getAttribute('src')).toBeNull()
        await act(async () => { await vi.advanceTimersByTimeAsync(HERO_REEL_UNLOAD_MS + 10) })
        expect(spare.getAttribute('src')).toBeNull()
    })

    it('keeps the playing rendition when the swap layer may not autoplay', async () => {
        const { wrapper, video, spare } = mount()
        await loaded(video)
        act(() => observerCallback([{ isIntersecting: true }]))
        act(() => video.dispatchEvent(new Event('playing')))
        media(video, { paused: false })
        HTMLMediaElement.prototype.play.mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
        sectionSize = { width: 390, height: 740 }
        act(() => window.dispatchEvent(new Event('resize')))
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        expect(spare.getAttribute('src')).toBeNull()
        expect(video.getAttribute('src')).toBe('https://media.example/reel-1280x720.mp4')
        expect(wrapper).toHaveClass('is-playing')
    })

    it('keeps the working rendition when the new one fails to load', async () => {
        const { wrapper, video, spare } = mount()
        await loaded(video)
        act(() => observerCallback([{ isIntersecting: true }]))
        act(() => video.dispatchEvent(new Event('playing')))
        sectionSize = { width: 390, height: 740 }
        act(() => window.dispatchEvent(new Event('resize')))
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        act(() => spare.dispatchEvent(new Event('error')))
        expect(spare.getAttribute('src')).toBeNull()
        expect(video.getAttribute('src')).toBe('https://media.example/reel-1280x720.mp4')
        expect(wrapper).toHaveClass('is-playing')
        // The failed size is not retried until the hero changes shape again.
        act(() => window.dispatchEvent(new Event('resize')))
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        expect(spare.getAttribute('src')).toBeNull()
    })

    it('pauses in background tabs and resumes when visible again', async () => {
        const { video } = mount()
        await loaded(video)
        act(() => observerCallback([{ isIntersecting: true }]))
        HTMLMediaElement.prototype.play.mockClear()
        Object.defineProperty(document, 'hidden', { configurable: true, value: true })
        act(() => document.dispatchEvent(new Event('visibilitychange')))
        expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
        Object.defineProperty(document, 'hidden', { configurable: true, value: false })
        act(() => document.dispatchEvent(new Event('visibilitychange')))
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
    })

    it('gives up quietly when autoplay is refused or the file fails', async () => {
        HTMLMediaElement.prototype.play.mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
        const { video } = mount()
        await loaded(video)
        await act(async () => { observerCallback([{ isIntersecting: true }]) })
        expect(video.getAttribute('src')).toBeNull()
        act(() => observerCallback([{ isIntersecting: true }]))
        expect(video.getAttribute('src')).toBeNull()
    })

    it('stops after a media error and cleans up on unmount', async () => {
        const { video, unmount } = mount()
        await loaded(video)
        act(() => observerCallback([{ isIntersecting: true }]))
        act(() => video.dispatchEvent(new Event('error')))
        expect(video.getAttribute('src')).toBeNull()
        act(() => observerCallback([{ isIntersecting: true }]))
        expect(video.getAttribute('src')).toBeNull()
        unmount()
        expect(observerCallback).toBeNull()
    })

    it('plays a random one of the published cuts', async () => {
        const other = renditions.map((item) => ({ ...item, url: item.url.replace('reel-', 'cut2-') }))
        fetchHeroReel.mockResolvedValue({ version: reel.version, cuts: [{ renditions }, { renditions: other }] })
        vi.spyOn(Math, 'random').mockReturnValue(0.9)
        const { video } = mount()
        await loaded(video)
        act(() => observerCallback([{ isIntersecting: true }]))
        expect(video.getAttribute('src')).toBe('https://media.example/cut2-1280x720.mp4')
    })

    it('streams adaptive cuts through hls.js and swaps orientation streams without restarting', async () => {
        fetchHeroReel.mockResolvedValue(adaptive)
        const { wrapper, video, spare } = mount()
        await loaded(video)
        act(() => observerCallback([{ isIntersecting: true }]))
        expect(hlsState.instances).toHaveLength(1)
        const [first] = hlsState.instances
        expect(first.loadSource).toHaveBeenCalledWith(streams.landscape)
        expect(first.attachMedia).toHaveBeenCalledWith(video)
        expect(first.config).toMatchObject({ capLevelToPlayerSize: true, abrEwmaDefaultEstimate: 5e6 })
        expect(video.getAttribute('src')).toBeNull()
        act(() => video.dispatchEvent(new Event('playing')))
        expect(wrapper).toHaveClass('is-playing')

        // A narrower window that stays landscape keeps the same stream.
        sectionSize = { width: 900, height: 600 }
        act(() => window.dispatchEvent(new Event('resize')))
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        expect(hlsState.instances).toHaveLength(1)

        media(video, { paused: false, currentTime: 20 })
        sectionSize = { width: 390, height: 740 }
        act(() => window.dispatchEvent(new Event('resize')))
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        const second = hlsState.instances[1]
        expect(second.loadSource).toHaveBeenCalledWith(streams.portrait)
        expect(second.attachMedia).toHaveBeenCalledWith(spare)
        media(spare, { duration: 60, paused: false, currentTime: 20.05 })
        act(() => spare.dispatchEvent(new Event('loadedmetadata')))
        act(() => spare.dispatchEvent(new Event('seeked')))
        expect(spare).toHaveClass('is-active')
        expect(first.destroy).toHaveBeenCalled()
        expect(second.destroy).not.toHaveBeenCalled()

        // A fatal stream error stops the reel like a media error.
        act(() => second.handlers.hlsError(null, { fatal: false }))
        expect(second.destroy).not.toHaveBeenCalled()
        act(() => second.handlers.hlsError(null, { fatal: true }))
        expect(second.destroy).toHaveBeenCalled()
        expect(wrapper).not.toHaveClass('is-playing')
        // Errors from a stream already released are ignored.
        act(() => first.handlers.hlsError(null, { fatal: true }))
    })

    it('seeds the bandwidth guess from the reported downlink', async () => {
        vi.stubGlobal('navigator', { ...navigator, connection: { downlink: 10 } })
        fetchHeroReel.mockResolvedValue(adaptive)
        const { video } = mount()
        await loaded(video)
        act(() => observerCallback([{ isIntersecting: true }]))
        expect(hlsState.instances[0].config.abrEwmaDefaultEstimate).toBe(8e6)
    })

    it('lets Safari play adaptive cuts natively', async () => {
        vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe')
        fetchHeroReel.mockResolvedValue(adaptive)
        const { video } = mount()
        await loaded(video)
        act(() => observerCallback([{ isIntersecting: true }]))
        expect(video.getAttribute('src')).toBe(streams.landscape)
        expect(hlsState.instances).toHaveLength(0)
    })

    it('keeps the still image where adaptive cuts cannot play', async () => {
        hlsState.supported = false
        fetchHeroReel.mockResolvedValue(adaptive)
        const { video } = mount()
        await loaded(video)
        expect(observerCallback).toBeUndefined()
        expect(video.getAttribute('src')).toBeNull()
    })

    it('keeps the still image when no reel is published', async () => {
        fetchHeroReel.mockResolvedValue(null)
        const { video } = mount()
        await loaded(video)
        expect(observerCallback).toBeUndefined()
    })
})
