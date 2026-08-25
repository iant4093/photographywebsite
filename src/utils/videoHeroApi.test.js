import { afterEach, describe, expect, it, vi } from 'vitest'

import { completeVideoHeroUpload, requestVideoHeroUploadUrl } from './videoHeroApi'

const response = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
})

describe('video hero API', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('authorizes and completes only the video hero namespace', async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(response({ uploadUrl: 'https://upload.test' }))
            .mockResolvedValueOnce(response({ status: 'processing' }, 202))
        vi.stubGlobal('fetch', fetch)
        const signal = new AbortController().signal
        const file = new File(['video hero'], 'video-hero.jpg', { type: 'image/jpeg' })

        await requestVideoHeroUploadUrl('token', file, { signal })
        await completeVideoHeroUpload('token', '0123456789abcdef0123456789abcdef', { signal })

        expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining('/admin/hero/upload-url'), expect.objectContaining({
            body: JSON.stringify({
                filename: 'video-hero.jpg',
                contentType: 'image/jpeg',
                size: file.size,
                heroType: 'video',
            }),
            signal: expect.any(AbortSignal),
        }))
        expect(fetch).toHaveBeenNthCalledWith(2, expect.stringContaining('/admin/hero/complete'), expect.objectContaining({
            body: JSON.stringify({ etag: '0123456789abcdef0123456789abcdef', heroType: 'video' }),
        }))
    })

    it('redacts provider failures and preserves safe validation messages', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ message: 'Use a valid video hero' }, 400)))
        await expect(completeVideoHeroUpload('token', 'bad')).rejects.toMatchObject({
            status: 400,
            message: 'Use a valid video hero',
        })

        globalThis.fetch.mockResolvedValueOnce(response({ message: 'private provider detail' }, 500))
        await expect(completeVideoHeroUpload('token', 'bad')).rejects.toMatchObject({
            status: 500,
            message: 'The service is temporarily unavailable. Please try again.',
        })
    })
})
