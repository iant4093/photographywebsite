import { describe, expect, it } from 'vitest'
import { calculateHistogram, freshAdjustments, processImagePixels, sanitizeAdjustments, sanitizeGeometry } from './adjustments'

describe('browser editor adjustments', () => {
    it('creates independent nested defaults', () => {
        const first = freshAdjustments()
        const second = freshAdjustments()
        first.hsl.red.hue = 45
        expect(second.hsl.red.hue).toBe(0)
    })

    it('sanitizes imported controls and crop bounds', () => {
        const controls = sanitizeAdjustments({ exposure: '2', hsl: { blue: { saturation: 500 } }, curve: [0, 20, 50, 80, 100] })
        expect(controls.exposure).toBe(2)
        expect(controls.hsl.blue.saturation).toBe(100)
        expect(sanitizeAdjustments({ curve: [0, 80, 20, 90, 100] }).curve).toEqual([0, 80, 80, 90, 100])
        const geometry = sanitizeGeometry({ crop: { x: 0.8, y: 0.8, width: 0.8, height: 0.8 } })
        expect(geometry.crop.width).toBeCloseTo(0.2)
        expect(geometry.crop.height).toBeCloseTo(0.2)
    })

    it('applies exposure and preserves alpha', () => {
        const pixels = new Uint8ClampedArray([40, 50, 60, 128, 200, 180, 160, 255])
        const output = processImagePixels(pixels, 2, 1, { ...freshAdjustments(), exposure: 1 })
        expect(output[0]).toBeGreaterThan(40)
        expect(output[4]).toBeGreaterThanOrEqual(200)
        expect(output[3]).toBe(128)
        expect(output[7]).toBe(255)
    })

    it('creates deterministic grain and clipping indicators', () => {
        const pixels = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])
        const first = processImagePixels(pixels, 2, 1, { ...freshAdjustments(), grain: 30 })
        const second = processImagePixels(pixels, 2, 1, { ...freshAdjustments(), grain: 30 })
        expect(first).toEqual(second)
        const clipped = processImagePixels(pixels, 2, 1, freshAdjustments(), { clipping: true })
        expect([...clipped.slice(0, 3)]).toEqual([255, 45, 35])
        expect([...clipped.slice(4, 7)]).toEqual([25, 100, 255])
    })

    it('builds four 64-bin histograms', () => {
        const histogram = calculateHistogram(new Uint8ClampedArray([0, 128, 255, 255, 255, 128, 0, 255]))
        expect(histogram.red).toHaveLength(64)
        expect(histogram.red.reduce((sum, value) => sum + value, 0)).toBe(2)
        expect(histogram.blue[63]).toBe(1)
    })
})
