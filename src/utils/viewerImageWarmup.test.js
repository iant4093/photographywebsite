import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const prefetch = vi.hoisted(() => ({ allowed: true }))
vi.mock('./photoPrefetch', () => ({ allowPhotoPrefetch: () => prefetch.allowed }))

import { isImageReady } from './imageReadiness'
import { warmViewerImage } from './viewerImageWarmup'

const BASE = 'https://lh3.googleusercontent.com/drive-storage/warm'
const photo = (suffix, width = 3200, height = 4800) => ({
    id: suffix, width, height,
    previewSrcSet: [640, 960, 1440, 1920].map(size => ({ width: size, url: `${BASE}-${suffix}=w${size}` })),
})

describe('viewer image warm-up', () => {
    let images

    beforeEach(() => {
        images = []
        prefetch.allowed = true
        vi.stubGlobal('Image', class {
            constructor() {
                this.complete = false
                this.attributes = new Set()
                images.push(this)
            }
            set src(value) { this.source = value; this.attributes.add('src') }
            get src() { return this.source }
            removeAttribute(name) { this.attributes.delete(name) }
        })
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    })

    afterEach(() => vi.unstubAllGlobals())

    it('loads the srcSet candidate the viewer will pick, including tall portraits', () => {
        const release = warmViewerImage(photo('portrait'), 502)
        expect(images).toHaveLength(1)
        expect(images[0].src).toBe(`${BASE}-portrait=w1440`)
        expect(images[0]).toMatchObject({ decoding: 'async', fetchPriority: 'low' })
        warmViewerImage(photo('wide', 4800, 3200), 1128)
        expect(images[1].src).toBe(`${BASE}-wide=w1920`)

        release()
        expect(images[0].attributes.has('src')).toBe(false)
        expect(images[0].onload).toBeNull()
    })

    it('keeps finished downloads, marks them ready, and skips ready or disallowed work', () => {
        const release = warmViewerImage(photo('done'), 300)
        images[0].complete = true
        images[0].onload()
        release()
        expect(images[0].attributes.has('src')).toBe(true)
        expect(isImageReady(`${BASE}-done=w640`)).toBe(true)

        warmViewerImage(photo('done'), 300)
        warmViewerImage({ id: 'none' }, 300)
        warmViewerImage(photo('zero'), 0)
        prefetch.allowed = false
        warmViewerImage(photo('save-data'), 300)
        expect(images).toHaveLength(1)
    })
})
