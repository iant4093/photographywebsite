import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadFileToS3 } from './api'

let requests
class TestXHR {
    upload = {}
    headers = {}
    status = 200
    responseText = ''
    open = vi.fn()
    send = vi.fn()
    setRequestHeader = (key, value) => { this.headers[key] = value }
    getAllResponseHeaders = () => 'etag: "example"\r\n'
    abort = vi.fn(() => this.onabort())
    constructor() { requests.push(this) }
}

describe('measured signed uploads', () => {
    beforeEach(() => {
        requests = []
        vi.stubGlobal('XMLHttpRequest', TestXHR)
    })
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

    it('sends the exact blob and signed headers, reports progress, and waits for the server response', async () => {
        const file = new File(['0123456789'], 'image.jpg', { type: 'image/jpeg' })
        const onProgress = vi.fn()
        const headers = { 'Content-Type': 'image/jpeg', 'x-amz-tagging': 'visibility=pending' }
        let finished = false
        const result = uploadFileToS3('https://upload.test/signed', file, headers, { onProgress }).then(response => { finished = true; return response })
        await vi.dynamicImportSettled()
        const xhr = requests[0]
        expect(xhr.open).toHaveBeenCalledWith('PUT', 'https://upload.test/signed')
        expect(xhr.headers).toEqual(headers)
        expect(xhr.send).toHaveBeenCalledWith(file)
        expect(onProgress).toHaveBeenLastCalledWith({ loaded: 0, total: 10 })
        xhr.upload.onprogress({ loaded: 5 })
        expect(onProgress).toHaveBeenLastCalledWith({ loaded: 5, total: 10 })
        xhr.upload.onprogress({ loaded: 10 })
        await Promise.resolve()
        expect(finished).toBe(false)
        xhr.onload()
        const response = await result
        expect(response.ok).toBe(true)
        expect(response.headers.get('etag')).toBe('"example"')
        expect(onProgress).toHaveBeenLastCalledWith({ loaded: 10, total: 10 })
    })

    it('restarts progress for one network retry and preserves HTTP failure handling', async () => {
        vi.useFakeTimers()
        const onProgress = vi.fn()
        const file = new File(['abc'], 'x.jpg', { type: 'image/jpeg' })
        const result = uploadFileToS3('https://upload.test', file, {}, { onProgress })
        const rejected = expect(result).rejects.toMatchObject({ code: 'UPLOAD_FAILED', status: 403 })
        await vi.dynamicImportSettled()
        requests[0].upload.onprogress({ loaded: 2 })
        requests[0].onerror()
        await vi.advanceTimersByTimeAsync(601)
        expect(requests).toHaveLength(2)
        expect(onProgress).toHaveBeenLastCalledWith({ loaded: 0, total: 3 })
        expect(requests[1].headers).toEqual({ 'Content-Type': 'image/jpeg' })
        requests[1].status = 403
        requests[1].onload()
        await rejected
    })

    it('retries retryable HTTP responses and reports exhausted connection errors', async () => {
        vi.useFakeTimers()
        const result = uploadFileToS3('https://upload.test', new Blob(['abc']), {}, { onProgress: vi.fn() })
        const rejected = expect(result).rejects.toMatchObject({ code: 'UPLOAD_NETWORK_ERROR' })
        await vi.dynamicImportSettled()
        requests[0].status = 503
        requests[0].onload()
        await vi.advanceTimersByTimeAsync(601)
        requests[1].ontimeout()
        await rejected
    })

    it('cancels in-flight requests without retrying and rejects pre-aborted requests', async () => {
        const controller = new AbortController()
        const remove = vi.spyOn(controller.signal, 'removeEventListener')
        const options = { signal: controller.signal, onProgress: vi.fn() }
        const result = uploadFileToS3('https://upload.test', new Blob(['abc']), {}, options)
        const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
        await vi.dynamicImportSettled()
        controller.abort()
        await rejected
        expect(requests[0].abort).toHaveBeenCalledOnce()
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
        await expect(uploadFileToS3('https://upload.test', new Blob(['abc']), {}, options)).rejects.toMatchObject({ name: 'AbortError' })
        expect(requests).toHaveLength(1)
    })

    it('does not start a transfer when cancelled while loading the upload transport', async () => {
        const controller = new AbortController()
        const result = uploadFileToS3('https://upload.test', new Blob(['abc']), {}, {
            signal: controller.signal, onProgress: vi.fn(),
        })
        controller.abort()
        await expect(result).rejects.toMatchObject({ name: 'AbortError' })
        expect(requests).toHaveLength(0)
    })
})

describe('uploads without a visible progress meter', () => {
    beforeEach(() => { requests = []; vi.stubGlobal('XMLHttpRequest', TestXHR); vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
    it('bounds a stalled hero/thumbnail transfer and preserves the signed ETag response', async () => {
        const file = new File(['photo'], 'hero.jpg', { type: 'image/jpeg' })
        const result = uploadFileToS3('https://upload.test', file, {}, { retries: 0, stallTimeoutMs: 1000 })
        const rejected = expect(result).rejects.toMatchObject({ code: 'UPLOAD_NETWORK_ERROR' })
        await vi.dynamicImportSettled()
        await vi.advanceTimersByTimeAsync(1000)
        await rejected
        expect(requests[0].abort).toHaveBeenCalledOnce()
        const retry = uploadFileToS3('https://upload.test', file)
        await vi.dynamicImportSettled()
        requests[1].onload()
        expect((await retry).headers.get('etag')).toBe('"example"')
        expect(vi.getTimerCount()).toBe(0)
    })
    it('allows a slow transfer while bytes advance, then bounds waiting for its receipt', async () => {
        const result = uploadFileToS3('https://upload.test', new Blob(['12345']), {}, { retries: 0, stallTimeoutMs: 1000 })
        const rejected = expect(result).rejects.toMatchObject({ code: 'UPLOAD_NETWORK_ERROR' })
        await vi.dynamicImportSettled()
        for (let loaded = 1; loaded <= 5; loaded++) {
            await vi.advanceTimersByTimeAsync(900)
            requests[0].upload.onprogress({ loaded })
            expect(requests[0].abort).not.toHaveBeenCalled()
        }
        requests[0].upload.onload()
        await vi.advanceTimersByTimeAsync(1000)
        await rejected
    })
})
