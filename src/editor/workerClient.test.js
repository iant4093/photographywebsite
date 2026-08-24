import { afterEach, describe, expect, it, vi } from 'vitest'
import { workerRequest } from './workerClient'

class FakeWorker {
    constructor() {
        this.listeners = new Map()
    }

    addEventListener(type, listener) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener])
    }

    removeEventListener(type, listener) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter((candidate) => candidate !== listener))
    }

    emit(type, event) {
        for (const listener of this.listeners.get(type) || []) listener(event)
    }

    postMessage(message) {
        this.message = message
    }
}

const source = { width: 1, height: 1, pixels: new Uint8ClampedArray([1, 2, 3, 255]) }

describe('editor worker client', () => {
    afterEach(() => vi.useRealTimers())

    it('resolves the matching worker response and removes listeners', async () => {
        const worker = new FakeWorker()
        const onProgress = vi.fn()
        const request = workerRequest(worker, source, { exposure: 1 }, false, { reportProgress: true, onProgress })
        worker.emit('message', { data: { id: 'another-request' } })
        worker.emit('message', { data: { id: worker.message.id, progress: 0.45 } })
        expect(onProgress).toHaveBeenCalledWith(0.45)
        expect(worker.message.reportProgress).toBe(true)
        worker.emit('message', { data: { id: worker.message.id, pixels: new ArrayBuffer(4) } })
        await expect(request).resolves.toMatchObject({ id: worker.message.id })
        expect([...worker.listeners.values()].every((listeners) => listeners.length === 0)).toBe(true)
    })

    it('rejects worker crashes and unreadable messages instead of hanging', async () => {
        const crashedWorker = new FakeWorker()
        const crashed = workerRequest(crashedWorker, source, {})
        crashedWorker.emit('error', { message: 'worker crashed' })
        await expect(crashed).rejects.toThrow('worker crashed')

        const messageWorker = new FakeWorker()
        const unreadable = workerRequest(messageWorker, source, {})
        messageWorker.emit('messageerror', {})
        await expect(unreadable).rejects.toThrow('could not be read')
    })

    it('supports cancellation and a finite timeout', async () => {
        const controller = new AbortController()
        const cancelled = workerRequest(new FakeWorker(), source, {}, false, { signal: controller.signal })
        controller.abort()
        await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })

        vi.useFakeTimers()
        const timedOut = workerRequest(new FakeWorker(), source, {}, false, { timeoutMs: 50 })
        const timedOutExpectation = expect(timedOut).rejects.toThrow('timed out')
        await vi.advanceTimersByTimeAsync(50)
        await timedOutExpectation
    })
})
