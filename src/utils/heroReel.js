import { cdnUrl } from './mediaUrls'

export const HERO_REEL_POINTER_KEY = 'site/hero/video/reel.json'
const VERSION_PATTERN = /^[a-f0-9]{24}$/
const MAX_DIMENSION = 4096

function validRendition(value, version) {
    if (!value || typeof value !== 'object') return null
    const { width, height } = value
    if (!Number.isInteger(width) || !Number.isInteger(height)) return null
    if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null
    const key = `site/hero/versions/video/reel/v1/${version}/reel-${width}x${height}.mp4`
    if (value.key !== key) return null
    const url = cdnUrl(key)
    return url ? { width, height, url } : null
}

// Accept only the exact keys the reel worker writes, so a tampered or stale
// pointer can never point the hero at an arbitrary URL.
export function normalizeHeroReel(value) {
    if (!value || typeof value !== 'object' || value.schemaVersion !== 1) return null
    if (!VERSION_PATTERN.test(String(value.version || ''))) return null
    const renditions = Array.isArray(value.renditions)
        ? value.renditions.slice(0, 6).map(item => validRendition(item, value.version)).filter(Boolean)
        : []
    if (!renditions.length) return null
    return { version: value.version, renditions }
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

// Tall, narrow heroes (phones) get the portrait cut; everything else gets the
// smallest landscape file that still covers the hero at the device's density.
export function chooseHeroReelRendition(reel, { width, height, pixelRatio = 1 }) {
    const renditions = reel?.renditions || []
    if (!renditions.length || !(width > 0) || !(height > 0)) return null
    const portrait = width / height < 0.75
    const shaped = renditions.filter(item => (item.height > item.width) === portrait)
    const pool = (shaped.length ? shaped : renditions).slice().sort((a, b) => a.width - b.width)
    const needed = width * Math.min(Math.max(pixelRatio, 1), 2) * 0.8
    return pool.find(item => item.width >= needed) || pool.at(-1)
}

export function heroReelAllowed() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    const connection = navigator.connection
    if (connection?.saveData) return false
    return !['slow-2g', '2g'].includes(connection?.effectiveType)
}
