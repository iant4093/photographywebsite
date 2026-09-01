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

    it.each([
        [{ ...album, hoverPreviewVersion: 'b'.repeat(24) }, payload()],
        [{ ...album, hoverPreviewManifestUrl: manifestUrl.replace('media.example.test', 'other.example.test') }, payload()],
        [album, payload({ albumId: '22222222-2222-4222-8222-222222222222' })],
        [album, payload({ images: [] })],
        [album, payload({ images: [{ ...payload().images[0], width: 960 }] })],
        [album, payload({ images: [payload().images[0], payload().images[0]] })],
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
