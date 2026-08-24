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
    curve: [
        { x: 0, y: 0 },
        { x: 25, y: 25 },
        { x: 50, y: 50 },
        { x: 75, y: 75 },
        { x: 100, y: 100 },
    ],
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
    if (Array.isArray(candidate.curve) && candidate.curve.length >= 2) {
        const legacyCurve = candidate.curve.every((point) => Number.isFinite(Number(point)))
        const curve = candidate.curve
            .slice(0, 16)
            .flatMap((point, index, points) => {
                const x = legacyCurve ? index / Math.max(1, points.length - 1) * 100 : Number(point?.x)
                const y = legacyCurve ? Number(point) : Number(point?.y)
                return Number.isFinite(x) && Number.isFinite(y)
                    ? [{ x: clamp(x, 0, 100), y: clamp(y, 0, 100) }]
                    : []
            })
            .sort((first, second) => first.x - second.x)
            .reduce((points, point) => {
                if (points.length && Math.abs(points.at(-1).x - point.x) < 0.5) points[points.length - 1] = point
                else points.push(point)
                return points
            }, [])
        if (curve.length >= 2) {
            if (curve[0].x > 0) curve.unshift({ x: 0, y: 0 })
            else curve[0].x = 0
            if (curve.at(-1).x < 100) curve.push({ x: 100, y: 100 })
            else curve[curve.length - 1].x = 100
            next.curve = curve
        }
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
    const position = clamp(value, 0, 255) / 255 * 100
    const upperIndex = points.findIndex((point) => point.x >= position)
    if (upperIndex <= 0) return points[0].y / 100 * 255
    if (upperIndex === -1) return points.at(-1).y / 100 * 255
    const lower = points[upperIndex - 1]
    const upper = points[upperIndex]
    const fraction = (position - lower.x) / Math.max(0.001, upper.x - lower.x)
    return (lower.y + (upper.y - lower.y) * fraction) / 100 * 255
}

export function boxBlur(data, width, height, radius) {
    if (radius <= 0) return new Float32Array(data)
    const output = new Uint8ClampedArray(data.length)
    const size = radius * 2 + 1
    const rowLength = width * 4
    const ringSize = size + 2
    const horizontalRows = new Uint8ClampedArray(rowLength * ringSize)
    const rowKeys = new Int32Array(ringSize).fill(-1)
    const columnSums = new Float32Array(width * 3)

    const horizontalRow = (sourceY) => {
        const y = clamp(sourceY, 0, height - 1)
        const slot = y % ringSize
        const rowOffset = slot * rowLength
        if (rowKeys[slot] === y) return rowOffset
        rowKeys[slot] = y
        for (let channel = 0; channel < 3; channel += 1) {
            let sum = 0
            for (let x = -radius; x <= radius; x += 1) sum += data[(y * width + clamp(x, 0, width - 1)) * 4 + channel]
            for (let x = 0; x < width; x += 1) {
                horizontalRows[rowOffset + x * 4 + channel] = sum / size
                sum -= data[(y * width + clamp(x - radius, 0, width - 1)) * 4 + channel]
                sum += data[(y * width + clamp(x + radius + 1, 0, width - 1)) * 4 + channel]
            }
        }
        return rowOffset
    }

    const addRow = (sourceY, direction) => {
        const rowOffset = horizontalRow(sourceY)
        for (let x = 0; x < width; x += 1) {
            const columnOffset = x * 3
            const pixelOffset = rowOffset + x * 4
            columnSums[columnOffset] += horizontalRows[pixelOffset] * direction
            columnSums[columnOffset + 1] += horizontalRows[pixelOffset + 1] * direction
            columnSums[columnOffset + 2] += horizontalRows[pixelOffset + 2] * direction
        }
    }

    addRow(0, radius + 1)
    for (let y = 1; y <= radius; y += 1) addRow(y, 1)
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const columnOffset = x * 3
            const pixelOffset = (y * width + x) * 4
            output[pixelOffset] = columnSums[columnOffset] / size
            output[pixelOffset + 1] = columnSums[columnOffset + 1] / size
            output[pixelOffset + 2] = columnSums[columnOffset + 2] / size
            output[pixelOffset + 3] = data[pixelOffset + 3]
        }
        if (y < height - 1) {
            addRow(y - radius, -1)
            addRow(y + radius + 1, 1)
        }
    }
    return output
}

