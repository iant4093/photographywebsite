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

        await Promise.resolve()
        await Promise.resolve()
        expect(loadDetail).toHaveBeenCalledOnce()
        const video = container.querySelector('video')
        expect(video).toBeTruthy()
        expect(video.preload).toBe('auto')
        expect(video).toHaveAttribute('muted')
        Object.defineProperty(video, 'duration', { configurable: true, value: 30 })
        video.dispatchEvent(new Event('loadedmetadata'))
        expect(video.currentTime).toBe(5)
        expect(onPlaybackStart).not.toHaveBeenCalled()
        expect(video.play).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        await Promise.resolve()
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

        await Promise.resolve()
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
        const video = container.querySelector('video')

        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        expect(video.play).toHaveBeenCalledOnce()
        expect(onPlaybackStart).not.toHaveBeenCalled()
        expect(video.style.opacity).toBe('0')

        Object.defineProperty(video, 'duration', { configurable: true, value: 30 })
        video.dispatchEvent(new Event('loadedmetadata'))
        expect(video.currentTime).toBe(5)
        resolvePlayback()
        await Promise.resolve()
        expect(onPlaybackStart).toHaveBeenCalledOnce()
        controller.stop()
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
        await vi.dynamicImportSettled()
        const instance = hlsInstances[0]
        const video = container.querySelector('video')
        expect(instance.config.startPosition).toBe(5)
        expect(instance.attachMedia).toHaveBeenCalledWith(video)

        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        expect(video.play).not.toHaveBeenCalled()
        instance.handlers.manifestParsed()
        await Promise.resolve()
        expect(video.play).toHaveBeenCalledOnce()
        expect(onPlaybackStart).toHaveBeenCalledOnce()
        controller.stop()
        expect(instance.destroy).toHaveBeenCalledOnce()
    })

    it('retries an interrupted play once without requiring another hover', async () => {
        HTMLMediaElement.prototype.play.mockRejectedValueOnce(new DOMException('Playback interrupted', 'AbortError'))
        const container = document.createElement('div')
        const onPlaybackStart = vi.fn()
        const controller = start({
            container,
            album: { coverHlsUrl: 'https://media.test/hls/cover.m3u8' },
            loadDetail: vi.fn(),
            onPlaybackStart,
        })
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS + 100)
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
        expect(onPlaybackStart).toHaveBeenCalledOnce()
        expect(container.querySelector('video')?.style.opacity).toBe('1')
        controller.stop()
    })

    it('stops retrying an interrupted play after one retry', async () => {
        HTMLMediaElement.prototype.play.mockRejectedValue(new DOMException('Playback interrupted', 'AbortError'))
        const container = document.createElement('div')
        start({
            container,
            album: { coverHlsUrl: 'https://media.test/hls/cover.m3u8' },
            loadDetail: vi.fn(),
        })
        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS + 500)
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
        expect(container.querySelector('video')).toBeNull()
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
        controller.stop()
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
