import { afterEach, expect, it, vi } from 'vitest'
import { clearApiCache, fetchAlbum, fetchAlbumsPage, readCachedAlbumsPage, readCachedPublicAlbum, fetchAlbumMediaPage } from './api'

const response = value => new Response(JSON.stringify(value), { status: 200 })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { clearApiCache({ sessionChanged: true }); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each(['catalog', 'album'])('an older %s request cannot overwrite a successful forced refresh', async type => {
    const pending = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => pending.push(resolve))))
    const load = options => type === 'catalog' ? fetchAlbumsPage({}, options) : fetchAlbum('a', null, options)
    const body = title => type === 'catalog' ? { items: [{ albumId: 'a', title }] } : { albumId: 'a', title }
    const old = load({})
    const fresh = load({ force: true })
    pending[1](response(body('current')))
    await fresh
    pending[0](response(body('old')))
    await old
    expect(type === 'catalog' ? readCachedAlbumsPage({}).items[0].title : readCachedPublicAlbum('a').title).toBe('current')
})

it('bounds catalog storage and prunes expired entries without losing a recent page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ items: [{ albumId: 'a' }] })))
    for (let index = 0; index < 130; index++) await fetchAlbumsPage({ cursor: String(index) })
    expect(readCachedAlbumsPage({ cursor: '0' })).toBeNull()
    expect(readCachedAlbumsPage({ cursor: '129' })).not.toBeNull()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 300001)
    expect(readCachedAlbumsPage({ cursor: '129' })).toBeNull()
})

it('renders remaining media immediately and shares recovery without cancelling another subscriber', async () => {
    let complete
    let recoverySignal
    const fetch = vi.fn(async (url, options) => {
        if (url.includes('delete-images')) {
            recoverySignal = options.signal
            return new Promise(resolve => { complete = () => resolve(response({ album: { albumId: 'a', imageCount: 1 } })) })
        }
        return response({ items: [{ rawKey: 'remaining' }], pendingDeletionKeys: ['deleted'] })
    })
    vi.stubGlobal('fetch', fetch)
    const first = new AbortController(), second = new AbortController()
    const notifyFirst = vi.fn(), notifySecond = vi.fn()
    const page = await fetchAlbumMediaPage('token', 'a', {}, { signal: first.signal, onDeletionRecovered: notifyFirst })
    expect(page.items[0].rawKey).toBe('remaining')
    await fetchAlbumMediaPage('token', 'a', {}, { signal: second.signal, onDeletionRecovered: notifySecond })
    while (!complete) await tick()
    expect(fetch.mock.calls.filter(([url]) => url.includes('delete-images'))).toHaveLength(1)
    first.abort()
    expect(recoverySignal.aborted).toBe(false)
    complete()
    await vi.waitFor(() => expect(notifySecond).toHaveBeenCalledWith({ albumId: 'a', imageCount: 1 }))
    expect(notifyFirst).not.toHaveBeenCalled()
})

it.each(['cancel', 'logout'])('suppresses recovery callbacks after %s', async action => {
    let complete
    let recoverySignal
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        if (url.includes('delete-images')) {
            recoverySignal = options.signal
            return new Promise(resolve => { complete = () => resolve(response({ album: { albumId: 'a' } })) })
        }
        return response({ items: [], pendingDeletionKeys: ['deleted'] })
    }))
    const controller = new AbortController(), notify = vi.fn()
    await fetchAlbumMediaPage('token', 'a', {}, { signal: controller.signal, onDeletionRecovered: notify })
    while (!complete) await tick()
    if (action === 'cancel') { controller.abort(); expect(recoverySignal.aborted).toBe(true) }
    else clearApiCache({ sessionChanged: true })
    complete()
    await tick(); await tick()
    expect(notify).not.toHaveBeenCalled()
})

it('keeps the page usable when background recovery fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => url.includes('delete-images')
        ? new Response('{}', { status: 503 })
        : response({ items: [{ rawKey: 'remaining' }], pendingDeletionKeys: ['deleted'] })))
    const notify = vi.fn()
    const page = await fetchAlbumMediaPage('token', 'a', {}, { onDeletionRecovered: notify })
    expect(page.items).toHaveLength(1)
    await tick(); await tick()
    expect(notify).not.toHaveBeenCalled()
})
