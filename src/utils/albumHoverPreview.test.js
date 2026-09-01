import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    ALBUM_HOVER_PREVIEW_LIMIT,
    canRunAlbumHoverPreview,
    selectAlbumHoverPreviews,
} from './albumHoverPreview'

const previews = (name) => [640, 960, 1440, 1920]
    .map((width) => ({ width, url: `https://media.example.test/${name}-${width}.webp` }))

describe('album hover preview selection', () => {
    afterEach(() => vi.unstubAllGlobals())

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
})
