import { describe, expect, it, vi } from 'vitest'
import { canvasToBlob, cropForAspect, dimensionsForGeometry, drawGeometry, outputDimensions } from './canvas'
import { freshGeometry } from './adjustments'

describe('editor geometry', () => {
    it('calculates normalized aspect crops', () => {
        const square = cropForAspect(6000, 4000, '1:1')
        expect(square.x).toBeCloseTo(1 / 6)
        expect(square.width).toBeCloseTo(2 / 3)
        expect(square.y).toBe(0)
        expect(square.height).toBe(1)
        expect(cropForAspect(4000, 6000, '16:9').width).toBe(1)
        expect(cropForAspect(4000, 6000, '16:9').height).toBeCloseTo(0.375)
    })

    it('swaps output dimensions after a quarter turn', () => {
        const geometry = { ...freshGeometry(), crop: { x: 0, y: 0, width: 0.5, height: 1 }, quarterTurns: 1 }
        expect(dimensionsForGeometry(6000, 4000, geometry)).toEqual({ width: 4000, height: 3000 })
    })

    it('preserves ratio for long-edge and width exports', () => {
        const geometry = freshGeometry()
        expect(outputDimensions(6000, 4000, geometry)).toEqual({ width: 6000, height: 4000 })
        expect(outputDimensions(6000, 4000, geometry, { mode: 'longEdge', value: 3000 })).toEqual({ width: 3000, height: 2000 })
        expect(outputDimensions(6000, 4000, geometry, { mode: 'width', value: 1200 })).toEqual({ width: 1200, height: 800 })
        expect(outputDimensions(6000, 4000, geometry, { mode: 'height', value: 1000 })).toEqual({ width: 1500, height: 1000 })
    })

    it('handles free, original, invalid, and portrait aspect requests', () => {
        const unchanged = { x: 0, y: 0, width: 1, height: 1 }
        expect(cropForAspect(100, 50, 'free')).toEqual(unchanged)
        expect(cropForAspect(100, 50, 'original')).toEqual(unchanged)
        expect(cropForAspect(100, 50, 'bad')).toEqual(unchanged)
        const portrait = cropForAspect(100, 200, '1:1')
        expect(portrait).toEqual({ x: 0, y: 0.25, width: 1, height: 0.5 })
    })

    it('draws transformed geometry into a bounded canvas', () => {
        const context = Object.fromEntries(['save', 'fillRect', 'translate', 'scale', 'rotate', 'transform', 'drawImage', 'restore'].map((name) => [name, vi.fn()]))
        const target = { width: 0, height: 0, getContext: vi.fn(() => context) }
        const source = { width: 800, height: 600 }
        const geometry = {
            ...freshGeometry(),
            crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 },
            quarterTurns: -1,
            rotation: 2,
            flipX: true,
            flipY: true,
            horizontal: 4,
            vertical: -3,
        }
        expect(drawGeometry(source, target, geometry, 150, 200)).toBe(target)
        expect(target).toMatchObject({ width: 150, height: 200 })
        expect(context.scale).toHaveBeenCalledWith(-1, -1)
        expect(context.drawImage).toHaveBeenCalledOnce()
    })

    it('resolves or rejects canvas encoding', async () => {
        const blob = new Blob(['image'], { type: 'image/webp' })
        await expect(canvasToBlob({ toBlob: (callback) => callback(blob) }, 'image/webp', 0.9)).resolves.toBe(blob)
        await expect(canvasToBlob({ toBlob: (callback) => callback(null) }, 'image/webp', 0.9)).rejects.toThrow('could not encode')
    })
})