export function curveLookup(points) {
    const lookup = new Uint8ClampedArray(256)
    for (let value = 0; value < lookup.length; value += 1) lookup[value] = curveValue(value, points)
    return lookup
}

function hasChannelAdjustments(settings) {
    return COLOR_CHANNELS.some((channel) => {
        const hsl = settings.hsl[channel]
        return hsl.hue || hsl.saturation || hsl.luminance
    })
}

function hasBlackAndWhiteMixerAdjustments(settings) {
    return COLOR_CHANNELS.some((channel) => settings.bwMixer[channel])
}

function hasIdentityCurve(points) {
    return points.every((point) => Math.abs(point.x - point.y) < 0.001)
}

function reportProcessingProgress(onProgress, value) {
    if (typeof onProgress === 'function') onProgress(Math.min(1, Math.max(0, value)))
}

function progressTracker(onProgress, pixelCount) {
    if (typeof onProgress !== 'function') return null
    const interval = Math.max(1, Math.ceil(pixelCount / 12))
    let next = 0
    return (pixel) => {
        if (pixel < next) return
        next = pixel + interval
        reportProcessingProgress(onProgress, 0.34 + (pixel / Math.max(1, pixelCount)) * 0.62)
    }
}

function noPixelAdjustments(flags, clipping) {
    return !clipping && Object.values(flags).every((value) => typeof value !== 'boolean' || !value)
}

function activeProcessingFlags(settings) {
    const channel = hasChannelAdjustments(settings)
    const blackAndWhiteMixer = hasBlackAndWhiteMixerAdjustments(settings)
    const grading = Object.entries(settings.grading).filter(([, value]) => value.saturation)
    return {
        fineBlur: Boolean(settings.texture || settings.sharpening || settings.noiseLuminance || settings.noiseColor),
        clarity: Boolean(settings.clarity),
        exposureColor: Boolean(settings.exposure || settings.temperature || settings.tint),
        tonal: Boolean(settings.highlights || settings.shadows || settings.whites || settings.blacks),
        contrast: Boolean(settings.contrast || settings.dehaze),
        gamma: Math.abs(settings.gamma - 1) > 0.0001,
        curve: !hasIdentityCurve(settings.curve),
        hue: Boolean(settings.vibrance || settings.saturation || channel || (settings.blackAndWhite && blackAndWhiteMixer)),
        grading: grading.length > 0 && !settings.blackAndWhite,
        blackAndWhite: settings.blackAndWhite,
        vignette: Boolean(settings.vignette),
        grain: Boolean(settings.grain),
        gradingEntries: grading,
    }
}

function cachedBlur(source, width, height, radius, spatialCache) {
    if (!spatialCache) return boxBlur(source, width, height, radius)
    const key = `${width}x${height}:r${radius}`
    let cached = spatialCache.get(key)
    if (!cached) {
        cached = boxBlur(source, width, height, radius)
        spatialCache.set(key, cached)
    }
    return cached
}

function spatialData(source, width, height, settings, flags, onProgress, spatialCache) {
    reportProcessingProgress(onProgress, 0.04)
    const fineBlur = flags.fineBlur
        ? cachedBlur(source, width, height, Math.max(1, Math.round(settings.sharpeningRadius)), spatialCache)
        : null
    reportProcessingProgress(onProgress, flags.fineBlur ? 0.18 : 0.1)
    const broadBlur = flags.clarity ? cachedBlur(source, width, height, 5, spatialCache) : null
    reportProcessingProgress(onProgress, 0.32)
    return { fineBlur, broadBlur }
}

function gradingColors(entries) {
    return Object.fromEntries(entries.map(([key, value]) => [key, gradingColor(value)]))
}

