import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, uploadFileToS3 } from './api'

describe('server-directed request retries', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-21T12:00:00Z'))
        vi.spyOn(Math, 'random').mockReturnValue(0)
    })
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

    function replies(status, headers = {}) {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response('', { status, headers }))
            .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
        vi.stubGlobal('fetch', fetch)
        return fetch
    }

    it.each([
        [429, '5', 5000],
        [503, 'Mon, 21 Sep 2026 12:00:04 GMT', 4000],
        [429, 'invalid', 1000],
        [503, undefined, 250],
    ])('waits before retrying %i with Retry-After %s', async (status, hint, delay) => {
        const fetch = replies(status, hint ? { 'Retry-After': hint } : {})
        const result = apiFetch('/test')
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(fetch).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await expect(result).resolves.toEqual({ ok: true })
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('surfaces a long cooldown without retrying earlier than the server permits', async () => {
        const fetch = replies(429, { 'Retry-After': '120' })
        await expect(apiFetch('/test')).rejects.toMatchObject({ status: 429, retryAfterMs: 120000 })
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('cancels a cooldown when navigation aborts the request', async () => {
        const fetch = replies(429, { 'Retry-After': '10' })
        const controller = new AbortController()
        const result = apiFetch('/test', { signal: controller.signal })
        const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
        await vi.advanceTimersByTimeAsync(500)
        controller.abort()
        await rejection
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('does not introduce automatic retries for mutations', async () => {
        const fetch = replies(429, { 'Retry-After': '5' })
        await expect(apiFetch('/test', { method: 'POST' })).rejects.toMatchObject({ status: 429 })
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('also honors a storage upload cooldown without duplicating successful uploads', async () => {
        const fetch = replies(503, { 'Retry-After': '3' })
        const result = uploadFileToS3('https://upload.example/photo', new File(['photo'], 'photo.jpg'))
        await vi.advanceTimersByTimeAsync(2999)
        expect(fetch).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await expect(result).resolves.toMatchObject({ status: 200 })
        expect(fetch).toHaveBeenCalledTimes(2)
    })
})
