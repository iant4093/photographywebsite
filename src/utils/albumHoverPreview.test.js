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

    it.each([[640, 427, 2], [1920, 1280, 5]])('reuses small decoded frames but bounds larger frames (%i x %i)', async (width, height, expectedLoads) => {
        vi.useFakeTimers()
        vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('hover: hover') }))
        const loaded = []
        vi.stubGlobal('Image', class {
            constructor() {
                const image = document.createElement('img')
                Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } })
                image.decode = () => Promise.resolve()
                loaded.push(image)
                return image
            }
        })
        const container = document.createElement('div')
        const loadManifest = vi.fn().mockResolvedValue({ schemaVersion: 1, version: 'cached',
            images: [1, 2].map(id => ({ url: `https://media.example.test/${id}.webp`, width: 640, height: 427 })),
        })
        const controller = start({ container, loadManifest })
        try {
            await vi.advanceTimersByTimeAsync(10000)
            expect(loaded).toHaveLength(expectedLoads)
            expect(container.querySelectorAll('img').length).toBeLessThanOrEqual(2)
            expect(container.querySelector('img').style.opacity).toBe('1')
            controller.stop()
            expect(container.querySelector('img')).toBeNull()
            expect(vi.getTimerCount()).toBe(0)
            const restarted = start({ container, loadManifest })
            await vi.advanceTimersByTimeAsync(700)
            expect(loaded).toHaveLength(expectedLoads + 1)
            restarted.stop()
        } finally { controller.stop(); vi.useRealTimers() }
    })

    it('keeps the surviving reused frame visible when all other frames fail', async () => {
        vi.useFakeTimers()
        vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('hover: hover') }))
        const loaded = []
        vi.stubGlobal('Image', class {
            constructor() {
                const image = document.createElement('img')
                Object.defineProperties(image, { naturalWidth: { value: 640 }, naturalHeight: { value: 427 }, src: {
                    set(url) {
                        image.setAttribute('src', url)
                        loaded.push(url)
                        queueMicrotask(() => url.includes('bad') ? image.onerror?.() : image.onload?.())
                    },
                } })
                return image
            }
        })
        const container = document.createElement('div')
        const controller = start({ container, loadManifest: async () => ({ schemaVersion: 1, version: 'one-good',
            images: ['good', 'bad'].map(id => ({ url: `https://media.example.test/${id}.webp`, width: 640, height: 427 })),
        }) })
        try {
            await vi.advanceTimersByTimeAsync(10000)
            expect(loaded).toHaveLength(2)
            expect(container.querySelectorAll('img')).toHaveLength(1)
            expect(container.querySelector('img')).toHaveAttribute('src', 'https://media.example.test/good.webp')
            expect(container.querySelector('img').style.opacity).toBe('1')
        } finally { controller.stop(); vi.useRealTimers() }
    })

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

    it.each([[320, 640], [640, 640], [641, 960], [961, 1440], [1441, 1920], [4000, 1920]])('selects an available variant for %ipx, capped at the largest preview', (target, expected) => {
        const images = [{ width: 1800, height: 1200, previewSrcSet: previews('landscape') }]
        const [frame] = selectAlbumHoverPreviews({ images }, '', () => 0, target)
        expect(frame.url).toBe(`https://media.example.test/landscape-${expected}.webp`)
        expect(frame.fallbackUrl).toBe(expected > 640 ? 'https://media.example.test/landscape-640.webp' : undefined)
    })

    it.each([false, true])('loads one responsive frame at a time and handles a failed larger image (cancelled=%s)', async cancelled => {
        vi.useFakeTimers()
        vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('hover: hover') }))
        vi.stubGlobal('devicePixelRatio', 2)
        const requests = []
        let failFirst
        vi.stubGlobal('Image', class {
            constructor() {
                const image = document.createElement('img')
                Object.defineProperty(image, 'src', { set(url) {
                    image.setAttribute('src', url)
                    requests.push(url)
                    if (requests.length === 1) failFirst = () => image.onerror?.()
                    else queueMicrotask(() => /-640\.webp$/.test(url) ? image.onload?.() : image.onerror?.())
                } })
                return image
            }
        })
        const container = document.createElement('div')
        Object.defineProperty(container, 'clientWidth', { value: 505 })
        const loadDetail = vi.fn()
        const loadManifest = vi.fn().mockResolvedValue({ schemaVersion: 1, version: 'a'.repeat(24),
            images: [1, 2].map(id => ({ url: `https://media.example.test/${id}-640.webp`, width: 640, height: 427, previewSrcSet: previews(id) })),
        })
        const controller = start({ container, loadManifest, loadDetail, responsive: true })
        try {
            await vi.advanceTimersByTimeAsync(649)
            expect(requests).toEqual([])
            await vi.advanceTimersByTimeAsync(1)
            expect(requests).toHaveLength(1)
            expect(requests[0]).toMatch(/-1440\.webp$/)
            if (cancelled) controller.stop()
            failFirst()
            await vi.advanceTimersByTimeAsync(16)
            if (cancelled) {
                expect(requests).toHaveLength(1)
                expect(container.querySelector('img')).toBeNull()
            } else {
                expect(requests).toHaveLength(2)
                expect(container.querySelector('img')).toHaveAttribute('src', requests[0].replace('-1440.webp', '-640.webp'))
                await vi.advanceTimersByTimeAsync(2 * (2200 + 16))
                expect(requests.filter(url => url.endsWith('-1440.webp'))).toHaveLength(2)
                expect(requests.filter(url => url.endsWith('-640.webp'))).toHaveLength(3)
                expect(container.querySelectorAll('img').length).toBeLessThanOrEqual(2)
            }
            expect(loadDetail).not.toHaveBeenCalled()
        } finally { controller.stop(); vi.useRealTimers() }
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

    it.each([[false, 640], [true, 1440]])('plays a finite mobile sequence (responsive=%s) without full album details and releases every frame', async (responsive, expectedWidth) => {
        vi.useFakeTimers()
        vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === MOBILE_PREVIEW_QUERY }))
        vi.stubGlobal('devicePixelRatio', 3)
        vi.stubGlobal('Image', class {
            constructor() {
                const image = document.createElement('img')
                image.decode = () => Promise.resolve()
                return image
            }
        })
        const container = document.createElement('div')
        Object.defineProperty(container, 'clientWidth', { value: 325 })
        const loadDetail = vi.fn()
        const loadManifest = vi.fn().mockResolvedValue({
            schemaVersion: 1, version: 'a'.repeat(24),
            images: [1, 2, 3, 4, 5].map(id => ({ url: previews(id)[0].url, width: 640, height: 427, previewSrcSet: previews(id) })),
        })
        const controller = start({ container, loadManifest, loadDetail, trigger: 'focus', responsive })
        try {
            await vi.advanceTimersByTimeAsync(16)
            expect(container.querySelectorAll('.album-card-photo-preview')).toHaveLength(1)
            expect(container.querySelector('img').src).toMatch(new RegExp(`-${expectedWidth}\\.webp$`))
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
