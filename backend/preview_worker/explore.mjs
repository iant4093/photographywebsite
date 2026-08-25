export const EXPLORE_VERSION = 1
export const MANUAL_LENS_FALLBACK = 'Sirui Nightwalker 75mm T1.2'

const MAX_PALETTE_COLORS = 5
const COLOR_FAMILY_ORDER = Object.freeze([
    'red',
    'orange',
    'yellow',
    'green',
    'cyan',
    'blue',
    'purple',
    'pink',
])

function normalizedText(value) {
    return typeof value === 'string' ? value.trim().replaceAll(/\s+/g, ' ').slice(0, 160) : ''
}

export function normalizeLens(value) {
    return normalizedText(value) || MANUAL_LENS_FALLBACK
}

export function lensKey(value) {
    return normalizeLens(value).toLocaleLowerCase('en-US')
}

function rgbToHsl(red, green, blue) {
    const r = red / 255
    const g = green / 255
    const b = blue / 255
    const maximum = Math.max(r, g, b)
    const minimum = Math.min(r, g, b)
    const delta = maximum - minimum
    const lightness = (maximum + minimum) / 2
    if (delta === 0) return { hue: 0, saturation: 0, lightness }
    const saturation = delta / (1 - Math.abs((2 * lightness) - 1))
    let hue
    if (maximum === r) hue = 60 * (((g - b) / delta) % 6)
    else if (maximum === g) hue = 60 * (((b - r) / delta) + 2)
    else hue = 60 * (((r - g) / delta) + 4)
    return { hue: hue < 0 ? hue + 360 : hue, saturation, lightness }
}

function hueFamily(hue) {
    if (hue < 15 || hue >= 345) return 'red'
    if (hue < 48) return 'orange'
    if (hue < 72) return 'yellow'
    if (hue < 165) return 'green'
    if (hue < 195) return 'cyan'
    if (hue < 255) return 'blue'
    if (hue < 315) return 'purple'
    return 'pink'
}

function hex(red, green, blue) {
    return `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function colorDistance(left, right) {
    return Math.hypot(left.red - right.red, left.green - right.green, left.blue - right.blue)
}

export function analyzePixels(bytes, channels = 3) {
    if (!(bytes instanceof Uint8Array) || !Number.isInteger(channels) || channels < 3 || bytes.length < channels) {
        throw new TypeError('Pixel buffer is invalid')
    }

    const bins = new Map()
    const familyWeights = Object.fromEntries(COLOR_FAMILY_ORDER.map(family => [family, 0]))
    let neutralWeight = 0
    let totalWeight = 0

    for (let offset = 0; offset + 2 < bytes.length; offset += channels) {
        const red = bytes[offset]
        const green = bytes[offset + 1]
        const blue = bytes[offset + 2]
        const { hue, saturation, lightness } = rgbToHsl(red, green, blue)
        // De-emphasize clipped highlights and shadows while keeping them in the palette.
        const tonalWeight = 0.35 + (0.65 * Math.sin(Math.PI * lightness))
        totalWeight += tonalWeight
        if (saturation < 0.14) neutralWeight += tonalWeight
        else familyWeights[hueFamily(hue)] += tonalWeight * (0.45 + (0.55 * saturation))

        const key = `${red >> 4}:${green >> 4}:${blue >> 4}`
        const bin = bins.get(key) || { red: 0, green: 0, blue: 0, count: 0, weight: 0 }
        bin.red += red
        bin.green += green
        bin.blue += blue
        bin.count += 1
        bin.weight += tonalWeight * (0.55 + (0.45 * saturation))
        bins.set(key, bin)
    }

    const candidates = [...bins.values()]
        .map(bin => ({
            red: Math.round(bin.red / bin.count),
            green: Math.round(bin.green / bin.count),
            blue: Math.round(bin.blue / bin.count),
            weight: bin.weight,
        }))
        .sort((left, right) => right.weight - left.weight)

    const selected = []
    for (const candidate of candidates) {
        if (selected.every(existing => colorDistance(existing, candidate) >= 42)) selected.push(candidate)
        if (selected.length === MAX_PALETTE_COLORS) break
    }
    for (const candidate of candidates) {
        if (selected.includes(candidate)) continue
        selected.push(candidate)
        if (selected.length === MAX_PALETTE_COLORS) break
    }

    const chromaticTotal = Object.values(familyWeights).reduce((sum, weight) => sum + weight, 0)
    const families = COLOR_FAMILY_ORDER
        .filter(family => chromaticTotal > 0 && familyWeights[family] / chromaticTotal >= 0.075)
        .sort((left, right) => familyWeights[right] - familyWeights[left])
        .slice(0, 3)
    if (totalWeight > 0 && neutralWeight / totalWeight >= 0.58) families.push('monochrome')

    return {
        palette: selected.map(color => hex(color.red, color.green, color.blue)),
        colorFamilies: families.length ? families : ['monochrome'],
    }
}

export function isCompleteExploreMetadata(metadata) {
    return Boolean(
        metadata
        && metadata.exploreVersion === EXPLORE_VERSION
        && Array.isArray(metadata.palette)
        && metadata.palette.length >= 1
        && metadata.palette.length <= MAX_PALETTE_COLORS
        && metadata.palette.every(value => typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value))
        && Array.isArray(metadata.colorFamilies)
        && metadata.colorFamilies.length >= 1
        && metadata.colorFamilies.every(value => value === 'monochrome' || COLOR_FAMILY_ORDER.includes(value))
        && typeof metadata.lens === 'string'
        && metadata.lens.length >= 1
        && metadata.lensKey === lensKey(metadata.lens)
    )
}
