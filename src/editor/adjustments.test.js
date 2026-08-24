import { describe, expect, it } from 'vitest'
import { calculateHistogram, freshAdjustments, prewarmSpatialCache, processImagePixels, sanitizeAdjustments, sanitizeGeometry } from './adjustments'

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
        expect(controls.curve).toEqual([
            { x: 0, y: 0 }, { x: 25, y: 20 }, { x: 50, y: 50 }, { x: 75, y: 80 }, { x: 100, y: 100 },
        ])
        expect(sanitizeAdjustments({ curve: [{ x: 0, y: 5 }, { x: 34, y: 80 }, { x: 68, y: 20 }, { x: 100, y: 96 }] }).curve).toEqual([
            { x: 0, y: 5 }, { x: 34, y: 80 }, { x: 68, y: 20 }, { x: 100, y: 96 },
        ])
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

    it('copies untouched pixels exactly and reports bounded processing progress', () => {
        const pixels = new Uint8ClampedArray([12, 34, 56, 78, 210, 190, 170, 255])
        const progress = []
        const output = processImagePixels(pixels, 2, 1, freshAdjustments(), { onProgress: (value) => progress.push(value) })
        expect(output).toEqual(pixels)
        expect(output).not.toBe(pixels)
        expect(progress.at(-1)).toBe(1)
        expect(progress.every((value) => value >= 0 && value <= 1)).toBe(true)
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

    it('processes every adjustment family together', () => {
        const settings = freshAdjustments()
        Object.assign(settings, {
            exposure: 0.4, contrast: 18, highlights: -22, shadows: 27, whites: 9, blacks: -11,
            gamma: 1.1, temperature: 14, tint: -8, vibrance: 21, saturation: 12,
            curve: [4, 28, 53, 79, 98], texture: 20, clarity: 16, dehaze: 9,
            sharpening: 24, sharpeningRadius: 2, sharpeningDetail: 48,
            noiseLuminance: 12, noiseColor: 8, vignette: -18, grain: 11,
        })
        for (const channel of Object.keys(settings.hsl)) {
            settings.hsl[channel] = { hue: 6, saturation: 9, luminance: 4 }
            settings.bwMixer[channel] = 5
        }
        for (const range of Object.keys(settings.grading)) settings.grading[range].saturation = 15
        const pixels = new Uint8ClampedArray([
            15, 30, 45, 255, 75, 95, 125, 255, 210, 180, 150, 255,
            25, 180, 70, 255, 170, 30, 110, 255, 65, 85, 225, 255,
            245, 215, 55, 255, 100, 100, 100, 255, 5, 5, 5, 255,
        ])
        const color = processImagePixels(pixels, 3, 3, settings)
        expect(color).toHaveLength(pixels.length)
        expect(color).not.toEqual(pixels)
        settings.blackAndWhite = true
        const monochrome = processImagePixels(pixels, 3, 3, settings)
        expect(monochrome[0]).toBe(monochrome[1])
        expect(monochrome[1]).toBe(monochrome[2])
    })

    it('builds four 64-bin histograms', () => {
        const histogram = calculateHistogram(new Uint8ClampedArray([0, 128, 255, 255, 255, 128, 0, 255]))
        expect(histogram.red).toHaveLength(64)
        expect(histogram.red.reduce((sum, value) => sum + value, 0)).toBe(2)
        expect(histogram.blue[63]).toBe(1)
    })

    it('reuses source blur maps across repeated preview renders', () => {
        const pixels = new Uint8ClampedArray(6 * 6 * 4).fill(128)
        const spatialCache = new Map()
        processImagePixels(pixels, 6, 6, { ...freshAdjustments(), clarity: 20 }, { spatialCache })
        const cachedBlur = spatialCache.get('6x6:r5')
        expect(cachedBlur).toBeInstanceOf(Uint8ClampedArray)
        processImagePixels(pixels, 6, 6, { ...freshAdjustments(), clarity: 40 }, { spatialCache })
        expect(spatialCache.size).toBe(1)
        expect(spatialCache.get('6x6:r5')).toBe(cachedBlur)
    })

    it('prewarms the common fine and broad source blurs', () => {
        const pixels = new Uint8ClampedArray(6 * 6 * 4).fill(128)
        const cache = prewarmSpatialCache(pixels, 6, 6)
        expect([...cache.keys()]).toEqual(['6x6:r1', '6x6:r5'])
        const fine = cache.get('6x6:r1')
        prewarmSpatialCache(pixels, 6, 6, [1], cache)
        expect(cache.get('6x6:r1')).toBe(fine)
    })
})
