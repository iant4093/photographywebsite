import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMediaUploadSession, createUploadConcurrency } from './mediaUpload'
import { createUploadProgress } from './uploadProgress'

const api = vi.hoisted(() => ({ requestUploadUrls: vi.fn(), uploadFileToS3: vi.fn() }))
vi.mock('./api', () => api)

const entries = (count = 1) => Array.from({ length: count }, (_, i) => ({ file: new File(['photo'], `${i}.jpg`, { type: 'image/jpeg' }) }))
function setup(files = entries()) {
    const session = createMediaUploadSession({ albumId: 'album', s3Prefix: 'albums/album/', entries: files })
    const getIdToken = vi.fn().mockResolvedValue('fresh-token')
    const prepare = vi.fn().mockResolvedValue({ thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }), width: 400, height: 300, blurhash: 'hash' })
    const transfer = createUploadProgress(files.map(({ file }) => file))
    return { session, getIdToken, prepare, transfer, files }
}
async function finish(promise) {
    // Attach both handlers before advancing timers, including rejected cases.
    const result = promise.then(value => ({ value }), error => ({ error }))
    await vi.runAllTimersAsync()
    return result
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    let id = 0
    api.requestUploadUrls.mockImplementation(async (_token, albumId, files) => ({
        uploads: files.map(({ kind }) => ({ key: `albums/${albumId}/${kind}/${id++}.jpg`, uploadUrl: `https://upload.test/${kind}/${id}`, requiredHeaders: { 'x-amz-tagging': 'visibility=pending' } })),
    }))
    api.uploadFileToS3.mockImplementation(async (_url, file, _headers, { onProgress }) => { onProgress({ loaded: file.size }) })
})
afterEach(() => vi.useRealTimers())