function gradingColor(range) {
    const [r, g, b] = hslToRgb(range.hue, 0.8, 0.5)
    return [r / 255, g / 255, b / 255]
}

function seededNoise(index) {
    const value = Math.sin(index * 12.9898 + 78.233) * 43758.5453
    return (value - Math.floor(value)) * 2 - 1
}

function pixelChannel(settings, hue) {
    const channel = channelForHue(hue)
    return { channel, hsl: settings.hsl[channel] }
}

function applyHueAdjustments(red, green, blue, settings, saturation, vibrance) {
    let [hue, sat, light] = rgbToHsl(red, green, blue)
    const { channel, hsl } = pixelChannel(settings, hue)
    hue += hsl.hue * 0.45
    const vibranceBoost = vibrance * (1 - sat) * 0.7
    sat = clamp(sat * saturation + vibranceBoost + hsl.saturation / 100, 0, 1)
    light = clamp(light + hsl.luminance / 250, 0, 1)
    return { color: hslToRgb(hue, sat, light), channel }
}

function applyColorGrading(red, green, blue, luma, gradingEntries, colors) {
    for (const [rangeName, rangeSettings] of gradingEntries) {
        let weight = 1
        if (rangeName === 'shadows') weight = (1 - luma / 255) ** 2
        if (rangeName === 'midtones') weight = 1 - Math.abs(luma / 127.5 - 1)
        if (rangeName === 'highlights') weight = (luma / 255) ** 2
        const mix = (rangeSettings.saturation / 100) * weight * (rangeName === 'global' ? 0.35 : 0.22)
        red = red * (1 - mix) + colors[rangeName][0] * 255 * mix
        green = green * (1 - mix) + colors[rangeName][1] * 255 * mix
        blue = blue * (1 - mix) + colors[rangeName][2] * 255 * mix
    }
    return [red, green, blue]
}

function applyVignette(red, green, blue, pixel, width, height, amount) {
    const x = pixel % width
    const y = Math.floor(pixel / width)
    const dx = x / Math.max(1, width - 1) * 2 - 1
    const dy = y / Math.max(1, height - 1) * 2 - 1
    const distance = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 1.35)
    const factor = 1 + (amount / 100) * distance ** 2 * 0.7
    return [red * factor, green * factor, blue * factor]
}

function applyClipping(red, green, blue, clipping) {
    if (clipping && (red >= 254 || green >= 254 || blue >= 254)) return [255, 45, 35]
    if (clipping && (red <= 1 && green <= 1 && blue <= 1)) return [25, 100, 255]
    return [red, green, blue]
}

function copySource(source, onProgress) {
    reportProcessingProgress(onProgress, 0.35)
    const output = new Uint8ClampedArray(source)
    reportProcessingProgress(onProgress, 1)
    return output
}

function preparedValues(settings, flags) {
    return {
        exposure: 2 ** settings.exposure,
        contrast: 1 + settings.contrast / 100,
        dehaze: 1 + settings.dehaze / 180,
        temperature: settings.temperature / 100,
        tint: settings.tint / 100,
        saturation: 1 + settings.saturation / 100,
        vibrance: settings.vibrance / 100,
        curve: flags.curve ? curveLookup(settings.curve) : null,
        grading: flags.grading ? gradingColors(flags.gradingEntries) : null,
        detailStrength: (settings.texture * 0.55 + settings.sharpening * (settings.sharpeningDetail / 50)) / 100,
        noiseMix: settings.noiseLuminance / 130,
        colorMix: settings.noiseColor / 120,
        clarityStrength: settings.clarity / 115,
    }
}

