import { describe, expect, it, vi } from 'vitest'
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
})
