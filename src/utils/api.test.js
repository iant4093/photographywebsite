import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearApiCache, fetchAlbumsPage } from './api'

describe('fetchAlbumsPage cancellation', () => {
    beforeEach(() => {
        clearApiCache()
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            clearTimeout: globalThis.clearTimeout,
        })
    })

    afterEach(() => {
        clearApiCache()
        vi.unstubAllGlobals()
    })

    it('rejects an already-aborted request before reading cache or making a request', async () => {
        const request = vi.fn()
        vi.stubGlobal('fetch', request)
        const controller = new AbortController()
        controller.abort()

        await expect(fetchAlbumsPage({ limit: 24 }, { signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' })
        expect(request).not.toHaveBeenCalled()
    })

    it('replaces an aborted in-flight request instead of subscribing to it', async () => {
        let requestCount = 0
        vi.stubGlobal('fetch', vi.fn((_url, { signal }) => {
            requestCount += 1
            if (requestCount === 1) {
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
                })
            }
            return Promise.resolve(new Response(JSON.stringify({
                items: [{ albumId: 'replacement-request' }],
                nextCursor: null,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        }))

        const firstController = new AbortController()
        const firstRequest = fetchAlbumsPage({ visibility: 'public', type: 'photo', limit: 24 }, {
            signal: firstController.signal,
        })
        firstController.abort()
        const replacement = fetchAlbumsPage({ visibility: 'public', type: 'photo', limit: 24 })

        await expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' })
        await expect(replacement).resolves.toMatchObject({
            items: [{ albumId: 'replacement-request' }],
            nextCursor: null,
        })
        expect(requestCount).toBe(2)
    })
})
