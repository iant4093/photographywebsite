import { afterEach, expect, it, vi } from 'vitest'
import { allowPhotoPrefetch, prefetchPhoto } from './photoPrefetch'
import { isImageReady, markImageReady } from './imageReadiness'

const photo = { width: 2000, height: 1000, previewSrcSet: [
    { width: 640, url: 'https://media.test/640.webp' },
    { width: 960, url: 'https://media.test/960.webp' },
    { width: 1440, url: 'https://media.test/1440.webp' },
    { width: 1920, url: 'https://media.test/1920.webp' },
] }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('selects just one viewport-appropriate preview and releases it when the viewer leaves', async () => {
    const instances = []
    vi.stubGlobal('Image', class { constructor() { instances.push(this) } decode = vi.fn().mockResolvedValue(); removeAttribute = vi.fn() })
    vi.stubGlobal('devicePixelRatio', 2)
    const release = prefetchPhoto(photo, 500)
    expect(instances).toHaveLength(1)
    const image = instances[0]
    expect(image.src).toBe(photo.previewSrcSet[2].url)
    expect(image.fetchPriority).toBe('low')
    image.onload()
    await vi.waitFor(() => expect(isImageReady(image.src)).toBe(true))
    release()
    expect(image.removeAttribute).toHaveBeenCalledWith('src')
    expect(image.onload).toBeNull()
    prefetchPhoto(photo, 500)()
    expect(instances).toHaveLength(1)
})

it('avoids constrained connections, hidden tabs, originals and oversized decoded images', () => {
    const Image = vi.fn()
    vi.stubGlobal('Image', Image)
    for (const connection of [{ saveData: true }, { effectiveType: '3g' }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }, { downlink: 0.8 }]) {
        vi.stubGlobal('navigator', { connection })
        expect(allowPhotoPrefetch()).toBe(false)
        prefetchPhoto(photo, 300)()
    }
    vi.stubGlobal('navigator', { connection: { downlink: 10 } })
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    prefetchPhoto(photo, 300)()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    prefetchPhoto({ url: 'https://media.test/original.jpg' }, 300)()
    prefetchPhoto(photo, 0)()
    prefetchPhoto({ ...photo, height: 12000 }, 1800)()
    expect(Image).not.toHaveBeenCalled()
})

it('does not publish a cancelled decode or an image whose decoder throws', async () => {
    const instances = []
    vi.stubGlobal('Image', class { constructor() { instances.push(this) } decode = () => { throw Error('decode') }; removeAttribute() {} })
    vi.stubGlobal('devicePixelRatio', 1)
    const release = prefetchPhoto(photo, 200)
    instances[0].onload()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(isImageReady(instances[0].src)).toBe(false)
    let finish
    instances[0].decode = () => new Promise(resolve => { finish = resolve })
    instances[0].onload()
    await Promise.resolve()
    release()
    finish()
    await Promise.resolve(); await Promise.resolve()
    expect(isImageReady(instances[0].src)).toBe(false)
})

it('bounds URL readiness history and keeps different candidates and signatures independent', () => {
    markImageReady(null)
    markImageReady('old')
    for (let i = 0; i < 192; i++) markImageReady(`candidate-${i}`)
    expect(isImageReady('old')).toBe(false)
    markImageReady('candidate-0')
    markImageReady('new')
    expect(isImageReady('candidate-0')).toBe(true)
    expect(isImageReady('candidate-1')).toBe(false)
    expect(isImageReady('new?signature=changed')).toBe(false)
})
