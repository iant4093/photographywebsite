
const TIERS = [2160, 1440, 1080, 720, 540, 360, 240]

// Viewers know qualities by the short side ("1080p"), whichever way the video
// is turned; sizes near a standard tier take its name.
export function qualityLabel(width, height) {
    const short = Math.min(Number(width) || 0, Number(height) || 0)
    if (!short) return ''
    const tier = TIERS.find(value => Math.abs(short - value) <= value * 0.03)
    if (tier === 2160) return '4K'
    return `${tier || short}p`
}

// One option per label, best bitrate first, highest quality at the top.
// `levels` are {width, height, bitrate, value} in any order.
export function qualityOptions(levels) {
    const best = new Map()
    for (const level of levels || []) {
        const label = qualityLabel(level.width, level.height)
        if (!label) continue
        const current = best.get(label)
        if (!current || (level.bitrate || 0) > (current.bitrate || 0)) best.set(label, { ...level, label })
    }
    return [...best.values()]
        .sort((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height))
        .map(level => ({ value: String(level.value), label: level.label }))
}

// Variant streams of a multivariant playlist, for players without a level
// API (Safari's native HLS), resolved against the playlist's own URL.
export function parseHlsVariants(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (lines[0] !== '#EXTM3U') return []
    const variants = []
    lines.forEach((line, index) => {
        if (!line.startsWith('#EXT-X-STREAM-INF:')) return
        const uri = lines[index + 1]
        const resolution = /(?:^|,)RESOLUTION=(\d+)x(\d+)/.exec(line.slice(18))
        const bandwidth = /(?:^|,)BANDWIDTH=(\d+)/.exec(line.slice(18))
        if (!uri || uri.startsWith('#') || !resolution) return
        try {
            variants.push({
                url: new URL(uri, baseUrl).href,
                width: Number(resolution[1]),
                height: Number(resolution[2]),
                bitrate: Number(bandwidth?.[1] || 0),
            })
        } catch {
            // Skip a malformed URI; the other variants still play.
        }
    })
    return variants
}
