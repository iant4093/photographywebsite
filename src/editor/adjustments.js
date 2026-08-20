export const COLOR_CHANNELS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']

export const DEFAULT_ADJUSTMENTS = Object.freeze({
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    gamma: 1,
    temperature: 0,
    tint: 0,
    vibrance: 0,
    saturation: 0,
    curve: [0, 25, 50, 75, 100],
    hsl: Object.fromEntries(COLOR_CHANNELS.map((channel) => [channel, { hue: 0, saturation: 0, luminance: 0 }])),
    grading: {
        shadows: { hue: 220, saturation: 0 },
        midtones: { hue: 35, saturation: 0 },
        highlights: { hue: 45, saturation: 0 },
        global: { hue: 35, saturation: 0 },
    },
    blackAndWhite: false,
    bwMixer: Object.fromEntries(COLOR_CHANNELS.map((channel) => [channel, 0])),
    texture: 0,
    clarity: 0,
    dehaze: 0,
    sharpening: 0,
    sharpeningRadius: 1,
    sharpeningDetail: 25,
    noiseLuminance: 0,
    noiseColor: 0,
    vignette: 0,
    grain: 0,
})

export const DEFAULT_GEOMETRY = Object.freeze({
    crop: { x: 0, y: 0, width: 1, height: 1 },
    rotation: 0,
    quarterTurns: 0,
    flipX: false,
    flipY: false,
    vertical: 0,
    horizontal: 0,
    aspect: 'free',
})

export function freshAdjustments() {
    return structuredClone(DEFAULT_ADJUSTMENTS)
}

export function freshGeometry() {
    return structuredClone(DEFAULT_GEOMETRY)
}

const clamp = (value, min = 0, max = 255) => Math.min(max, Math.max(min, value))

export function sanitizeAdjustments(candidate = {}) {
    const next = freshAdjustments()
    for (const key of Object.keys(next)) {
        if (!(key in candidate)) continue
        if (typeof next[key] === 'number' && Number.isFinite(Number(candidate[key]))) next[key] = Number(candidate[key])
        else if (typeof next[key] === 'boolean') next[key] = Boolean(candidate[key])
    }
    if (Array.isArray(candidate.curve) && candidate.curve.length === 5) {
        next.curve = candidate.curve.reduce((points, value) => {
            points.push(clamp(Number(value) || 0, points.at(-1) || 0, 100))
            return points
        }, [])
    }
    for (const channel of COLOR_CHANNELS) {
        for (const property of ['hue', 'saturation', 'luminance']) {
            const value = Number(candidate.hsl?.[channel]?.[property])
            if (Number.isFinite(value)) next.hsl[channel][property] = clamp(value, -100, 100)
        }
        const bwValue = Number(candidate.bwMixer?.[channel])
        if (Number.isFinite(bwValue)) next.bwMixer[channel] = clamp(bwValue, -100, 100)
    }
    for (const range of Object.keys(next.grading)) {
        const hue = Number(candidate.grading?.[range]?.hue)
        const saturation = Number(candidate.grading?.[range]?.saturation)
        if (Number.isFinite(hue)) next.grading[range].hue = ((hue % 360) + 360) % 360
        if (Number.isFinite(saturation)) next.grading[range].saturation = clamp(saturation, 0, 100)
    }
    return next
}

export function sanitizeGeometry(candidate = {}) {
    const next = freshGeometry()
    const crop = candidate.crop || {}
    next.crop = {
        x: clamp(Number(crop.x) || 0, 0, 0.99),
        y: clamp(Number(crop.y) || 0, 0, 0.99),
        width: clamp(Number(crop.width) || 1, 0.01, 1),
        height: clamp(Number(crop.height) || 1, 0.01, 1),
    }
    next.crop.width = Math.min(next.crop.width, 1 - next.crop.x)
    next.crop.height = Math.min(next.crop.height, 1 - next.crop.y)
    for (const key of ['rotation', 'quarterTurns', 'vertical', 'horizontal']) {
        const value = Number(candidate[key])
        if (Number.isFinite(value)) next[key] = value
    }
    next.flipX = Boolean(candidate.flipX)
    next.flipY = Boolean(candidate.flipY)
    next.aspect = typeof candidate.aspect === 'string' ? candidate.aspect : 'free'
    return next
}

function rgbToHsl(red, green, blue) {
    const r = red / 255
    const g = green / 255
    const b = blue / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const lightness = (max + min) / 2
    if (max === min) return [0, 0, lightness]
    const delta = max - min
    const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
    let hue
    if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0)
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
    return [hue * 60, saturation, lightness]
}

function hslToRgb(hue, saturation, lightness) {
    const h = (((hue % 360) + 360) % 360) / 360
    if (saturation === 0) {
        const gray = lightness * 255
        return [gray, gray, gray]
    }
    const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
    const p = 2 * lightness - q
    const convert = (offset) => {
        let t = offset
        if (t < 0) t += 1
        if (t > 1) t -= 1
        if (t < 1 / 6) return p + (q - p) * 6 * t
        if (t < 1 / 2) return q
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
        return p
    }
    return [convert(h + 1 / 3) * 255, convert(h) * 255, convert(h - 1 / 3) * 255]
}

