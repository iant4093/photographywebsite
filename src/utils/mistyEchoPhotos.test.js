import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadMistyEchoPhotos } from './mistyEchoPhotos'
import { fetchRandomPhotos } from './api'

vi.mock('./api', () => ({ fetchRandomPhotos: vi.fn() }))

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function mockImages(failed = []) {
    const requested = []
    vi.stubGlobal('Image', class {
        decode() { return Promise.resolve() }
        removeAttribute() {}
        set src(url) {
            requested.push(url)
            queueMicrotask(() => failed.includes(url) ? this.onerror?.() : this.onload?.())
        }
    })
    return requested
}

describe('Misty thumbnail loading', () => {
    it('requests only six Misty photos and never falls back to an original URL', async () => {
        const requested = mockImages()
        fetchRandomPhotos.mockResolvedValue({ images: [
            { thumbnailUrl: 'https://media.test/thumb.jpg', url: 'https://media.test/full.jpg' },
            { url: 'https://media.test/original-only.jpg' },
            { url: 'https://media.test/full2.jpg', thumbnailUrl: 'https://media.test/800.jpg', previewSrcSet: [640, 960, 1440, 1920].map(width => ({ width, url: `https://media.test/${width}.webp` })) },
            { thumbnailUrl: 'https://media.test/thumb.jpg' },
        ] })
        const signal = new AbortController().signal
        expect(await loadMistyEchoPhotos(signal)).toEqual(['https://media.test/thumb.jpg', 'https://media.test/640.webp'])
        expect(fetchRandomPhotos).toHaveBeenCalledWith({ category: 'Misty', limit: 6, priority: 'low', signal })
        expect(requested).toEqual(['https://media.test/thumb.jpg', 'https://media.test/640.webp'])
    })
    it('drops broken thumbnails and bounds downloads even if the server returns extras', async () => {
        const requested = mockImages(['https://media.test/0.jpg'])
        fetchRandomPhotos.mockResolvedValue({ images: Array.from({ length: 20 }, (_, i) => ({ thumbnailUrl: `https://media.test/${i}.jpg` })) })
        expect(await loadMistyEchoPhotos(new AbortController().signal)).toHaveLength(5)
        expect(requested).toHaveLength(6)
    })
    it('does not load images after cancellation', async () => {
        const requested = mockImages()
        fetchRandomPhotos.mockResolvedValue({ images: [{ thumbnailUrl: 'https://media.test/thumb.jpg' }] })
        const controller = new AbortController()
        controller.abort()
        expect(await loadMistyEchoPhotos(controller.signal)).toEqual([])
        expect(requested).toEqual([])
    })
    it('cancels stalled images and times out without fetching originals', async () => {
        vi.useFakeTimers()
        const remove = vi.fn()
        vi.stubGlobal('Image', class { removeAttribute = remove })
        fetchRandomPhotos.mockResolvedValue({ images: [{ thumbnailUrl: 'https://media.test/thumb.jpg', url: 'https://media.test/original.jpg' }] })
        const controller = new AbortController()
        const request = loadMistyEchoPhotos(controller.signal)
        await vi.advanceTimersByTimeAsync(3501)
        expect(await request).toEqual([])
        expect(remove).toHaveBeenCalledWith('src')
    })
})
