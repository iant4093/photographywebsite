import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { freshAdjustments } from './adjustments'

const pixels = () => new Uint8ClampedArray([20, 40, 60, 255]).buffer

describe('editor preview worker', () => {
    let originalPostMessage
    let originalOnMessage

    beforeAll(async () => {
        originalPostMessage = self.postMessage
        originalOnMessage = self.onmessage
        self.postMessage = vi.fn()
        await import('./editorWorker')
    })

    afterAll(() => {
        self.postMessage = originalPostMessage
        self.onmessage = originalOnMessage
        vi.unstubAllGlobals()
    })

    const send = (message) => {
        self.postMessage.mockClear()
        self.onmessage({ data: { width: 1, height: 1, adjustments: freshAdjustments(), clipping: false, ...message } })
        return self.postMessage.mock.calls.map(([payload]) => payload)
    }

    it('retains named sources, reports progress, and evicts old preview data', () => {
        let messages = send({ id: 'first', sourceId: 'full', pixels: pixels(), reportProgress: true, includeHistogram: false })
        expect(messages.some((message) => Number.isFinite(message.progress))).toBe(true)
        expect(messages.at(-1)).toMatchObject({ id: 'first', histogram: null, width: 1, height: 1 })
        expect(messages.at(-1).pixels).toBeInstanceOf(ArrayBuffer)

        messages = send({ id: 'repeat', sourceId: 'full' })
        expect(messages.at(-1).histogram.luma).toHaveLength(64)

        messages = send({ id: 'temporary', pixels: pixels() })
        expect(messages.at(-1).pixels).toBeInstanceOf(ArrayBuffer)

        for (let index = 0; index < 5; index += 1) {
            send({ id: `source-${index}`, sourceId: `source-${index}`, pixels: pixels() })
        }
        messages = send({ id: 'evicted', sourceId: 'full' })
        expect(messages.at(-1).error).toBe('The preview source is no longer available.')
    })

    it('returns an ImageBitmap when worker canvas support is available', () => {
        const bitmap = { close: vi.fn() }
        class ImageDataStub {
            constructor(data, width, height) {
                this.data = data
                this.width = width
                this.height = height
            }
        }
        class OffscreenCanvasStub {
            getContext() { return { putImageData: vi.fn() } }
            transferToImageBitmap() { return bitmap }
        }
        vi.stubGlobal('ImageData', ImageDataStub)
        vi.stubGlobal('OffscreenCanvas', OffscreenCanvasStub)
        const messages = send({ id: 'bitmap', pixels: pixels(), outputType: 'bitmap' })
        expect(messages.at(-1)).toMatchObject({ id: 'bitmap', bitmap, width: 1, height: 1 })
        expect(messages.at(-1).pixels).toBeUndefined()
    })

    it('falls back to pixels when an offscreen canvas cannot provide a context', () => {
        class OffscreenCanvasStub {
            getContext() { return null }
        }
        vi.stubGlobal('OffscreenCanvas', OffscreenCanvasStub)
        const messages = send({ id: 'fallback', pixels: pixels(), outputType: 'bitmap' })
        expect(messages.at(-1).pixels).toBeInstanceOf(ArrayBuffer)
    })
})
