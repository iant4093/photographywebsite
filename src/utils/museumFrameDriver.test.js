import { describe, expect, it, vi } from 'vitest'
import { createMuseumFrameDriver } from './museumFrameDriver'

function frameHarness() {
    let nextId = 1
    const callbacks = new Map()
    return {
        cancelFrame: vi.fn(id => callbacks.delete(id)),
        fire(id, timestamp) {
            const callback = callbacks.get(id)
            callbacks.delete(id)
            callback?.(timestamp)
        },
        pendingIds: () => [...callbacks.keys()],
        requestFrame: vi.fn(callback => {
            const id = nextId
            nextId += 1
            callbacks.set(id, callback)
            return id
        }),
    }
}

describe('museum frame driver', () => {
    it('runs continuously only while the experience requests it', () => {
        const frames = frameHarness()
        const advance = vi.fn()
        const driver = createMuseumFrameDriver({ ...frames, advance })

        driver.setContinuous(true)
        const first = frames.pendingIds()[0]
        frames.fire(first, 1000)
        expect(advance).toHaveBeenCalledTimes(1)
        expect(frames.pendingIds()).toHaveLength(1)

        driver.setContinuous(false)
        frames.fire(frames.pendingIds()[0], 1016)
        expect(advance).toHaveBeenCalledTimes(2)
        expect(frames.pendingIds()).toHaveLength(0)
    })

    it('replaces a discarded browser callback when the page resumes', () => {
        const frames = frameHarness()
        const advance = vi.fn()
        const driver = createMuseumFrameDriver({ ...frames, advance })

        driver.request()
        const discardedId = frames.pendingIds()[0]
        driver.resume(2)
        const replacementId = frames.pendingIds()[0]

        expect(replacementId).not.toBe(discardedId)
        expect(frames.cancelFrame).toHaveBeenCalledWith(discardedId)
        frames.fire(replacementId, 5000)
        expect(advance).toHaveBeenCalledTimes(1)
    })

    it('excludes hidden wall time from animation deltas', () => {
        const frames = frameHarness()
        const logicalTimes = []
        const driver = createMuseumFrameDriver({
            ...frames,
            advance: time => logicalTimes.push(time),
            initialTime: 4,
        })

        driver.request()
        frames.fire(frames.pendingIds()[0], 1000)
        driver.suspend()
        driver.resume()
        frames.fire(frames.pendingIds()[0], 301000)

        expect(logicalTimes[0] - 4).toBeCloseTo(1 / 60, 6)
        expect(logicalTimes[1] - logicalTimes[0]).toBeCloseTo(1 / 60, 6)
    })

    it('retains requested settling work while hidden', () => {
        const frames = frameHarness()
        let visible = false
        const advance = vi.fn()
        const driver = createMuseumFrameDriver({
            ...frames,
            advance,
            isVisible: () => visible,
        })

        driver.request(2)
        expect(frames.pendingIds()).toHaveLength(0)
        visible = true
        driver.resume(2)
        frames.fire(frames.pendingIds()[0], 100)
        frames.fire(frames.pendingIds()[0], 116)
        expect(advance).toHaveBeenCalledTimes(2)
    })
})
