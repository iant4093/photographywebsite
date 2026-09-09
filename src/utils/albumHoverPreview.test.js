import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    ALBUM_HOVER_PREVIEW_LIMIT,
    canRunAlbumHoverPreview,
    selectAlbumHoverPreviews,
    start,
} from './albumHoverPreview'
import { MOBILE_PREVIEW_QUERY } from './albumPreviewPolicy'

const previews = (name) => [640, 960, 1440, 1920]
    .map((width) => ({ width, url: `https://media.example.test/${name}-${width}.webp` }))

describe('album hover preview selection', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('cancels a photo preview before loading when its row scrolls', async () => {
        vi.useFakeTimers()
        vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('hover: hover') }))
        const container = document.createElement('div')
        document.body.append(container)
        const loadManifest = vi.fn()
        const controller = start({ container, loadManifest })
        try {
            container.dispatchEvent(new Event('scroll'))
            await vi.advanceTimersByTimeAsync(1000)
            expect(loadManifest).not.toHaveBeenCalled()
        } finally {
            controller.stop()
            container.remove()
            vi.useRealTimers()
        }
    })

    it('uses only landscape images with complete 640px previews, excludes the cover, removes duplicates, and caps the sequence', () => {
        const cover = 'https://media.example.test/full/cover.jpg?version=1'
        const images = [
            { url: 'https://media.example.test/full/cover.jpg', width: 1800, height: 1200, previewSrcSet: previews('cover') },
            ...Array.from({ length: 7 }, (_, index) => ({
                url: `https://media.example.test/full/${index}.jpg`,
                width: 1800,
                height: 1200,
                previewSrcSet: previews(String(index)),
            })),
            { url: 'https://media.example.test/full/portrait.jpg', width: 1200, height: 1800, previewSrcSet: previews('portrait') },
            { url: 'https://media.example.test/full/square.jpg', width: 1200, height: 1200, previewSrcSet: previews('square') },
            { url: 'https://media.example.test/full/unknown.jpg', previewSrcSet: previews('unknown') },
            { url: 'https://media.example.test/full/incomplete.jpg', width: 1800, height: 1200, previewSrcSet: previews('bad').slice(0, 2) },
            { url: 'https://media.example.test/full/duplicate.jpg', width: 1800, height: 1200, previewSrcSet: previews('0') },
        ]

        const selected = selectAlbumHoverPreviews({ images }, cover, () => 0.5)
        expect(selected).toHaveLength(ALBUM_HOVER_PREVIEW_LIMIT)
        expect(new Set(selected.map(({ url }) => url))).toHaveLength(ALBUM_HOVER_PREVIEW_LIMIT)
        expect(selected.every(({ url }) => /-640\.webp$/.test(url))).toBe(true)
        expect(selected.some(({ url }) => url.includes('cover-640'))).toBe(false)
        expect(selected.some(({ url }) => url.includes('bad-640'))).toBe(false)
        expect(selected.some(({ url }) => /portrait|square|unknown/.test(url))).toBe(false)
    })

    it('requires a fine hover pointer and honors reduced-motion preferences', () => {
        vi.stubGlobal('matchMedia', vi.fn((query) => ({
            matches: query.includes('hover: hover'),
            media: query,
        })))
        expect(canRunAlbumHoverPreview()).toBe(true)

        window.matchMedia.mockImplementation((query) => ({
            matches: query.includes('prefers-reduced-motion'),
            media: query,
        }))
        expect(canRunAlbumHoverPreview()).toBe(false)
    })

    it('shuffles already validated manifest frames without requiring responsive metadata', () => {
        const manifest = {
            schemaVersion: 1,
            version: 'a'.repeat(24),
            images: [
                { url: 'https://media.example.test/one-w640.webp', width: 640, height: 427 },
                { url: 'https://media.example.test/two-w640.webp', width: 640, height: 427 },
            ],
        }
        expect(selectAlbumHoverPreviews(manifest, '', () => 0)).toEqual([
            { url: 'https://media.example.test/two-w640.webp' },
            { url: 'https://media.example.test/one-w640.webp' },
        ])
    })

    it('plays a finite mobile photo sequence without fetching full album details and releases every frame', async () => {
        vi.useFakeTimers()
        vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === MOBILE_PREVIEW_QUERY }))
        vi.stubGlobal('Image', class {
            constructor() {
                const image = document.createElement('img')
                image.decode = () => Promise.resolve()
                return image
            }
        })
        const container = document.createElement('div')
        const loadDetail = vi.fn()
        const loadManifest = vi.fn().mockResolvedValue({
            schemaVersion: 1, version: 'a'.repeat(24),
            images: [1, 2, 3, 4, 5].map(id => ({ url: `https://media.test/${id}.webp`, width: 640, height: 427 })),
        })
        const controller = start({ container, loadManifest, loadDetail, trigger: 'focus' })
        try {
            await vi.advanceTimersByTimeAsync(16)
            expect(container.querySelectorAll('.album-card-photo-preview')).toHaveLength(1)
            for (let step = 0; step < 90; step++) {
                await vi.advanceTimersByTimeAsync(100)
                expect(container.querySelectorAll('img').length).toBeLessThanOrEqual(2)
            }
            expect(container.querySelector('img')).toBeNull()
            expect(loadManifest).toHaveBeenCalledOnce()
            expect(loadDetail).not.toHaveBeenCalled()
            expect(vi.getTimerCount()).toBe(0)
        } finally { controller.stop(); vi.useRealTimers() }
    })

    it.each(['mobile', 'cancelled'])('does not fall back to a full album after a %s manifest miss', async reason => {
        vi.useFakeTimers()
        vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: reason === 'mobile'
            ? query === MOBILE_PREVIEW_QUERY : query.includes('hover: hover') }))
        let resolve
        const loadManifest = () => new Promise(done => { resolve = done })
        const loadDetail = vi.fn()
        const controller = start({ container: document.createElement('div'), loadManifest, loadDetail,
            trigger: reason === 'mobile' ? 'focus' : 'hover' })
        try {
            await vi.advanceTimersByTimeAsync(650)
            if (reason === 'cancelled') controller.stop()
            resolve(null)
            await vi.advanceTimersByTimeAsync(100)
            expect(loadDetail).not.toHaveBeenCalled()
        } finally { controller.stop(); vi.useRealTimers() }
    })
})