export function processImagePixels(input, width, height, candidate, { clipping = false, onProgress, spatialCache } = {}) {
    const settings = sanitizeAdjustments(candidate)
    const source = input instanceof Uint8ClampedArray ? input : new Uint8ClampedArray(input)
    const flags = activeProcessingFlags(settings)
    if (noPixelAdjustments(flags, clipping)) return copySource(source, onProgress)
    const output = new Uint8ClampedArray(source.length)
    const { fineBlur, broadBlur } = spatialData(source, width, height, settings, flags, onProgress, spatialCache)
    const values = preparedValues(settings, flags)
    const trackProgress = progressTracker(onProgress, source.length / 4)

    for (let index = 0; index < source.length; index += 4) {
        const pixel = index / 4
        trackProgress?.(pixel)
        let red = source[index]
        let green = source[index + 1]
        let blue = source[index + 2]

        if (fineBlur) {
            red = red * (1 - values.noiseMix) + fineBlur[index] * values.noiseMix + (red - fineBlur[index]) * values.detailStrength
            green = green * (1 - values.noiseMix) + fineBlur[index + 1] * values.noiseMix + (green - fineBlur[index + 1]) * values.detailStrength
            blue = blue * (1 - values.noiseMix) + fineBlur[index + 2] * values.noiseMix + (blue - fineBlur[index + 2]) * values.detailStrength
            if (values.colorMix) {
                const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722
                red = red * (1 - values.colorMix) + luma * values.colorMix
                green = green * (1 - values.colorMix) + luma * values.colorMix
                blue = blue * (1 - values.colorMix) + luma * values.colorMix
            }
        }
        if (broadBlur) {
            red += (red - broadBlur[index]) * values.clarityStrength
            green += (green - broadBlur[index + 1]) * values.clarityStrength
            blue += (blue - broadBlur[index + 2]) * values.clarityStrength
        }

        if (flags.exposureColor) {
            red *= values.exposure * (1 + values.temperature * 0.14)
            green *= values.exposure * (1 + values.tint * 0.08)
            blue *= values.exposure * (1 - values.temperature * 0.14)
            red *= 1 - values.tint * 0.05
            blue *= 1 - values.tint * 0.05
        }

        if (flags.tonal) {
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
        }

        if (flags.contrast) {
            red = ((red - 127.5) * values.contrast * values.dehaze + 127.5)
            green = ((green - 127.5) * values.contrast * values.dehaze + 127.5)
            blue = ((blue - 127.5) * values.contrast * values.dehaze + 127.5)
        }
        if (flags.gamma) {
            red = 255 * ((clamp(red) / 255) ** (1 / settings.gamma))
            green = 255 * ((clamp(green) / 255) ** (1 / settings.gamma))
            blue = 255 * ((clamp(blue) / 255) ** (1 / settings.gamma))
        }
        if (values.curve) {
            red = values.curve[Math.round(clamp(red))]
            green = values.curve[Math.round(clamp(green))]
            blue = values.curve[Math.round(clamp(blue))]
        }

        let channel
        if (flags.hue) {
            const hueResult = applyHueAdjustments(red, green, blue, settings, values.saturation, values.vibrance)
            ;[red, green, blue] = hueResult.color
            channel = hueResult.channel
        }

        const luma = (flags.grading || flags.blackAndWhite)
            ? clamp(red * 0.2126 + green * 0.7152 + blue * 0.0722, 0, 255)
            : 0
        if (flags.grading) {
            ;[red, green, blue] = applyColorGrading(red, green, blue, luma, flags.gradingEntries, values.grading)
        }

        if (flags.blackAndWhite) {
            if (!channel && COLOR_CHANNELS.some((name) => settings.bwMixer[name])) channel = channelForHue(rgbToHsl(red, green, blue)[0])
            const mix = channel ? settings.bwMixer[channel] / 100 : 0
            const gray = clamp(luma * (1 + mix * 0.6))
            red = gray
            green = gray
            blue = gray
        }

        if (flags.vignette) [red, green, blue] = applyVignette(red, green, blue, pixel, width, height, settings.vignette)
        if (flags.grain) {
            const grain = seededNoise(pixel) * settings.grain * 0.38
            red += grain
            green += grain
            blue += grain
        }

        ;[red, green, blue] = applyClipping(red, green, blue, clipping)
        output[index] = clamp(red)
        output[index + 1] = clamp(green)
        output[index + 2] = clamp(blue)
        output[index + 3] = source[index + 3]
    }
    reportProcessingProgress(onProgress, 1)
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
