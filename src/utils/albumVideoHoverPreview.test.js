import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    VIDEO_HOVER_DELAY_MS,
    VIDEO_HOVER_DURATION_MS,
    selectAlbumCoverVideo,
    start,
} from './albumVideoHoverPreview'

describe('video album hover previews', () => {
    beforeEach(() => {
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
})
