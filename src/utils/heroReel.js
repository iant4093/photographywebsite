import { cdnUrl } from './mediaUrls'

export const HERO_REEL_POINTER_KEY = 'site/hero/video/reel.json'
const VERSION_PATTERN = /^[a-f0-9]{24}$/
const MAX_DIMENSION = 4096

const MAX_CUTS = 8
const ORIENTATIONS = ['landscape', 'portrait']

function validRendition(value, version, cut) {
    if (!value || typeof value !== 'object') return null
    const { width, height } = value
    if (!Number.isInteger(width) || !Number.isInteger(height)) return null
    if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null
    const name = cut === null ? `reel-${width}x${height}` : `reel-${cut}-${width}x${height}`
    const key = `site/hero/versions/video/reel/v1/${version}/${name}.mp4`
    if (value.key !== key) return null
    const url = cdnUrl(key)
    return url ? { width, height, url } : null
}

function validRenditions(items, version, cut) {
    return Array.isArray(items)
        ? items.slice(0, 6).map(item => validRendition(item, version, cut)).filter(Boolean)
        : []
}

function validStreams(value, version, cut) {
    if (!value || typeof value !== 'object') return null
    const streams = {}
    for (const orientation of ORIENTATIONS) {
        const key = `site/hero/versions/video/reel/v1/${version}/reel-${cut}-${orientation}.m3u8`
        const url = value[orientation]?.key === key ? cdnUrl(key) : ''
        if (!url) return null
        streams[orientation] = url
    }
    return streams
}

// Accept only the exact keys the reel worker writes, so a tampered or stale
// pointer can never point the hero at an arbitrary URL. Schema 3 cuts carry
// adaptive (HLS) streams per orientation, or MP4 renditions from older reels;
// schema 2 carries several MP4 cuts; schema 1 (a single reel) is one cut.
export function normalizeHeroReel(value) {
    if (!value || typeof value !== 'object') return null
    if (!VERSION_PATTERN.test(String(value.version || ''))) return null
    let cuts = []
    if (value.schemaVersion === 1) {
        cuts = [{ renditions: validRenditions(value.renditions, value.version, null) }]
    } else if ([2, 3].includes(value.schemaVersion) && Array.isArray(value.cuts)) {
        cuts = value.cuts.slice(0, MAX_CUTS).map((cut, index) => {
            const streams = value.schemaVersion === 3 ? validStreams(cut?.streams, value.version, index) : null
            return streams ? { streams, renditions: [] } : { renditions: validRenditions(cut?.renditions, value.version, index) }
        })
    }
    cuts = cuts.filter(cut => cut.streams || cut.renditions.length)
    return cuts.length ? { version: value.version, cuts } : null
}

// Each page load plays one of the published cuts at random.
export function pickHeroReelCut(reel, random = Math.random) {
    const cuts = reel?.cuts || []
    if (!cuts.length) return null
    const index = Math.min(cuts.length - 1, Math.floor(random() * cuts.length))
    return { version: reel.version, cut: index, renditions: cuts[index].renditions, streams: cuts[index].streams || null }
}

export async function fetchHeroReel({ signal } = {}) {
    const url = cdnUrl(HERO_REEL_POINTER_KEY)
    if (!url) return null
    const response = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-cache', signal })
    if (!response.ok) return null
    try {
        return normalizeHeroReel(await response.json())
    } catch {
        return null
    }
}

const isPortrait = (width, height) => width / height < 0.75

// Tall, narrow heroes (phones) get the portrait cut; everything else gets the
// smallest landscape file that still covers the hero at the device's density.
export function chooseHeroReelRendition(reel, { width, height, pixelRatio = 1 }) {
    const renditions = reel?.renditions || []
    if (!renditions.length || !(width > 0) || !(height > 0)) return null
    const portrait = isPortrait(width, height)
    const shaped = renditions.filter(item => (item.height > item.width) === portrait)
    const pool = (shaped.length ? shaped : renditions).slice().sort((a, b) => a.width - b.width)
    const needed = width * Math.min(Math.max(pixelRatio, 1), 2) * 0.8
    return pool.find(item => item.width >= needed) || pool.at(-1)
}

// The URL to play for a hero of this shape. Adaptive cuts only choose the
// orientation; the player picks the quality from bandwidth and size.
export function chooseHeroReelSource(reel, size) {
    if (!(size?.width > 0) || !(size?.height > 0)) return ''
    if (reel?.streams) return reel.streams[isPortrait(size.width, size.height) ? 'portrait' : 'landscape']
    return chooseHeroReelRendition(reel, size)?.url || ''
}

export function heroReelAllowed() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    const connection = navigator.connection
    if (connection?.saveData) return false
    return !['slow-2g', '2g'].includes(connection?.effectiveType)
}
