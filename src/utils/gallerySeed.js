const KEY = 'ian-photography-featured-seed'

export function gallerySessionSeed() {
    try {
        const existing = sessionStorage.getItem(KEY)
        if (existing && /^[\w.-]{1,80}$/.test(existing)) return existing
    } catch { /* Session storage is optional. */ }
    const seed = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
    try { sessionStorage.setItem(KEY, seed) } catch { /* Keep this document stable. */ }
    return seed
}
