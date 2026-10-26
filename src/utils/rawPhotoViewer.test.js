import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const prefetch = vi.hoisted(() => ({ prefetchPhoto: vi.fn() }))
vi.mock('./viewerImageWarmup', () => ({ warmViewerImage: prefetch.prefetchPhoto }))

import {
    createLightboxPrefetchPool,
    lightboxCssWidth,
    lightboxStageBounds,
    rawPhotoFolderHref,
    toViewerPhoto,
} from './rawPhotoViewer'

const THUMB = 'https://lh3.googleusercontent.com/drive-storage/token'

describe('raw photo viewer helpers', () => {
    beforeEach(() => {
        prefetch.prefetchPhoto.mockReset().mockImplementation(() => vi.fn())
        Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
        Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    })

    afterEach(() => document.body.replaceChildren())

    it('maps Drive thumbnails to the site responsive image contract', () => {
        expect(toViewerPhoto({ id: 'one', name: '4K1A0001.JPG', thumbnail: THUMB, width: 4800, height: 3200 })).toEqual({
            id: 'one',
            altText: '4K1A0001.JPG',
            thumbnailUrl: `${THUMB}=w640`,
            url: `${THUMB}=w2560`,
            previewSrcSet: [640, 960, 1440, 1920].map((width) => ({ width, url: `${THUMB}=w${width}` })),
            width: 4800,
            height: 3200,
        })
        expect(toViewerPhoto({ id: 'two', name: 'IMG.CR3', thumbnail: THUMB })).not.toHaveProperty('width')
        expect(rawPhotoFolderHref({ id: 'root' }, true)).toBe('/admin/raw-photos')
        expect(rawPhotoFolderHref({ id: 'a b' }, false)).toBe('/admin/raw-photos?folder=a%20b')
    })

    it('estimates the viewer stage before the first open, then reuses its measured size', () => {
        expect(lightboxStageBounds()).toEqual({ width: 1344, height: 732 })
        window.innerWidth = 390
        expect(lightboxStageBounds()).toEqual({ width: 358, height: 796 })

        document.body.innerHTML = '<div class="linen-photo-lightbox"><div class="linen-lightbox-media"></div></div>'
        const stage = document.querySelector('.linen-lightbox-media')
        stage.getBoundingClientRect = () => ({ width: 1199.2, height: 751.4 })
        expect(lightboxStageBounds()).toEqual({ width: 1200, height: 752 })
        document.body.replaceChildren()
        expect(lightboxStageBounds()).toEqual({ width: 1200, height: 752 })

        expect(lightboxCssWidth({ width: 4800, height: 3200 }, { width: 1200, height: 752 })).toBe(1128)
        expect(lightboxCssWidth({ width: 3200, height: 4800 }, { width: 1200, height: 752 })).toBeCloseTo(501.33, 1)
        expect(lightboxCssWidth({ width: 6000, height: 1000 }, { width: 1200, height: 752 })).toBe(1200)
    })

    it('keeps one prefetch per photo URL and releases the rest', () => {
        const pool = createLightboxPrefetchPool()
        const one = toViewerPhoto({ id: 'one', name: 'a', thumbnail: `${THUMB}-1`, width: 3, height: 2 })
        const two = toViewerPhoto({ id: 'two', name: 'b', thumbnail: `${THUMB}-2`, width: 3, height: 2 })
        const refreshed = toViewerPhoto({ id: 'one', name: 'a', thumbnail: `${THUMB}-1-new`, width: 3, height: 2 })
        const noDimensions = toViewerPhoto({ id: 'raw', name: 'c', thumbnail: `${THUMB}-3` })

        pool.keep([one, two, noDimensions, undefined])
        expect(prefetch.prefetchPhoto).toHaveBeenCalledTimes(2)
        const [releaseOne, releaseTwo] = prefetch.prefetchPhoto.mock.results.map(({ value }) => value)

        pool.keep([two, refreshed])
        expect(releaseOne).toHaveBeenCalledOnce()
        expect(releaseTwo).not.toHaveBeenCalled()
        expect(prefetch.prefetchPhoto).toHaveBeenCalledTimes(3)
        expect(prefetch.prefetchPhoto.mock.calls[2][0]).toBe(refreshed)

        pool.keep([])
        expect(releaseTwo).toHaveBeenCalledOnce()
        pool.keep([one])
        pool.clear()
        expect(prefetch.prefetchPhoto.mock.results.at(-1).value).toHaveBeenCalledOnce()
    })
})
