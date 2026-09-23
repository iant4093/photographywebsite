import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAlbumHoverManifestCache, fetchAlbumHoverManifest } from './albumHoverManifest'

const albumId = '11111111-1111-4111-8111-111111111111'
const version = 'a'.repeat(24)
const manifestUrl = `https://media.example.test/public-previews/${albumId}/v3/hover-${version}.json`
const album = {
    albumId,
    coverImageUrl: `https://media.example.test/albums/${albumId}/original/cover.jpg`,
    hoverPreviewStatus: 'ready',
    hoverPreviewVersion: version,
    hoverPreviewManifestUrl: manifestUrl,
}

function payload(overrides = {}) {
    return {
        schemaVersion: 1,
        albumId,
        version,
        images: ['1', '2'].map(value => ({
            url: `https://media.example.test/public-previews/${albumId}/v3/${value}${'0'.repeat(23)}-w640.webp`,
            width: 640,
            height: 427,
        })),
        ...overrides,
    }
}

function response(body = payload(), options = {}) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: options.status || 200,
        headers: { 'Content-Type': options.contentType || 'application/json' },
    })
}

describe('immutable album hover manifests', () => {
    beforeEach(() => clearAlbumHoverManifestCache())
    afterEach(() => {
        clearAlbumHoverManifestCache()
        vi.unstubAllGlobals()
    })

    it('validates, deduplicates, and caches a versioned CDN manifest', async () => {
        let resolveRequest
        const request = vi.fn(() => new Promise(resolve => { resolveRequest = resolve }))
        vi.stubGlobal('fetch', request)

        const first = fetchAlbumHoverManifest(album)
        const second = fetchAlbumHoverManifest(album)
        expect(request).toHaveBeenCalledOnce()
        resolveRequest(response())

        await expect(first).resolves.toMatchObject({
            albumId,
            version,
            images: expect.arrayContaining([expect.objectContaining({ width: 640 })]),
        })
        await expect(second).resolves.toMatchObject({ albumId, version })
        await expect(fetchAlbumHoverManifest(album)).resolves.toMatchObject({ albumId, version })
        expect(request).toHaveBeenCalledOnce()
        expect(request).toHaveBeenCalledWith(manifestUrl, expect.objectContaining({
            credentials: 'omit',
            cache: 'force-cache',
        }))
    })

    it('distinguishes migrated unavailable albums from rollout fallback albums', async () => {
        const request = vi.fn()
        vi.stubGlobal('fetch', request)
        await expect(fetchAlbumHoverManifest({ hoverPreviewStatus: 'unavailable' }))
            .resolves.toEqual({ schemaVersion: 1, images: [] })
        await expect(fetchAlbumHoverManifest({ albumId })).resolves.toBeNull()
        expect(request).not.toHaveBeenCalled()
    })

    it('derives same-media variants from the validated URL, ignoring supplied variant URLs', async () => {
        const body = payload()
        body.images[0].previewSrcSet = [{ width: 1920, url: 'https://other.example.test/untrusted.webp' }]
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)))
        const manifest = await fetchAlbumHoverManifest(album)
        expect(manifest.images[0].previewSrcSet).toEqual([640, 960, 1440, 1920].map(width => ({
            width,
            url: body.images[0].url.replace('-w640.webp', `-w${width}.webp`),
        })))
    })

    it.each([
        [{ ...album, hoverPreviewVersion: 'b'.repeat(24) }, payload()],
        [{ ...album, hoverPreviewManifestUrl: manifestUrl.replace('media.example.test', 'other.example.test') }, payload()],
        [album, payload({ albumId: '22222222-2222-4222-8222-222222222222' })],
        [album, payload({ images: [] })],
        [album, payload({ images: [{ ...payload().images[0], width: 960 }] })],
        [album, payload({ images: [payload().images[0], payload().images[0]] })],
        ...[
            payload().images[0].url.replace('media.example.test', 'other.example.test'),
            payload().images[0].url.replace(albumId, '22222222-2222-4222-8222-222222222222'),
            payload().images[0].url.replace('-w640.webp', '-w1920.webp'),
        ].map(url => [album, payload({ images: [{ ...payload().images[0], url }, payload().images[1]] })]),
    ])('rejects malformed pointers and payloads', async (record, body) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)))
        await expect(fetchAlbumHoverManifest(record)).rejects.toThrow(/hover manifest/i)
    })

    it('rejects provider, content-type, JSON, and bounded-size failures', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(response('', { status: 404 }))
            .mockResolvedValueOnce(response(payload(), { contentType: 'text/plain' }))
            .mockResolvedValueOnce(response('{bad'))
            .mockResolvedValueOnce(response('x'.repeat(32 * 1024 + 1)))
        vi.stubGlobal('fetch', request)

        await expect(fetchAlbumHoverManifest(album)).rejects.toThrow(/unavailable/i)
        await expect(fetchAlbumHoverManifest(album)).rejects.toThrow(/content type/i)
        await expect(fetchAlbumHoverManifest(album)).rejects.toThrow()
        await expect(fetchAlbumHoverManifest(album)).rejects.toThrow(/size/i)
    })

    it('lets one subscriber abort without cancelling the shared immutable request', async () => {
        let resolveRequest
        vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveRequest = resolve })))
        const controller = new AbortController()
        const aborted = fetchAlbumHoverManifest(album, { signal: controller.signal })
        const shared = fetchAlbumHoverManifest(album)
        controller.abort()
        resolveRequest(response())

        await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
        await expect(shared).resolves.toMatchObject({ version })
    })
})

describe('hover request resource bounds', () => {
    afterEach(() => { clearAlbumHoverManifestCache(); vi.useRealTimers(); vi.unstubAllGlobals() })
    it('keeps a shared transfer alive for another consumer, aborts the last, and permits a fresh retry', async () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
        const first = new AbortController(), second = new AbortController()
        const a = expect(fetchAlbumHoverManifest(album, { signal: first.signal })).rejects.toMatchObject({ name: 'AbortError' })
        const b = expect(fetchAlbumHoverManifest(album, { signal: second.signal })).rejects.toMatchObject({ name: 'AbortError' })
        const networkSignal = fetch.mock.calls[0][1].signal
        first.abort(); await a
        expect(networkSignal.aborted).toBe(false)
        second.abort(); await b
        expect(networkSignal.aborted).toBe(true)
        fetch.mockResolvedValue(response())
        await expect(fetchAlbumHoverManifest(album)).resolves.toMatchObject({ albumId })
        expect(fetch).toHaveBeenCalledTimes(2)
    })
    it('evicts an unanswered transfer at its deadline even if fetch ignores abort', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
        const rejected = expect(fetchAlbumHoverManifest(album)).rejects.toMatchObject({ name: 'AbortError' })
        await vi.advanceTimersByTimeAsync(10000)
        await rejected
        expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
        fetch.mockResolvedValue(response())
        await expect(fetchAlbumHoverManifest(album)).resolves.toMatchObject({ albumId })
    })
    it('aborts a rejected response even when its unconsumed body never finishes', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream(), { headers: { 'content-type': 'text/plain' } })))
        await expect(fetchAlbumHoverManifest(album)).rejects.toThrow(/content type/)
        expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
        fetch.mockResolvedValue(response())
        await expect(fetchAlbumHoverManifest(album)).resolves.toMatchObject({ albumId })
    })
    it('cancels an oversized chunked body before consuming the entire response', async () => {
        const cancel = vi.fn()
        const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32769)) }, cancel })
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } })))
        await expect(fetchAlbumHoverManifest(album)).rejects.toThrow(/size/)
        expect(cancel).toHaveBeenCalledOnce()
    })
})
