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

    it('uses only complete 640px previews, excludes the cover, removes duplicates, and caps the sequence', () => {
        const cover = 'https://media.example.test/full/cover.jpg?version=1'
        const images = [
            { url: 'https://media.example.test/full/cover.jpg', previewSrcSet: previews('cover') },
            ...Array.from({ length: 7 }, (_, index) => ({
                url: `https://media.example.test/full/${index}.jpg`,
                previewSrcSet: previews(String(index)),
            })),
            { url: 'https://media.example.test/full/incomplete.jpg', previewSrcSet: previews('bad').slice(0, 2) },
            { url: 'https://media.example.test/full/duplicate.jpg', previewSrcSet: previews('0') },
        ]

        const selected = selectAlbumHoverPreviews({ images }, cover, () => 0.5)
        expect(selected).toHaveLength(ALBUM_HOVER_PREVIEW_LIMIT)
        expect(new Set(selected.map(({ url }) => url))).toHaveLength(ALBUM_HOVER_PREVIEW_LIMIT)
        expect(selected.every(({ url }) => /-640\.webp$/.test(url))).toBe(true)
        expect(selected.some(({ url }) => url.includes('cover-640'))).toBe(false)
        expect(selected.some(({ url }) => url.includes('bad-640'))).toBe(false)
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
})
