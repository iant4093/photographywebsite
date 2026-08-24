import { freshAdjustments, sanitizeAdjustments } from './adjustments'

const filmPreset = (settings) => sanitizeAdjustments(settings)

export const BUILT_IN_PRESETS = Object.freeze({
    'Kodak Portra 400': filmPreset({
        contrast: -6, highlights: -18, shadows: 12, whites: -4, blacks: 8,
        temperature: 7, tint: 4, vibrance: -4, saturation: -6,
        curve: [{ x: 0, y: 5 }, { x: 20, y: 22 }, { x: 50, y: 51 }, { x: 78, y: 77 }, { x: 100, y: 96 }],
        hsl: {
            orange: { saturation: -4, luminance: 7 }, yellow: { saturation: -12, luminance: 3 },
            green: { hue: 8, saturation: -18 }, aqua: { saturation: -8 }, blue: { saturation: -10, luminance: 5 },
        },
        grading: { shadows: { hue: 205, saturation: 4 }, highlights: { hue: 42, saturation: 6 } },
        texture: -3, clarity: -4, grain: 12, vignette: -5,
    }),
    'Kodak Portra 800': filmPreset({
        exposure: 0.1, contrast: -4, highlights: -22, shadows: 16, whites: -3, blacks: 10,
        temperature: 12, tint: 6, vibrance: 2, saturation: -4,
        curve: [{ x: 0, y: 7 }, { x: 20, y: 23 }, { x: 50, y: 51 }, { x: 78, y: 76 }, { x: 100, y: 95 }],
        hsl: {
            red: { saturation: -3, luminance: 3 }, orange: { saturation: -2, luminance: 8 },
            yellow: { saturation: -14, luminance: 3 }, green: { hue: 10, saturation: -20 },
            aqua: { saturation: -10 }, blue: { saturation: -12, luminance: 4 },
        },
        grading: {
            shadows: { hue: 210, saturation: 5 }, midtones: { hue: 25, saturation: 4 },
            highlights: { hue: 40, saturation: 9 },
        },
        texture: -4, clarity: -5, noiseLuminance: 3, grain: 22, vignette: -7,
    }),
    'Kodak Gold 200': filmPreset({
        contrast: 8, highlights: -12, shadows: 5, whites: 6, blacks: 3,
        temperature: 14, tint: 2, vibrance: 14, saturation: 5,
        curve: [{ x: 0, y: 4 }, { x: 22, y: 20 }, { x: 50, y: 50 }, { x: 78, y: 81 }, { x: 100, y: 98 }],
        hsl: {
            red: { saturation: 4 }, orange: { hue: -3, saturation: 5, luminance: 4 },
            yellow: { hue: -7, saturation: 7, luminance: 2 }, green: { hue: -8, saturation: -12 },
            aqua: { saturation: -8 }, blue: { hue: -5, saturation: -10, luminance: -2 },
        },
        grading: { shadows: { hue: 205, saturation: 4 }, highlights: { hue: 45, saturation: 10 } },
        texture: 2, clarity: 1, grain: 16, vignette: -8,
    }),
    'Kodak Ektar 100': filmPreset({
        contrast: 18, highlights: -10, shadows: -4, whites: 8, blacks: -8,
        temperature: 4, tint: 4, vibrance: 18, saturation: 10,
        curve: [{ x: 0, y: 1 }, { x: 20, y: 15 }, { x: 50, y: 50 }, { x: 80, y: 85 }, { x: 100, y: 100 }],
        hsl: {
            red: { saturation: 12, luminance: -2 }, orange: { saturation: 7, luminance: 2 },
            yellow: { saturation: 5 }, green: { saturation: 5, luminance: -2 },
            aqua: { saturation: 8 }, blue: { saturation: 14, luminance: -5 }, magenta: { saturation: 8 },
        },
        grading: { shadows: { hue: 215, saturation: 4 }, highlights: { hue: 30, saturation: 3 } },
        clarity: 5, dehaze: 4, sharpening: 20, grain: 7, vignette: -6,
    }),
    'Fujifilm Pro 400H': filmPreset({
        exposure: 0.15, contrast: -12, highlights: -24, shadows: 18, whites: -4, blacks: 12,
        temperature: -3, tint: 6, vibrance: -6, saturation: -10,
        curve: [{ x: 0, y: 8 }, { x: 22, y: 25 }, { x: 50, y: 53 }, { x: 78, y: 78 }, { x: 100, y: 96 }],
        hsl: {
            red: { saturation: -6, luminance: 4 }, orange: { saturation: -8, luminance: 8 },
            yellow: { hue: 7, saturation: -18, luminance: 7 }, green: { hue: 18, saturation: -22, luminance: 12 },
            aqua: { hue: -6, saturation: -10, luminance: 7 }, blue: { saturation: -14, luminance: 8 },
        },
        grading: { shadows: { hue: 165, saturation: 7 }, highlights: { hue: 45, saturation: 5 } },
        texture: -5, clarity: -7, grain: 10, vignette: -4,
    }),
    'Fujifilm Velvia 50': filmPreset({
        contrast: 22, highlights: -10, shadows: -8, whites: 10, blacks: -12,
        temperature: 2, tint: 3, vibrance: 30, saturation: 16,
        curve: [{ x: 0, y: 0 }, { x: 20, y: 14 }, { x: 50, y: 49 }, { x: 80, y: 87 }, { x: 100, y: 100 }],
        hsl: {
            red: { saturation: 12 }, orange: { saturation: 8 }, yellow: { saturation: 10 },
            green: { hue: -5, saturation: 18, luminance: -5 }, aqua: { saturation: 16, luminance: -4 },
            blue: { hue: -4, saturation: 20, luminance: -8 }, purple: { saturation: 12 }, magenta: { saturation: 10 },
        },
        grading: { shadows: { hue: 220, saturation: 4 }, highlights: { hue: 38, saturation: 3 } },
        clarity: 8, dehaze: 10, sharpening: 18, grain: 5, vignette: -8,
    }),
    'Fujifilm Superia 400': filmPreset({
        contrast: 8, highlights: -15, shadows: 10, whites: -2, blacks: 2,
        temperature: -5, tint: -2, vibrance: 8, saturation: 2,
        curve: [{ x: 0, y: 6 }, { x: 20, y: 21 }, { x: 50, y: 50 }, { x: 80, y: 81 }, { x: 100, y: 97 }],
        hsl: {
            red: { saturation: 3 }, orange: { saturation: -2, luminance: 3 }, yellow: { hue: 5, saturation: -5 },
            green: { hue: -6, saturation: 6 }, aqua: { hue: -4, saturation: 5 },
            blue: { hue: -5, saturation: 7, luminance: -3 }, magenta: { saturation: -4 },
        },
        grading: { shadows: { hue: 190, saturation: 10 }, highlights: { hue: 48, saturation: 4 } },
        texture: -2, clarity: -2, grain: 25, vignette: -8,
    }),
    'Cinestill 800T': filmPreset({
        contrast: 12, highlights: -26, shadows: 12, whites: -4, blacks: -4,
        temperature: -14, tint: 6, vibrance: 8, saturation: -4,
        curve: [{ x: 0, y: 5 }, { x: 20, y: 18 }, { x: 50, y: 49 }, { x: 80, y: 83 }, { x: 100, y: 98 }],
        hsl: {
            red: { hue: -4, saturation: 12, luminance: 3 }, orange: { hue: -5, saturation: 5 },
            yellow: { saturation: -12 }, green: { hue: 8, saturation: -12 }, aqua: { saturation: 10 },
            blue: { hue: -6, saturation: 12, luminance: -6 }, purple: { saturation: 8 }, magenta: { saturation: 10 },
        },
        grading: {
            shadows: { hue: 220, saturation: 14 }, midtones: { hue: 200, saturation: 5 },
            highlights: { hue: 20, saturation: 14 },
        },
        clarity: 4, dehaze: 3, grain: 24, vignette: -12,
    }),
    'Kodak Tri-X 400': filmPreset({
        blackAndWhite: true, contrast: 28, highlights: -18, shadows: -10, whites: 12, blacks: -18,
        curve: [{ x: 0, y: 2 }, { x: 20, y: 14 }, { x: 50, y: 48 }, { x: 80, y: 87 }, { x: 100, y: 100 }],
        bwMixer: { red: 12, orange: 18, yellow: 10, green: -4, aqua: -8, blue: -20, purple: -10, magenta: 8 },
        texture: 7, clarity: 12, sharpening: 15, grain: 32, vignette: -10,
    }),
    'Ilford HP5 Plus': filmPreset({
        blackAndWhite: true, contrast: 12, highlights: -22, shadows: 12, whites: 2, blacks: -8,
        curve: [{ x: 0, y: 6 }, { x: 20, y: 20 }, { x: 50, y: 50 }, { x: 80, y: 82 }, { x: 100, y: 98 }],
        bwMixer: { red: 10, orange: 12, yellow: 8, green: 2, aqua: -4, blue: -12, purple: -8, magenta: 4 },
        texture: 3, clarity: 5, sharpening: 10, grain: 24, vignette: -8,
    }),
})

export function applyPreset(name, current = freshAdjustments(), customPresets = {}) {
    const preset = customPresets[name] || BUILT_IN_PRESETS[name]
    if (!preset) return sanitizeAdjustments(current)
    const merged = structuredClone(current)
    for (const [key, value] of Object.entries(preset)) {
        merged[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(merged[key] || {}), ...value }
            : value
    }
    return sanitizeAdjustments(merged)
}

export function serializeSidecar(adjustments, geometry, sourceName = '') {
    return JSON.stringify({
        schema: 'ian-truong-photo-editor/v1',
        sourceName,
        createdAt: new Date().toISOString(),
        adjustments: sanitizeAdjustments(adjustments),
        geometry,
    }, null, 2)
}

export function parseSidecar(text) {
    const parsed = JSON.parse(text)
    if (parsed?.schema !== 'ian-truong-photo-editor/v1') throw new Error('This is not a supported editor sidecar.')
    return parsed
}
