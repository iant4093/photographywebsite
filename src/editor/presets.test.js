import { describe, expect, it } from 'vitest'
import { freshAdjustments, freshGeometry } from './adjustments'
import { applyPreset, BUILT_IN_PRESETS, parseSettings, serializeSettings } from './presets'

describe('editor presets and clipboard settings', () => {
    it('applies a built-in preset without mutating current settings', () => {
        const current = freshAdjustments()
        const result = applyPreset('Kodak Portra 400', current)
        expect(result.temperature).toBe(7)
        expect(current.temperature).toBe(0)
    })

    it('offers sixteen film stocks and retires the generic defaults', () => {
        expect(Object.keys(BUILT_IN_PRESETS)).toEqual([
            'Kodak Portra 400', 'Kodak Portra 800', 'Kodak Gold 200', 'Kodak Ektar 100',
            'Fujifilm Pro 400H', 'Fujifilm Velvia 50', 'Fujifilm Superia 400', 'Cinestill 800T',
            'CineStill 50D', 'Kodak ColorPlus 200', 'Kodak Ultramax 400',
            'Kodak Tri-X 400', 'Ilford HP5 Plus', 'Kodak T-Max 400',
            'Fujifilm Neopan Acros 100', 'Ilford Delta 3200',
        ])
        expect(BUILT_IN_PRESETS).not.toHaveProperty('Clean')
        expect(BUILT_IN_PRESETS).not.toHaveProperty('Warm Portrait')
    })

    it('keeps the additional color and monochrome film stocks distinct', () => {
        expect(BUILT_IN_PRESETS['CineStill 50D'].blackAndWhite).toBe(false)
        expect(BUILT_IN_PRESETS['Kodak ColorPlus 200'].temperature).toBeGreaterThan(0)
        expect(BUILT_IN_PRESETS['Kodak T-Max 400'].blackAndWhite).toBe(true)
        expect(BUILT_IN_PRESETS['Fujifilm Neopan Acros 100'].blackAndWhite).toBe(true)
        expect(BUILT_IN_PRESETS['Ilford Delta 3200'].grain)
            .toBeGreaterThan(BUILT_IN_PRESETS['Fujifilm Neopan Acros 100'].grain)
    })

    it('fully replaces a previous built-in film look when switching stocks', () => {
        const monochrome = applyPreset('Kodak Tri-X 400')
        expect(monochrome.blackAndWhite).toBe(true)

        const color = applyPreset('Fujifilm Pro 400H', monochrome)
        expect(color.blackAndWhite).toBe(false)
        expect(color.bwMixer.blue).toBe(0)
        expect(color.grain).toBe(10)
    })

    it('round-trips clipboard settings', () => {
        const text = serializeSettings({ ...freshAdjustments(), exposure: 1.25 }, freshGeometry())
        const parsed = parseSettings(text)
        expect(parsed.adjustments.exposure).toBe(1.25)
        expect(parsed.geometry).toEqual(freshGeometry())
    })

    it('rejects unrelated JSON settings', () => {
        expect(() => parseSettings('{"schema":"other"}')).toThrow(/not supported/i)
    })
})
