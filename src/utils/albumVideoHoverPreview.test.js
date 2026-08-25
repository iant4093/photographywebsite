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
    })

    it('starts at the saved cover frame, hides the poster only after play, then resets', async () => {
        const container = document.createElement('div')
        const onPlaybackStart = vi.fn()
        const onPlaybackEnd = vi.fn()
        const controller = start({
            container,
            album: { coverThumbnailUrl: 'https://media.test/thumb/cover.jpg' },
            loadDetail: vi.fn().mockResolvedValue({
                images: [{
                    thumbnailUrl: 'https://media.test/thumb/cover.jpg',
                    hlsUrl: 'https://media.test/hls/cover.m3u8',
                    thumbnailTime: 5,
                }],
            }),
            onPlaybackStart,
            onPlaybackEnd,
        })

        await vi.advanceTimersByTimeAsync(VIDEO_HOVER_DELAY_MS)
        const video = container.querySelector('video')
        expect(video).toBeTruthy()
        expect(video).toHaveAttribute('muted')
        Object.defineProperty(video, 'duration', { configurable: true, value: 30 })
        video.dispatchEvent(new Event('loadedmetadata'))
        expect(video.currentTime).toBe(5)
        expect(onPlaybackStart).not.toHaveBeenCalled()
        video.dispatchEvent(new Event('seeked'))
        await Promise.resolve()
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
})
