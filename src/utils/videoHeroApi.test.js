import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchHeroReelStatus, publishHeroReel, requestHeroReelDraft } from './videoHeroApi'

const response = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
})

describe('video hero API', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('reads reel status, requests drafts, and publishes a reviewed version', async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(response({ job: null }))
            .mockResolvedValueOnce(response({ job: { status: 'queued' } }, 202))
            .mockResolvedValueOnce(response({ job: { status: 'queued' } }, 202))
        vi.stubGlobal('fetch', fetch)
        const signal = new AbortController().signal

        await expect(fetchHeroReelStatus('token', { signal })).resolves.toEqual({ job: null })
        await requestHeroReelDraft('token')
        await publishHeroReel('token', 'a'.repeat(24))

        expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining('/admin/hero/reel-status'), expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ Authorization: 'Bearer token' }),
            signal: expect.any(AbortSignal),
        }))
        expect(fetch).toHaveBeenNthCalledWith(2, expect.stringContaining('/admin/hero/reel-generate'), expect.anything())
        expect(fetch).toHaveBeenNthCalledWith(3, expect.stringContaining('/admin/hero/reel-publish'), expect.objectContaining({
            body: JSON.stringify({ version: 'a'.repeat(24), heroType: 'video' }),
        }))
    })

    it('redacts provider failures and preserves safe validation messages', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ message: 'A hero video job is already in progress' }, 409)))
        await expect(requestHeroReelDraft('token')).rejects.toMatchObject({
            status: 409,
            message: 'A hero video job is already in progress',
        })

        globalThis.fetch.mockResolvedValueOnce(response({ message: 'private provider detail' }, 500))
        await expect(publishHeroReel('token', 'bad')).rejects.toMatchObject({
            status: 500,
            message: 'The service is temporarily unavailable. Please try again.',
        })

        globalThis.fetch.mockRejectedValueOnce(new TypeError('offline'))
        await expect(fetchHeroReelStatus('token')).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    })
})
