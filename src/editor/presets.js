import { freshAdjustments, sanitizeAdjustments } from './adjustments'

export const BUILT_IN_PRESETS = {
    Clean: {},
    'Warm Portrait': { temperature: 18, tint: 5, highlights: -12, shadows: 16, vibrance: 12, texture: -4 },
    'Cool Landscape': { temperature: -12, contrast: 12, highlights: -25, shadows: 18, vibrance: 20, clarity: 10, dehaze: 8 },
    'Soft Film': { contrast: -8, blacks: 14, highlights: -16, saturation: -8, grain: 18, curve: [7, 28, 52, 76, 96] },
    'High Contrast B&W': { blackAndWhite: true, contrast: 28, highlights: -10, shadows: -8, whites: 12, blacks: -18, grain: 10 },
}

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
