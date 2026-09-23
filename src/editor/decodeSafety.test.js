import { afterEach, expect, it, vi } from 'vitest'
import { decodeBudget, validateDimensions } from './decodeSafety'
import { rawWorkerClient } from './rawWorkerClient'
import { decodeStandardFile } from './standardDecoder'

vi.mock('exifr', () => ({ parse: vi.fn(async () => null) }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('rejects unsafe dimensions and file sizes while preserving ordinary full resolution', () => {
    expect(validateDimensions(8192, 5464)).toBe(8192 * 5464)
    for (const size of [[0, 20], [32768, 1], [12000, 12000], [NaN, 1], [1.5, 20]]) expect(() => validateDimensions(...size)).toThrow(/large/)
    for (const size of [undefined, 0, 501 * 1024 * 1024]) expect(() => decodeBudget({ size })).toThrow(/limit/)
})

it('times out unanswered decoding and closes a bitmap that arrives after cancellation', async () => {
    vi.useFakeTimers()
    const budget = decodeBudget({ size: 1 }, { timeoutMs: 20 })
    let finish
    const close = vi.fn()
    const pending = budget.wait(new Promise(resolve => { finish = resolve }), value => value.close())
    const rejected = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    finish({ close })
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
    budget.close()
    expect(vi.getTimerCount()).toBe(0)
})

it.each(['onerror', 'onmessageerror', 'abort'])('terminates the RAW worker and settles every request on %s', async kind => {
    let worker
    vi.stubGlobal('Worker', class { constructor() { worker = this }; terminate = vi.fn(); postMessage = vi.fn() })
    const controller = new AbortController()
    const client = rawWorkerClient('worker.js', controller.signal)
    const one = expect(client.send({ type: 'init' })).rejects.toBeInstanceOf(Error)
    const two = expect(client.send({ type: 'load' })).rejects.toBeInstanceOf(Error)
    if (kind === 'abort') controller.abort(); else worker[kind]()
    await Promise.all([one, two])
    expect(worker.terminate).toHaveBeenCalledOnce()
    await expect(client.send({ type: 'process' })).rejects.toBeInstanceOf(Error)
    client.dispose()
    expect(worker.terminate).toHaveBeenCalledOnce()
})

it('matches RAW worker replies and transfers bytes using the existing protocol', async () => {
    let worker
    vi.stubGlobal('Worker', class { constructor() { worker = this }; terminate = vi.fn(); postMessage = vi.fn() })
    const client = rawWorkerClient('worker.js', new AbortController().signal)
    const bytes = new ArrayBuffer(4)
    const result = client.send({ type: 'load', data: bytes }, [bytes])
    expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, type: 'load', data: bytes }, [bytes])
    worker.onmessage({ data: { id: 55, type: 'result', result: 'ignored' } })
    worker.onmessage({ data: { id: 1, type: 'result', result: { width: 2, height: 2 } } })
    await expect(result).resolves.toEqual({ width: 2, height: 2 })
    const failed = client.send({ type: 'process' })
    worker.onmessage({ data: { id: 2, type: 'error', error: 'invalid RAW' } })
    await expect(failed).rejects.toThrow('invalid RAW')
    worker.postMessage.mockImplementation(() => { throw new Error('clone failed') })
    await expect(client.send({ type: 'load' })).rejects.toThrow('clone failed')
    client.dispose()
})

it('closes oversized standard bitmaps before allocating a canvas', async () => {
    const bitmap = { width: 12000, height: 12000, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    const canvas = vi.spyOn(document, 'createElement')
    await expect(decodeStandardFile(new File(['image'], 'photo.png'))).rejects.toThrow(/large/)
    expect(canvas).not.toHaveBeenCalled()
    expect(bitmap.close).toHaveBeenCalledOnce()
    canvas.mockRestore()
})

it('does not start a standard decode after cancellation', async () => {
    const controller = new AbortController(); controller.abort()
    vi.stubGlobal('createImageBitmap', vi.fn())
    await expect(decodeStandardFile(new File(['image'], 'photo.png'), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(createImageBitmap).not.toHaveBeenCalled()
})