function channelForHue(hue) {
    const normalized = ((hue % 360) + 360) % 360
    if (normalized < 15 || normalized >= 345) return 'red'
    if (normalized < 45) return 'orange'
    if (normalized < 75) return 'yellow'
    if (normalized < 165) return 'green'
    if (normalized < 195) return 'aqua'
    if (normalized < 255) return 'blue'
    if (normalized < 285) return 'purple'
    return 'magenta'
}

function curveValue(value, points) {
    const position = clamp(value, 0, 255) / 255 * 4
    const index = Math.min(3, Math.floor(position))
    const fraction = position - index
    return ((points[index] + (points[index + 1] - points[index]) * fraction) / 100) * 255
}

function boxBlur(data, width, height, radius) {
    if (radius <= 0) return new Float32Array(data)
    const output = new Float32Array(data.length)
    const size = radius * 2 + 1
    const horizontal = new Float32Array(data.length)
    for (let y = 0; y < height; y += 1) {
        for (let channel = 0; channel < 3; channel += 1) {
            let sum = 0
            for (let x = -radius; x <= radius; x += 1) sum += data[(y * width + clamp(x, 0, width - 1)) * 4 + channel]
            for (let x = 0; x < width; x += 1) {
                horizontal[(y * width + x) * 4 + channel] = sum / size
                sum -= data[(y * width + clamp(x - radius, 0, width - 1)) * 4 + channel]
                sum += data[(y * width + clamp(x + radius + 1, 0, width - 1)) * 4 + channel]
            }
        }
    }
    for (let x = 0; x < width; x += 1) {
        for (let channel = 0; channel < 3; channel += 1) {
            let sum = 0
            for (let y = -radius; y <= radius; y += 1) sum += horizontal[(clamp(y, 0, height - 1) * width + x) * 4 + channel]
            for (let y = 0; y < height; y += 1) {
                output[(y * width + x) * 4 + channel] = sum / size
                sum -= horizontal[(clamp(y - radius, 0, height - 1) * width + x) * 4 + channel]
                sum += horizontal[(clamp(y + radius + 1, 0, height - 1) * width + x) * 4 + channel]
            }
        }
    }
    return output
}

function gradingColor(range) {
    const [r, g, b] = hslToRgb(range.hue, 0.8, 0.5)
    return [r / 255, g / 255, b / 255]
}

function seededNoise(index) {
    const value = Math.sin(index * 12.9898 + 78.233) * 43758.5453
    return (value - Math.floor(value)) * 2 - 1
}

