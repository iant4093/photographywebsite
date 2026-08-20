import { describe, expect, it } from 'vitest'
import { freshAdjustments, freshGeometry } from './adjustments'
import { applyPreset, parseSidecar, serializeSidecar } from './presets'

describe('editor presets and sidecars', () => {
    it('applies a built-in preset without mutating current settings', () => {
        const current = freshAdjustments()
        const result = applyPreset('Warm Portrait', current)
        expect(result.temperature).toBe(18)
        expect(current.temperature).toBe(0)
    })

    it('round-trips versioned local sidecars', () => {
        const text = serializeSidecar({ ...freshAdjustments(), exposure: 1.25 }, freshGeometry(), 'photo.cr3')
        const parsed = parseSidecar(text)
        expect(parsed.schema).toBe('ian-truong-photo-editor/v1')
        expect(parsed.adjustments.exposure).toBe(1.25)
        expect(parsed.sourceName).toBe('photo.cr3')
    })

    it('rejects unrelated JSON settings', () => {
        expect(() => parseSidecar('{"schema":"other"}')).toThrow(/not a supported/i)
    })
})
