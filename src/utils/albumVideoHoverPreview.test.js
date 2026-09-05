import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hlsInstances = vi.hoisted(() => [])
vi.mock('hls.js', () => ({
    default: class Hls {
        static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifestParsed' }
        static isSupported = () => true
        constructor(config) {
            this.config = config
            this.handlers = {}
            this.loadSource = vi.fn()
            this.attachMedia = vi.fn()
            this.destroy = vi.fn()
            hlsInstances.push(this)
        }
        on(event, callback) { this.handlers[event] = callback }
    },
}))

import {
    VIDEO_HOVER_DELAY_MS,
    VIDEO_HOVER_DURATION_MS,
    VIDEO_HOVER_MAX_PLAY_ATTEMPTS,
    selectAlbumCoverVideo,
    start,
} from './albumVideoHoverPreview'

describe('video album hover previews', () => {
    beforeEach(() => {
        hlsInstances.length = 0
        vi.useFakeTimers()
        window.matchMedia = vi.fn((query) => ({
            matches: query.includes('(hover: hover)'),
        }))
        vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe')
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
        vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            callback(0)
            return 1
        })
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('selects the exact cover video and requires its lighter HLS rendition', () => {
        const detail = {
            images: [
                { url: 'https://media.test/raw/first.mp4', thumbnailUrl: 'https://media.test/thumb/first.jpg', hlsUrl: 'https://media.test/hls/first.m3u8', thumbnailTime: 1 },
                { url: 'https://media.test/raw/cover.mp4', thumbnailUrl: 'https://media.test/thumb/cover.jpg', hlsUrl: 'https://media.test/hls/cover.m3u8', thumbnailTime: 5 },
            ],
        }
        expect(selectAlbumCoverVideo(detail, {
            coverImageUrl: 'https://media.test/raw/cover.mp4',
            coverThumbnailUrl: 'https://media.test/thumb/cover.jpg',
        })).toEqual({ hlsUrl: 'https://media.test/hls/cover.m3u8', startTime: 5 })
        expect(selectAlbumCoverVideo({ images: [{ ...detail.images[1], hlsUrl: '' }] }, {
            coverThumbnailUrl: 'https://media.test/thumb/cover.jpg',
        })).toBeNull()
        expect(selectAlbumCoverVideo(null, {
            coverHlsUrl: 'https://media.test/hls/summary.m3u8',
            coverThumbnailTime: 7,
        })).toEqual({ hlsUrl: 'https://media.test/hls/summary.m3u8', startTime: 7 })
    })

    it.each(['native', 'HLS.js'])('does not allocate streams while rapidly crossing cards with %s', async (runtime) => {
        HTMLMediaElement.prototype.canPlayType.mockReturnValue(runtime === 'native' ? 'maybe' : '')
        const firstContainer = document.createElement('div')
        const secondContainer = document.createElement('div')
        const createElement = vi.spyOn(document, 'createElement')
        const loadDetail = vi.fn().mockResolvedValue({
            images: [{ hlsUrl: 'https://media.test/hls/cover.m3u8' }],
        })
        const begin = (container) => start({ container, album: {}, loadDetail })

        const firstPass = begin(firstContainer)
        await vi.advanceTimersByTimeAsync(100)
        firstPass.stop()
        const secondPass = begin(secondContainer)
        await vi.advanceTimersByTimeAsync(100)
        secondPass.stop()
        const finalHover = begin(firstContainer)
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS - 1)
        await vi.dynamicImportSettled()

        expect(createElement.mock.calls.filter(([tag]) => tag === 'video')).toHaveLength(0)
        expect(loadDetail).not.toHaveBeenCalled()
        expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled()
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
        expect(hlsInstances).toHaveLength(0)

        await vi.advanceTimersByTimeAsync(1)
        await vi.dynamicImportSettled()
        expect(createElement.mock.calls.filter(([tag]) => tag === 'video')).toHaveLength(1)
        expect(loadDetail).toHaveBeenCalledOnce()
        expect(secondContainer.querySelector('video')).toBeNull()
        const video = firstContainer.querySelector('video')
        if (runtime === 'HLS.js') {
            expect(hlsInstances).toHaveLength(1)
            expect(hlsInstances[0].loadSource).toHaveBeenCalledWith('https://media.test/hls/cover.m3u8')
            expect(hlsInstances[0].attachMedia).toHaveBeenCalledWith(video)
            hlsInstances[0].handlers.manifestParsed()
            await Promise.resolve()
        } else {
            expect(video.src).toBe('https://media.test/hls/cover.m3u8')
        }
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
        expect(video.style.opacity).toBe('1')
        finalHover.stop()
    })

    it('starts a cold stream without waiting for seeked, then resets', async () => {
        const container = document.createElement('div')
        const onPlaybackStart = vi.fn()
        const onPlaybackEnd = vi.fn()
        const loadDetail = vi.fn().mockResolvedValue({
            images: [{
                thumbnailUrl: 'https://media.test/thumb/cover.jpg',
                hlsUrl: 'https://media.test/hls/cover.m3u8',
                thumbnailTime: 5,
            }],
        })
        const controller = start({
            container,
            album: { coverThumbnailUrl: 'https://media.test/thumb/cover.jpg' },
            loadDetail,
            onPlaybackStart,
            onPlaybackEnd,
        })

        expect(container.querySelector('video')).toBeNull()
        expect(loadDetail).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        expect(loadDetail).toHaveBeenCalledOnce()
        const video = container.querySelector('video')
        expect(video).toBeTruthy()
        expect(video.preload).toBe('auto')
        expect(video).toHaveAttribute('muted')
        Object.defineProperty(video, 'duration', { configurable: true, value: 30 })
        video.dispatchEvent(new Event('loadedmetadata'))
        expect(video.currentTime).toBe(5)
        expect(video.play).toHaveBeenCalledOnce()
        expect(onPlaybackStart).toHaveBeenCalledOnce()
        expect(video.style.opacity).toBe('1')

        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DURATION_MS)
        expect(container.querySelector('video')).toBeNull()
        expect(onPlaybackEnd).toHaveBeenCalledOnce()
        controller.stop()
        expect(onPlaybackEnd).toHaveBeenCalledOnce()
    })

    it('uses catalog cover playback data without fetching album detail', async () => {
        const container = document.createElement('div')
        const loadDetail = vi.fn()
        start({
            container,
            album: {
                coverHlsUrl: 'https://media.test/hls/summary.m3u8',
                coverThumbnailTime: 3,
            },
            loadDetail,
        })

        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        expect(loadDetail).not.toHaveBeenCalled()
        expect(container.querySelector('video')?.src).toBe('https://media.test/hls/summary.m3u8')
    })

    it('requests native playback before cold-stream metadata arrives', async () => {
        const container = document.createElement('div')
        const onPlaybackStart = vi.fn()
        let resolvePlayback
        HTMLMediaElement.prototype.play.mockImplementationOnce(() => new Promise((resolve) => {
            resolvePlayback = resolve
        }))
        const controller = start({
            container,
            album: { coverHlsUrl: 'https://media.test/hls/cover.m3u8', coverThumbnailTime: 5 },
            loadDetail: vi.fn(),
            onPlaybackStart,
        })
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        const video = container.querySelector('video')
        expect(video.play).toHaveBeenCalledOnce()
        expect(onPlaybackStart).not.toHaveBeenCalled()
        expect(video.style.opacity).toBe('0')

        video.dispatchEvent(new Event('canplay'))
        video.dispatchEvent(new Event('seeked'))
        await vi.advanceTimersByTimeAsync(1000)
        expect(video.play).toHaveBeenCalledOnce()

        Object.defineProperty(video, 'duration', { configurable: true, value: 30 })
        video.dispatchEvent(new Event('loadedmetadata'))
        expect(video.currentTime).toBe(5)
        resolvePlayback()
        await Promise.resolve()
        expect(onPlaybackStart).toHaveBeenCalledOnce()
        controller.stop()
    })

    it.each([
        ['native', 'resolve'],
        ['native', 'reject'],
        ['HLS.js', 'resolve'],
        ['HLS.js', 'reject'],
    ])('ignores old %s play promises that %s after rapidly returning to a card', async (runtime, settlement) => {
        HTMLMediaElement.prototype.canPlayType.mockReturnValue(runtime === 'native' ? 'maybe' : '')
        const pending = []
        const pendingPlayback = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
        HTMLMediaElement.prototype.play
            .mockImplementationOnce(pendingPlayback)
            .mockImplementationOnce(pendingPlayback)
        const firstContainer = document.createElement('div')
        const secondContainer = document.createElement('div')
        const oldStarted = vi.fn()
        const oldEnded = vi.fn()
        const finalStarted = vi.fn()
        const finalEnded = vi.fn()
        const begin = (container, onPlaybackStart, onPlaybackEnd) => start({
            container,
            album: { coverHlsUrl: 'https://media.test/hls/cover.m3u8' },
            loadDetail: vi.fn(),
            onPlaybackStart,
            onPlaybackEnd,
        })
        const reachPlayback = async () => {
            await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
            if (runtime === 'HLS.js') {
                await vi.dynamicImportSettled()
                hlsInstances.at(-1).handlers.manifestParsed()
                await Promise.resolve()
            }
        }

        const firstHover = begin(firstContainer, oldStarted, oldEnded)
        await reachPlayback()
        const firstVideo = firstContainer.querySelector('video')
        firstHover.stop()
        const secondHover = begin(secondContainer, oldStarted, oldEnded)
        await reachPlayback()
        const secondVideo = secondContainer.querySelector('video')
        secondHover.stop()
        const finalHover = begin(firstContainer, finalStarted, finalEnded)
        await reachPlayback()
        const finalVideo = firstContainer.querySelector('video')
        expect(finalStarted).toHaveBeenCalledOnce()
        expect(finalVideo.style.opacity).toBe('1')

        for (const playback of pending.reverse()) {
            if (settlement === 'resolve') playback.resolve()
            else playback.reject(new DOMException('Old playback interrupted', 'AbortError'))
        }
        firstVideo.dispatchEvent(new Event('canplay'))
        secondVideo.dispatchEvent(new Event('seeked'))
        await vi.advanceTimersByTimeAsync(1000)

        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(3)
        expect(firstContainer.querySelector('video')).toBe(finalVideo)
        expect(secondContainer.querySelector('video')).toBeNull()
        expect(finalVideo.style.opacity).toBe('1')
        expect(oldStarted).not.toHaveBeenCalled()
        expect(oldEnded).not.toHaveBeenCalled()
        expect(finalStarted).toHaveBeenCalledOnce()
        expect(finalEnded).not.toHaveBeenCalled()
        if (runtime === 'HLS.js') {
            expect(hlsInstances).toHaveLength(3)
            expect(hlsInstances[0].destroy).toHaveBeenCalledOnce()
            expect(hlsInstances[1].destroy).toHaveBeenCalledOnce()
            expect(hlsInstances[2].destroy).not.toHaveBeenCalled()
        }
        finalHover.stop()
    })

    it('starts HLS.js playback when its manifest arrives after the hover delay', async () => {
        HTMLMediaElement.prototype.canPlayType.mockReturnValue('')
        const container = document.createElement('div')
        const onPlaybackStart = vi.fn()
        const controller = start({
            container,
            album: { coverHlsUrl: 'https://media.test/hls/cover.m3u8', coverThumbnailTime: 5 },
            loadDetail: vi.fn(),
            onPlaybackStart,
        })
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        await vi.dynamicImportSettled()
        const instance = hlsInstances[0]
        const video = container.querySelector('video')
        expect(instance.config.startPosition).toBe(5)
        expect(instance.attachMedia).toHaveBeenCalledWith(video)

        expect(video.play).not.toHaveBeenCalled()
        instance.handlers.manifestParsed()
        await Promise.resolve()
        expect(video.play).toHaveBeenCalledOnce()
        expect(onPlaybackStart).toHaveBeenCalledOnce()
        controller.stop()
        expect(instance.destroy).toHaveBeenCalledOnce()
    })

    it('retries an interrupted play without requiring another hover', async () => {
        HTMLMediaElement.prototype.play.mockRejectedValueOnce(new DOMException('Playback interrupted', 'AbortError'))
        const container = document.createElement('div')
        const onPlaybackStart = vi.fn()
        const controller = start({
            container,
            album: { coverHlsUrl: 'https://media.test/hls/cover.m3u8' },
            loadDetail: vi.fn(),
            onPlaybackStart,
        })
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS + 150)
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
        expect(onPlaybackStart).toHaveBeenCalledOnce()
        expect(container.querySelector('video')?.style.opacity).toBe('1')
        controller.stop()
    })

    it('uses media readiness to recover from two startup interruptions without another hover', async () => {
        HTMLMediaElement.prototype.play
            .mockRejectedValueOnce(new DOMException('Source interrupted', 'AbortError'))
            .mockRejectedValueOnce(new DOMException('Seek interrupted', 'AbortError'))
        let resolvePlayback
        HTMLMediaElement.prototype.play.mockImplementationOnce(() => new Promise((resolve) => {
            resolvePlayback = resolve
        }))
        const container = document.createElement('div')
        const onPlaybackStart = vi.fn()
        const controller = start({
            container,
            album: { coverHlsUrl: 'https://media.test/hls/cover.m3u8' },
            loadDetail: vi.fn(),
            onPlaybackStart,
        })
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        const video = container.querySelector('video')
        expect(video.play).toHaveBeenCalledOnce()

        video.dispatchEvent(new Event('canplay'))
        await Promise.resolve()
        expect(video.play).toHaveBeenCalledTimes(2)
        video.dispatchEvent(new Event('seeked'))
        await Promise.resolve()
        expect(video.play).toHaveBeenCalledTimes(3)
        expect(onPlaybackStart).not.toHaveBeenCalled()

        video.dispatchEvent(new Event('canplay'))
        video.dispatchEvent(new Event('seeked'))
        await vi.advanceTimersByTimeAsync(1000)
        expect(video.play).toHaveBeenCalledTimes(3)
        resolvePlayback()
        await Promise.resolve()
        expect(onPlaybackStart).toHaveBeenCalledOnce()
        expect(video.style.opacity).toBe('1')

        video.dispatchEvent(new Event('canplay'))
        video.dispatchEvent(new Event('seeked'))
        await vi.advanceTimersByTimeAsync(1000)
        expect(video.play).toHaveBeenCalledTimes(3)
        expect(onPlaybackStart).toHaveBeenCalledOnce()
        controller.stop()
    })

    it('caps interrupted playback retries while the pointer stays hovered', async () => {
        HTMLMediaElement.prototype.play.mockRejectedValue(new DOMException('Playback interrupted', 'AbortError'))
        const container = document.createElement('div')
        start({
            container,
            album: { coverHlsUrl: 'https://media.test/hls/cover.m3u8' },
            loadDetail: vi.fn(),
        })
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS + 150)
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(300)
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(3)
        await vi.advanceTimersByTimeAsync(450)
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(VIDEO_HOVER_MAX_PLAY_ATTEMPTS)
        expect(container.querySelector('video')).toBeNull()
        await vi.advanceTimersByTimeAsync(1000)
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(VIDEO_HOVER_MAX_PLAY_ATTEMPTS)
    })

    it('does not retry a browser autoplay-policy denial', async () => {
        HTMLMediaElement.prototype.play.mockRejectedValueOnce(new DOMException('Autoplay denied', 'NotAllowedError'))
        const container = document.createElement('div')
        start({
            container,
            album: { coverHlsUrl: 'https://media.test/hls/cover.m3u8' },
            loadDetail: vi.fn(),
        })
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS + 500)
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
        expect(container.querySelector('video')).toBeNull()
    })

    it('cancels a pending play retry when the pointer leaves', async () => {
        HTMLMediaElement.prototype.play.mockRejectedValueOnce(new DOMException('Playback interrupted', 'AbortError'))
        const container = document.createElement('div')
        const controller = start({
            container,
            album: { coverHlsUrl: 'https://media.test/hls/cover.m3u8' },
            loadDetail: vi.fn(),
        })
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        const video = container.querySelector('video')
        controller.stop()
        video.dispatchEvent(new Event('canplay'))
        video.dispatchEvent(new Event('seeked'))
        await vi.advanceTimersByTimeAsync(500)
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
        expect(container.querySelector('video')).toBeNull()
    })

    it('does not start after the pointer leaves while album detail is pending', async () => {
        let resolveDetail
        const container = document.createElement('div')
        const controller = start({
            container,
            album: {},
            loadDetail: () => new Promise((resolve) => { resolveDetail = resolve }),
        })
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        controller.stop()
        resolveDetail({ images: [{ hlsUrl: 'https://media.test/hls/cover.m3u8' }] })
        await Promise.resolve()
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
        expect(container.querySelector('video')).toBeNull()
    })

    it('restores the play overlay when a stream fails during playback', async () => {
        const container = document.createElement('div')
        const onPlaybackEnd = vi.fn()
        start({
            container,
            album: { coverHlsUrl: 'https://media.test/hls/cover.m3u8' },
            loadDetail: vi.fn(),
            onPlaybackEnd,
        })
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        container.querySelector('video').dispatchEvent(new Event('error'))
        expect(onPlaybackEnd).toHaveBeenCalledOnce()
        expect(container.querySelector('video')).toBeNull()
    })
})