export function processImagePixels(input, width, height, candidate, { clipping = false } = {}) {
    const settings = sanitizeAdjustments(candidate)
    const source = input instanceof Uint8ClampedArray ? input : new Uint8ClampedArray(input)
    const output = new Uint8ClampedArray(source.length)
    const needsSpatial = settings.texture || settings.clarity || settings.sharpening || settings.noiseLuminance || settings.noiseColor
    const fineBlur = needsSpatial ? boxBlur(source, width, height, Math.max(1, Math.round(settings.sharpeningRadius))) : null
    const broadBlur = settings.clarity ? boxBlur(source, width, height, 5) : null
    const exposure = 2 ** settings.exposure
    const contrast = 1 + settings.contrast / 100
    const dehaze = 1 + settings.dehaze / 180
    const temperature = settings.temperature / 100
    const tint = settings.tint / 100
    const saturation = 1 + settings.saturation / 100
    const vibrance = settings.vibrance / 100
    const grading = Object.fromEntries(Object.entries(settings.grading).map(([key, value]) => [key, gradingColor(value)]))

    for (let index = 0; index < source.length; index += 4) {
        let red = source[index]
        let green = source[index + 1]
        let blue = source[index + 2]

        if (fineBlur) {
            const detailStrength = (settings.texture * 0.55 + settings.sharpening * (settings.sharpeningDetail / 50)) / 100
            const noiseMix = settings.noiseLuminance / 130
            red = red * (1 - noiseMix) + fineBlur[index] * noiseMix + (red - fineBlur[index]) * detailStrength
            green = green * (1 - noiseMix) + fineBlur[index + 1] * noiseMix + (green - fineBlur[index + 1]) * detailStrength
            blue = blue * (1 - noiseMix) + fineBlur[index + 2] * noiseMix + (blue - fineBlur[index + 2]) * detailStrength
            if (settings.noiseColor) {
                const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722
                const colorMix = settings.noiseColor / 120
                red = red * (1 - colorMix) + luma * colorMix
                green = green * (1 - colorMix) + luma * colorMix
                blue = blue * (1 - colorMix) + luma * colorMix
            }
        }
        if (broadBlur) {
            const strength = settings.clarity / 115
            red += (red - broadBlur[index]) * strength
            green += (green - broadBlur[index + 1]) * strength
            blue += (blue - broadBlur[index + 2]) * strength
        }

        red *= exposure * (1 + temperature * 0.14)
        green *= exposure * (1 + tint * 0.08)
        blue *= exposure * (1 - temperature * 0.14)
        red *= 1 - tint * 0.05
        blue *= 1 - tint * 0.05

        const originalLuma = red * 0.2126 + green * 0.7152 + blue * 0.0722
        const normalizedLuma = originalLuma / 255
        const shadowMask = (1 - normalizedLuma) ** 2
        const highlightMask = normalizedLuma ** 2
        const shadowLift = settings.shadows * shadowMask * 1.25 + settings.blacks * (1 - normalizedLuma) * 0.65
        const highlightLift = settings.highlights * highlightMask * 1.25 + settings.whites * normalizedLuma * 0.65
        const tonalLift = shadowLift + highlightLift
        red += tonalLift
        green += tonalLift
        blue += tonalLift

        red = ((red - 127.5) * contrast * dehaze + 127.5)
        green = ((green - 127.5) * contrast * dehaze + 127.5)
        blue = ((blue - 127.5) * contrast * dehaze + 127.5)
        red = 255 * ((clamp(red) / 255) ** (1 / settings.gamma))
        green = 255 * ((clamp(green) / 255) ** (1 / settings.gamma))
        blue = 255 * ((clamp(blue) / 255) ** (1 / settings.gamma))
        red = curveValue(red, settings.curve)
        green = curveValue(green, settings.curve)
        blue = curveValue(blue, settings.curve)

        let [hue, sat, light] = rgbToHsl(red, green, blue)
        const channel = channelForHue(hue)
        const hsl = settings.hsl[channel]
        hue += hsl.hue * 0.45
        const vibranceBoost = vibrance * (1 - sat) * 0.7
        sat = clamp(sat * saturation + vibranceBoost + hsl.saturation / 100, 0, 1)
        light = clamp(light + hsl.luminance / 250, 0, 1)
        ;[red, green, blue] = hslToRgb(hue, sat, light)

        const luma = clamp(red * 0.2126 + green * 0.7152 + blue * 0.0722, 0, 255)
        for (const [rangeName, rangeSettings] of Object.entries(settings.grading)) {
            if (!rangeSettings.saturation) continue
            let weight = 1
            if (rangeName === 'shadows') weight = (1 - luma / 255) ** 2
            if (rangeName === 'midtones') weight = 1 - Math.abs(luma / 127.5 - 1)
            if (rangeName === 'highlights') weight = (luma / 255) ** 2
            const mix = (rangeSettings.saturation / 100) * weight * (rangeName === 'global' ? 0.35 : 0.22)
            red = red * (1 - mix) + grading[rangeName][0] * 255 * mix
            green = green * (1 - mix) + grading[rangeName][1] * 255 * mix
            blue = blue * (1 - mix) + grading[rangeName][2] * 255 * mix
        }

        if (settings.blackAndWhite) {
            const mix = settings.bwMixer[channel] / 100
            const gray = clamp(luma * (1 + mix * 0.6))
            red = gray
            green = gray
            blue = gray
        }

        const pixel = index / 4
        const x = pixel % width
        const y = Math.floor(pixel / width)
        const dx = x / Math.max(1, width - 1) * 2 - 1
        const dy = y / Math.max(1, height - 1) * 2 - 1
        const vignetteDistance = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 1.35)
        const vignetteFactor = 1 + (settings.vignette / 100) * vignetteDistance ** 2 * 0.7
        const grain = seededNoise(pixel) * settings.grain * 0.38
        red = red * vignetteFactor + grain
        green = green * vignetteFactor + grain
        blue = blue * vignetteFactor + grain

        if (clipping && (red >= 254 || green >= 254 || blue >= 254)) {
            red = 255; green = 45; blue = 35
        } else if (clipping && (red <= 1 && green <= 1 && blue <= 1)) {
            red = 25; green = 100; blue = 255
        }
        output[index] = clamp(red)
        output[index + 1] = clamp(green)
        output[index + 2] = clamp(blue)
        output[index + 3] = source[index + 3]
    }
    return output
}

export function calculateHistogram(data) {
    const histogram = { red: new Array(64).fill(0), green: new Array(64).fill(0), blue: new Array(64).fill(0), luma: new Array(64).fill(0) }
    for (let index = 0; index < data.length; index += 4) {
        histogram.red[Math.min(63, data[index] >> 2)] += 1
        histogram.green[Math.min(63, data[index + 1] >> 2)] += 1
        histogram.blue[Math.min(63, data[index + 2] >> 2)] += 1
        const luma = Math.round(data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722)
        histogram.luma[Math.min(63, luma >> 2)] += 1
    }
    return histogram
}