describe('bounded, resumable media uploads', () => {
    it('uploads 220 photos in order, bounds preparation and authorization, and refreshes the token per request', async () => {
        const options = setup(entries(220))
        let preparing = 0
        let maxPreparing = 0
        options.prepare.mockImplementation(async () => {
            preparing += 1
            maxPreparing = Math.max(maxPreparing, preparing)
            await new Promise(resolve => setTimeout(resolve, 2))
            preparing -= 1
            return { thumbnail: new Blob(['t']), width: 400, height: 300 }
        })
        const { value } = await finish(options.session.run(options))
        expect(value).toHaveLength(220)
        expect(value.map(item => item.originalFilename)).toEqual(options.files.map(({ file }) => file.name))
        expect(api.uploadFileToS3).toHaveBeenCalledTimes(440)
        expect(api.requestUploadUrls.mock.calls.length).toBeLessThanOrEqual(110)
        expect(api.requestUploadUrls.mock.calls.every(call => call[2].length <= 8)).toBe(true)
        expect(options.getIdToken).toHaveBeenCalledTimes(api.requestUploadUrls.mock.calls.length)
        expect(maxPreparing).toBeLessThanOrEqual(2)
        expect(options.transfer.snapshot()).toMatchObject({ completedFiles: 220, loadedBytes: 1320, totalBytes: 1320 })
    })

    it('waits for in-flight work, reuses each successful part, and does not reprocess or resign completed files', async () => {
        const options = setup(entries(5))
        let releaseThumbnail
        api.uploadFileToS3.mockImplementation(async (url, file, _headers, { onProgress }) => {
            if (url.endsWith('/original/1')) throw new Error('offline')
            if (url.endsWith('/thumbnail/2')) await new Promise(resolve => { releaseThumbnail = resolve })
            onProgress({ loaded: file.size })
        })
        let settled = false
        const first = options.session.run(options).catch(error => { settled = true; return error })
        await vi.advanceTimersByTimeAsync(10)
        expect(settled).toBe(false)
        releaseThumbnail()
        await vi.runAllTimersAsync()
        expect((await first).message).toBe('offline')
        const successes = api.uploadFileToS3.mock.calls.filter(([url]) => !url.endsWith('/original/1')).length
        api.uploadFileToS3.mockImplementation(async (_url, file, _headers, { onProgress }) => onProgress({ loaded: file.size }))
        options.transfer = createUploadProgress(options.files.map(({ file }) => file))
        expect((await finish(options.session.run(options))).value).toHaveLength(5)
        expect(api.uploadFileToS3).toHaveBeenCalledTimes(11) // ten objects plus one failed attempt
        expect(successes).toBeGreaterThan(0)
        expect(options.prepare).toHaveBeenCalledTimes(5)
        expect(options.transfer.snapshot()).toMatchObject({ completedFiles: 5, loadedBytes: 50, totalBytes: 50 })
    })

    it('retries expired permissions once and commits the newly issued key', async () => {
        const options = setup()
        api.uploadFileToS3.mockRejectedValueOnce({ status: 403 })
        const { value } = await finish(options.session.run(options))
        expect(api.requestUploadUrls).toHaveBeenCalledTimes(2)
        expect(api.requestUploadUrls.mock.calls[1][2]).toHaveLength(1)
        expect(value[0].rawKey).toBe('albums/album/original/2.jpg')
        expect(api.uploadFileToS3).toHaveBeenCalledTimes(3)
    })

    it('surfaces repeated 403s and malformed permissions instead of looping or saving', async () => {
        const options = setup()
        api.uploadFileToS3.mockRejectedValue({ status: 403 })
        expect((await finish(options.session.run(options))).error).toMatchObject({ status: 403 })
        expect(api.uploadFileToS3).toHaveBeenCalledTimes(4)
        api.requestUploadUrls.mockResolvedValue({ uploads: [] })
        expect((await finish(options.session.run(options))).error.message).toMatch(/incomplete/)
    })

    it('can retry authorization/preparation errors and freezes a save retry without uploading again', async () => {
        const options = setup()
        options.prepare.mockRejectedValueOnce(new Error('decode'))
        expect((await finish(options.session.run(options))).error.message).toBe('decode')
        options.getIdToken.mockRejectedValueOnce(new Error('sign in'))
        expect((await finish(options.session.run(options))).error.message).toBe('sign in')
        expect((await finish(options.session.run(options))).value).toHaveLength(1)
        const previous = api.uploadFileToS3.mock.calls.length
        expect((await finish(options.session.run(options))).value).toHaveLength(1)
        expect(api.uploadFileToS3).toHaveBeenCalledTimes(previous)
        expect(options.session.commitBody({ visibility: 'private' })).toEqual({ visibility: 'private' })
        expect(options.session.commitBody({ visibility: 'public' })).toEqual({ visibility: 'private' })
        expect(options.session.matches(options.files)).toBe(true)
        expect(options.session.matches(entries())).toBe(false)
        expect(options.session.matches(options.files, 'different-album')).toBe(false)
        expect(options.session.matches([{ ...options.files[0], time: 2 }])).toBe(false)
    })

    it('cancels before authorization and refuses overlapping runs', async () => {
        const options = setup()
        const first = options.session.run(options).catch(error => error)
        await expect(options.session.run(options)).rejects.toThrow(/already running/)
        options.session.cancel()
        await vi.runAllTimersAsync()
        expect((await first).name).toBe('AbortError')
        expect(api.uploadFileToS3).not.toHaveBeenCalled()
    })
})

describe('adaptive transfer concurrency', () => {
    it('keeps four only after a meaningful measured throughput gain', () => {
        for (const [probe, expected] of [[400, 4], [201, 2]]) {
            const controller = createUploadConcurrency({ effectiveType: '4g' })
            controller.observe(200, 1000, 2)
            expect(controller.limit).toBe(2)
            controller.observe(200, 1000, 2)
            expect(controller.limit).toBe(4)
            controller.observe(probe, 1000, 4)
            expect(controller.limit).toBe(expected)
            controller.observe(100000, 1, 4)
            expect(controller.limit).toBe(expected)
        }
    })
    it('does not probe on a slow or metered connection, or learn from partial windows', () => {
        for (const connection of [{ saveData: true }, { effectiveType: 'slow-2g' }, { effectiveType: '2g' }, { effectiveType: '3g' }]) {
            const controller = createUploadConcurrency(connection)
            for (let i = 0; i < 8; i++) controller.observe(1000, 100, 2)
            expect(controller.limit).toBe(2)
        }
        const controller = createUploadConcurrency({})
        controller.observe(100, 0, 2)
        controller.observe(100, 100, 1)
        expect(controller.limit).toBe(2)
    })
})
