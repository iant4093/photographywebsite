import { describe, expect, it } from 'vitest'
import { freshAdjustments, freshGeometry } from './adjustments'
import { applyPreset, BUILT_IN_PRESETS, parseSidecar, serializeSidecar } from './presets'

describe('editor presets and sidecars', () => {
    it('applies a built-in preset without mutating current settings', () => {
        const current = freshAdjustments()
        const result = applyPreset('Kodak Portra 400', current)
        expect(result.temperature).toBe(7)
        expect(current.temperature).toBe(0)
    })

    it('offers ten film stocks and retires the generic defaults', () => {
        expect(Object.keys(BUILT_IN_PRESETS)).toEqual([
            'Kodak Portra 400', 'Kodak Portra 800', 'Kodak Gold 200', 'Kodak Ektar 100',
            'Fujifilm Pro 400H', 'Fujifilm Velvia 50', 'Fujifilm Superia 400', 'Cinestill 800T',
            'Kodak Tri-X 400', 'Ilford HP5 Plus',
        ])
        expect(BUILT_IN_PRESETS).not.toHaveProperty('Clean')
        expect(BUILT_IN_PRESETS).not.toHaveProperty('Warm Portrait')
    })

    it('fully replaces a previous built-in film look when switching stocks', () => {
        const monochrome = applyPreset('Kodak Tri-X 400')
        expect(monochrome.blackAndWhite).toBe(true)

        const color = applyPreset('Fujifilm Pro 400H', monochrome)
        expect(color.blackAndWhite).toBe(false)
        expect(color.bwMixer.blue).toBe(0)
        expect(color.grain).toBe(10)
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
