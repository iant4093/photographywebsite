import { describe, expect, it, vi } from 'vitest'
import {
    TV_DEFAULTS, TV_SETTINGS_KEY, backdropUrl, createPreloader, fittedWidth, readTvSettings, saveTvSettings,
    shuffled, sizesFor, slideshowPhotos,
} from './tvSlideshow'

const srcSet = (name) => [640, 960, 1440, 1920].map((width) => ({ width, url: `https://cdn.test/${name}-${width}.webp` }))
const photo = (name, extra = {}) => ({ id: name, url: `https://cdn.test/${name}.jpg`, previewSrcSet: srcSet(name), width: 3000, height: 2000, ...extra })

function memoryStorage(initial = {}) {
    const values = { ...initial }
    return { getItem: (key) => values[key] ?? null, setItem: (key, value) => { values[key] = value }, values }
}

describe('TV slideshow settings', () => {
    it('keeps only known, valid saved choices', () => {
        expect(readTvSettings(memoryStorage())).toEqual(TV_DEFAULTS)
        const storage = memoryStorage({ [TV_SETTINGS_KEY]: JSON.stringify({ interval: 15, order: 'newest', clock: false, motion: 'yes', background: 'neon', extra: 1 }) })
        expect(readTvSettings(storage)).toEqual({ ...TV_DEFAULTS, interval: 15, order: 'newest', clock: false })
        expect(readTvSettings(memoryStorage({ [TV_SETTINGS_KEY]: '{' }))).toEqual(TV_DEFAULTS)
        expect(readTvSettings(memoryStorage({ [TV_SETTINGS_KEY]: 'null' }))).toEqual(TV_DEFAULTS)
        expect(readTvSettings({ getItem: () => { throw new Error('blocked') } })).toEqual(TV_DEFAULTS)
        expect(readTvSettings(null)).toEqual(TV_DEFAULTS)
    })

    it('saves settings and tolerates blocked storage', () => {
        const storage = memoryStorage()
        saveTvSettings({ ...TV_DEFAULTS, interval: 30 }, storage)
        expect(JSON.parse(storage.values[TV_SETTINGS_KEY]).interval).toBe(30)
        expect(() => saveTvSettings(TV_DEFAULTS, { setItem: () => { throw new Error('quota') } })).not.toThrow()
    })
})

describe('TV slideshow photos and sizing', () => {
    it('shuffles a copy, and keeps usable photos once each', () => {
        const items = [1, 2, 3, 4]
        expect(shuffled(items, () => 0)).toEqual([2, 3, 4, 1])
        expect(items).toEqual([1, 2, 3, 4])
        expect(shuffled(items).sort()).toEqual(items)
        expect(slideshowPhotos([photo('a'), photo('a'), { id: 'b' }, photo('c', { previewSrcSet: [] }), null]).map((item) => item.id))
            .toEqual(['a', 'c'])
        expect(slideshowPhotos(undefined)).toEqual([])
    })

    it('sizes each photo to the space it fills', () => {
        const bounds = { width: 1200, height: 800 }
        expect(fittedWidth(photo('wide'), bounds)).toBe(1200)
        expect(fittedWidth(photo('tall', { width: 2000, height: 3000 }), bounds)).toBe(534)
        expect(fittedWidth({}, bounds)).toBe(1200)
        expect(fittedWidth(photo('x'), { width: 0, height: 0 })).toBe(0)
        expect(sizesFor(photo('tall', { width: 2000, height: 3000 }), bounds)).toBe('534px')
        expect(sizesFor(photo('x'), null)).toBe('100vw')
        expect(backdropUrl(photo('a'))).toBe('https://cdn.test/a-640.webp')
        expect(backdropUrl({ url: 'https://cdn.test/raw.jpg' })).toBe('https://cdn.test/raw.jpg')
    })
})

describe('TV slideshow preloader', () => {
    function fakeImages() {
        const created = []
        class FakeImage {
            constructor() { created.push(this); this.attributes = {} }
            set src(value) { this.attributes.src = value }
            get src() { return this.attributes.src }
            removeAttribute(name) { delete this.attributes[name] }
            decode() { return this.decodeResult || Promise.resolve() }
        }
        return { FakeImage, created }
    }

    it('decodes the wanted photos two at a time with the slide size, then the rest', async () => {
        const { FakeImage, created } = fakeImages()
        const onReady = vi.fn()
        const preloader = createPreloader({ onReady, ImageClass: FakeImage })
        const items = ['a', 'b', 'c'].map((name, index) => ({ key: name, image: photo(name), sizes: '900px', decode: index < 2 }))
        preloader.want(items)
        expect(created).toHaveLength(2)
        expect(created[0]).toMatchObject({ sizes: '900px', srcset: expect.stringContaining('a-1920.webp 1920w'), fetchPriority: 'high' })
        created[0].onload()
        await Promise.resolve(); await Promise.resolve()
        expect(onReady).toHaveBeenCalledWith('a', true)
        expect(preloader.isReady('a')).toBe(true)
        expect(created).toHaveLength(3)
        created[2].onload()
        expect(preloader.isReady('c')).toBe(true)
        created[1].onerror()
        expect(preloader.hasFailed('b')).toBe(true)
        expect(onReady).toHaveBeenCalledWith('b', false)
        // Wanting the same photos again starts nothing new.
        preloader.want(items)
        expect(created).toHaveLength(3)
    })

    it('releases photos that leave the window, even mid-load', async () => {
        const { FakeImage, created } = fakeImages()
        const onReady = vi.fn()
        const preloader = createPreloader({ onReady, ImageClass: FakeImage })
        preloader.want([{ key: 'a', image: photo('a'), sizes: '1px', decode: true }, { key: 'b', image: photo('b'), sizes: '1px', decode: true }])
        preloader.want([{ key: 'c', image: { id: 'c', url: 'https://cdn.test/c.jpg' }, sizes: '1px', decode: false }])
        expect(created[0].attributes.src).toBeUndefined()
        expect(created[0].onload).toBeNull()
        expect(created[2].srcset).toBeUndefined()
        expect(created[2].attributes.src).toBe('https://cdn.test/c.jpg')
        // Warming (no decode) counts as ready once the bytes arrive.
        created[2].onload()
        expect(preloader.isReady('c')).toBe(true)
        preloader.clear()
        expect(preloader.isReady('c')).toBe(false)
        expect(onReady).toHaveBeenCalledTimes(1)
    })

    it('treats a decode failure after loading as ready, and skips released work', async () => {
        const { FakeImage, created } = fakeImages()
        const preloader = createPreloader({ ImageClass: FakeImage })
        preloader.want([{ key: 'a', image: photo('a'), sizes: '1px', decode: true }])
        created[0].decodeResult = Promise.reject(new Error('decode'))
        created[0].onload()
        await Promise.resolve(); await Promise.resolve()
        expect(preloader.isReady('a')).toBe(true)
        const second = createPreloader({ ImageClass: class { set src(_) {} } })
        expect(() => second.want([{ key: 'z', image: photo('z'), sizes: '1px', decode: true }])).not.toThrow()
    })
})
