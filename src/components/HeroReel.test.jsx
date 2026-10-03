import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/heroReel', async (importOriginal) => ({
    ...(await importOriginal()),
    fetchHeroReel: vi.fn(),
}))

import { fetchHeroReel } from '../utils/heroReel'
import HeroReel, { HERO_REEL_UNLOAD_MS } from './HeroReel'

const reel = {
    version: 'a'.repeat(24),
    renditions: [
        { width: 1920, height: 1080, url: 'https://media.example/reel-1920x1080.mp4' },
        { width: 1280, height: 720, url: 'https://media.example/reel-1280x720.mp4' },
        { width: 608, height: 1080, url: 'https://media.example/reel-608x1080.mp4' },
    ],
}

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
    return { ...view, video: view.container.querySelector('video') }
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
        const { video } = mount()
        expect(video).toBeNull()
        await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
        expect(fetchHeroReel).not.toHaveBeenCalled()
    })

    it('loads after the page settles, plays muted only while visible, and fades in once playing', async () => {
        const { video } = mount()
        expect(video).toHaveAttribute('preload', 'none')
        expect(video).toHaveAttribute('aria-hidden', 'true')
        expect(video.getAttribute('src')).toBeNull()
        await loaded(video)
        expect(video.muted).toBe(true)
        expect(video).toHaveAttribute('playsinline')
        expect(video.getAttribute('src')).toBeNull()

        act(() => observerCallback([{ isIntersecting: true }]))
        expect(video.getAttribute('src')).toBe('https://media.example/reel-1280x720.mp4')
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
        expect(video).not.toHaveClass('is-playing')
        act(() => video.dispatchEvent(new Event('playing')))
        expect(video).toHaveClass('is-playing')

        act(() => observerCallback([{ isIntersecting: false }]))
        expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
        expect(video.getAttribute('src')).not.toBeNull()
        act(() => observerCallback([{ isIntersecting: true }]))
        await act(async () => { await vi.advanceTimersByTimeAsync(HERO_REEL_UNLOAD_MS + 10) })
        expect(video.getAttribute('src')).not.toBeNull()

        act(() => observerCallback([{ isIntersecting: false }]))
        await act(async () => { await vi.advanceTimersByTimeAsync(HERO_REEL_UNLOAD_MS + 10) })
        expect(video.getAttribute('src')).toBeNull()
        expect(video).not.toHaveClass('is-playing')
        expect(HTMLMediaElement.prototype.load).toHaveBeenCalled()

        act(() => observerCallback([{ isIntersecting: true }]))
        expect(video.getAttribute('src')).toBe('https://media.example/reel-1280x720.mp4')
    })

    it('uses the portrait cut on phones and swaps when the hero changes shape', async () => {
        sectionSize = { width: 390, height: 740 }
        window.devicePixelRatio = 3
        const { video } = mount()
        await loaded(video)
        act(() => observerCallback([{ isIntersecting: true }]))
        expect(video.getAttribute('src')).toBe('https://media.example/reel-608x1080.mp4')

        sectionSize = { width: 900, height: 600 }
        act(() => window.dispatchEvent(new Event('resize')))
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        expect(video.getAttribute('src')).toBe('https://media.example/reel-1920x1080.mp4')
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

    it('keeps the still image when no reel is published', async () => {
        fetchHeroReel.mockResolvedValue(null)
        const { video } = mount()
        await loaded(video)
        expect(observerCallback).toBeUndefined()
    })
})
