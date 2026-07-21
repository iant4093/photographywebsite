import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollZipJob, ZipJobError } from './zipDownload'

function memoryStorage() {
    const values = new Map()
    return {
        getItem: (key) => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
        values,
    }
}

describe('pollZipJob', () => {
    afterEach(() => vi.useRealTimers())
    it('backs off until a ready URL is returned and clears recovery state', async () => {
        const storage = memoryStorage()
        const request = vi.fn()
            .mockResolvedValueOnce({ status: 'processing' })
            .mockResolvedValueOnce({ status: 'processing', retryAfterSeconds: 20 })
            .mockResolvedValueOnce({ status: 'ready', url: 'https://example.com/album.zip' })
        const sleep = vi.fn().mockResolvedValue()

        await expect(pollZipJob({
            jobKey: 'album-one',
            request,
            storage,
            sleep,
        })).resolves.toBe('https://example.com/album.zip')

        expect(sleep).toHaveBeenNthCalledWith(1, 5_000, undefined)
        expect(sleep).toHaveBeenNthCalledWith(2, 20_000, undefined)
        expect(storage.values.size).toBe(0)
    })

    it('uses sessionStorage when no explicit storage adapter is supplied', async () => {
        sessionStorage.clear()
        await expect(pollZipJob({
            jobKey: 'browser-storage',
            request: vi.fn().mockResolvedValue({ status: 'ready', url: 'https://example.com/browser.zip' }),
        })).resolves.toContain('browser.zip')
        expect(sessionStorage.length).toBe(0)
    })

    it('surfaces terminal worker failures without continuing to poll', async () => {
        const request = vi.fn().mockResolvedValue({
            status: 'failed',
            code: 'TOO_LARGE',
            message: 'Album is too large.',
        })

        await expect(pollZipJob({
            jobKey: 'album-two',
            request,
            storage: memoryStorage(),
            sleep: vi.fn(),
        })).rejects.toMatchObject({
            name: 'ZipJobError',
            code: 'TOO_LARGE',
            terminal: true,
        })
        expect(request).toHaveBeenCalledTimes(1)
    })

    it('uses a bounded wait after a rate-limit response', async () => {
        const limited = Object.assign(new Error('slow down'), { status: 429, retryAfterMs: 45_000 })
        const request = vi.fn()
            .mockRejectedValueOnce(limited)
            .mockResolvedValueOnce({ status: 'ready', url: 'https://example.com/album.zip' })
        const sleep = vi.fn().mockResolvedValue()

        await pollZipJob({ jobKey: 'album-three', request, storage: memoryStorage(), sleep })
        expect(sleep).toHaveBeenCalledWith(45_000, undefined)
    })

    it('rejects unknown statuses as terminal contract errors', async () => {
        await expect(pollZipJob({
            jobKey: 'album-four',
            request: vi.fn().mockResolvedValue({ status: 'mystery' }),
            storage: memoryStorage(),
            sleep: vi.fn(),
        })).rejects.toBeInstanceOf(ZipJobError)
    })

    it('recovers a recent start time and times out after the remaining lifetime', async () => {
        const storage = memoryStorage()
        storage.setItem('photography.zip.recovered', JSON.stringify({ startedAt: 1_000, status: 'processing' }))
        const now = vi.fn().mockReturnValueOnce(2_000).mockReturnValue(2_100)
        await expect(pollZipJob({
            jobKey: 'recovered', request: vi.fn(), storage, now, maxDurationMs: 1_050,
        })).rejects.toMatchObject({ code: 'ZIP_TIMEOUT', terminal: true })
        expect(storage.values.size).toBe(0)
    })

    it('forgets state on ordinary failures and preserves AbortError identity', async () => {
        const storage = memoryStorage()
        const failure = new Error('network')
        await expect(pollZipJob({ jobKey: 'failure', request: vi.fn().mockRejectedValue(failure), storage }))
            .rejects.toBe(failure)
        expect(storage.values.size).toBe(0)

        const aborted = new DOMException('aborted', 'AbortError')
        await expect(pollZipJob({ jobKey: 'abort', request: vi.fn().mockRejectedValue(aborted), storage }))
            .rejects.toBe(aborted)
        const controller = new AbortController()
        controller.abort()
        await expect(pollZipJob({ jobKey: 'pre-abort', request: vi.fn(), signal: controller.signal, storage }))
            .rejects.toMatchObject({ name: 'AbortError' })
    })

    it('bounds server retry hints and falls back to the final configured interval', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce({ status: 'processing', retryAfterSeconds: 1 })
            .mockResolvedValueOnce({ status: 'processing', retryAfterSeconds: 100 })
            .mockResolvedValueOnce({ status: 'processing' })
            .mockResolvedValueOnce({ status: 'processing' })
            .mockResolvedValueOnce({ status: 'ready', url: 'ready' })
        const sleep = vi.fn().mockResolvedValue()
        await pollZipJob({ jobKey: 'bounds', request, storage: memoryStorage(), sleep, intervals: [7, 9] })
        expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([5_000, 60_000, 9, 9])
    })

    it('uses the default abortable browser sleep and tolerates broken storage', async () => {
        vi.useFakeTimers()
        const controller = new AbortController()
        const storage = {
            getItem: () => { throw new Error('blocked') },
            setItem: () => { throw new Error('blocked') },
            removeItem: () => { throw new Error('blocked') },
        }
        const result = pollZipJob({
            jobKey: 'default-sleep',
            request: vi.fn().mockResolvedValue({ status: 'processing' }),
            storage,
            signal: controller.signal,
        })
        const expectation = expect(result).rejects.toMatchObject({ name: 'AbortError' })
        await Promise.resolve()
        controller.abort()
        await expectation
    })
})
