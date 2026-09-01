import { isSafeCursor } from './apiResponse'

const RESPONSE_TTL_MS = 5 * 60_000
const RESPONSE_MAX_ENTRIES = 64
const BROWSE_FRESH_MS = 5 * 60_000
const BROWSE_MAX_AGE_MS = 30 * 60_000
const BROWSE_MAX_ENTRIES = 8
const BROWSE_MAX_ITEMS = 72
const BROWSE_SCHEMA_VERSION = 1
const BROWSE_STORAGE_KEY = 'ian:explore-browse:v1'
const SEED_PATTERN = /^[0-9a-f]{16}$/
const responseCache = new Map()
const pendingRequests = new Map()
const browseSnapshots = new Map()
let responseGeneration = 0
let browseLoaded = false

function pruneResponseCache(now = Date.now()) {
    for (const [key, entry] of responseCache) {
        if (entry.expiresAt <= now) responseCache.delete(key)
    }
    while (responseCache.size > RESPONSE_MAX_ENTRIES) {
        const oldestKey = responseCache.keys().next().value
        if (oldestKey === undefined) break
        responseCache.delete(oldestKey)
    }
}

function withAbort(promise, signal) {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'))
    return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Request aborted', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
        promise.then(
            value => {
                signal.removeEventListener('abort', abort)
                resolve(value)
            },
            error => {
                signal.removeEventListener('abort', abort)
                reject(error)
            },
        )
    })
}

export function cachedExploreRequest(key, loader, signal) {
    pruneResponseCache()
    const cached = responseCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
        responseCache.delete(key)
        responseCache.set(key, cached)
        return withAbort(Promise.resolve(cached.value), signal)
    }
    if (cached) responseCache.delete(key)

    let record = pendingRequests.get(key)
    if (!record) {
        const generation = responseGeneration
        record = {}
        record.promise = Promise.resolve()
            .then(loader)
            .then(value => {
                if (generation === responseGeneration) {
                    responseCache.set(key, { value, expiresAt: Date.now() + RESPONSE_TTL_MS })
                    pruneResponseCache()
                }
                return value
            })
            .finally(() => {
                if (pendingRequests.get(key) === record) pendingRequests.delete(key)
            })
        pendingRequests.set(key, record)
    }
    return withAbort(record.promise, signal)
}

export function clearExploreResponseCache() {
    responseGeneration += 1
    responseCache.clear()
    pendingRequests.clear()
}

function storage() {
    try {
        return typeof window !== 'undefined' ? window.sessionStorage : null
    } catch {
        return null
    }
}

function safeText(value, maximum) {
    return typeof value === 'string' && value.length <= maximum ? value : ''
}

function safeHttpsUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 4096) return ''
    try {
        return new URL(value).protocol === 'https:' ? value : ''
    } catch {
        return ''
    }
}

function sanitizePhoto(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const albumId = safeText(value.albumId, 160)
    const mediaId = safeText(value.mediaId || value.id, 160)
    const url = safeHttpsUrl(value.url)
    const thumbnailUrl = safeHttpsUrl(value.thumbnailUrl)
    if (!albumId || !mediaId || !url || !thumbnailUrl) return null
    const previewSrcSet = Array.isArray(value.previewSrcSet)
        ? value.previewSrcSet.slice(0, 8).map(candidate => {
            const width = Number(candidate?.width)
            const previewUrl = safeHttpsUrl(candidate?.url)
            return Number.isInteger(width) && width > 0 && width <= 10000 && previewUrl
                ? { width, url: previewUrl }
                : null
        }).filter(Boolean)
        : []
    const exif = value.exif && typeof value.exif === 'object' && !Array.isArray(value.exif)
        ? Object.fromEntries(
            ['model', 'lens', 'focalLength', 'focalRatio', 'shutterSpeed', 'iso']
                .filter(field => safeText(value.exif[field], 160))
                .map(field => [field, value.exif[field]]),
        )
        : {}
    const photo = {
        albumId,
        albumTitle: safeText(value.albumTitle, 200),
        albumCategory: safeText(value.albumCategory, 100),
        albumCreatedAt: safeText(value.albumCreatedAt, 64),
        mediaId,
        id: mediaId,
        url,
        thumbnailUrl,
        previewSrcSet,
        exif,
    }
    for (const field of ['width', 'height', 'imageIndex']) {
        const numeric = Number(value[field])
        if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 100000) photo[field] = numeric
    }
    for (const [field, maximum] of [['blurhash', 200], ['lens', 160], ['timeOfDay', 32], ['season', 32]]) {
        const text = safeText(value[field], maximum)
        if (text) photo[field] = text
    }
    if (Array.isArray(value.palette)) {
        photo.palette = value.palette
            .filter(color => typeof color === 'string' && /^#[0-9a-f]{6}$/.test(color))
            .slice(0, 5)
    }
    return photo
}

function sanitizeSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const key = safeText(value.key, 256)
    if (!key || !Array.isArray(value.items) || value.items.length > BROWSE_MAX_ITEMS) return null
    const items = value.items.map(sanitizePhoto)
    if (items.some(item => !item)) return null
    if (!isSafeCursor(value.nextCursor ?? null)) return null
    const dataSavedAt = Number(value.dataSavedAt)
    const lastAccessedAt = Number(value.lastAccessedAt)
    const scrollY = Number(value.scrollY)
    if (!Number.isFinite(dataSavedAt) || dataSavedAt <= 0) return null
    if (!Number.isFinite(lastAccessedAt) || lastAccessedAt <= 0) return null
    if (!Number.isFinite(scrollY) || scrollY < 0 || scrollY > 10_000_000) return null
    const seed = safeText(value.seed, 16)
    if (seed && !SEED_PATTERN.test(seed)) return null
    const snapshot = {
        key,
        items,
        nextCursor: value.nextCursor ?? null,
        seed,
        scrollY,
        dataSavedAt,
        lastAccessedAt,
    }
    const total = Number(value.total)
    if (Number.isFinite(total) && total >= 0 && total <= 10_000_000) snapshot.total = total
    return snapshot
}

function pruneSnapshots(now = Date.now()) {
    for (const [key, snapshot] of browseSnapshots) {
        if (now - snapshot.dataSavedAt > BROWSE_MAX_AGE_MS) browseSnapshots.delete(key)
    }
    while (browseSnapshots.size > BROWSE_MAX_ENTRIES) {
        const oldest = [...browseSnapshots.values()]
            .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt)[0]
        if (!oldest) break
        browseSnapshots.delete(oldest.key)
    }
}

function persistSnapshots() {
    const target = storage()
    if (!target) return
    try {
        pruneSnapshots()
        target.setItem(BROWSE_STORAGE_KEY, JSON.stringify({
            version: BROWSE_SCHEMA_VERSION,
            entries: [...browseSnapshots.values()],
        }))
    } catch {
        // Storage can be disabled or full. The in-memory snapshots remain useful.
    }
}

function loadSnapshots() {
    if (browseLoaded) return
    browseLoaded = true
    const target = storage()
    if (!target) return
    try {
        const parsed = JSON.parse(target.getItem(BROWSE_STORAGE_KEY) || 'null')
        if (parsed?.version !== BROWSE_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
            target.removeItem(BROWSE_STORAGE_KEY)
            return
        }
        for (const entry of parsed.entries.slice(0, BROWSE_MAX_ENTRIES * 2)) {
            const snapshot = sanitizeSnapshot(entry)
            if (snapshot) browseSnapshots.set(snapshot.key, snapshot)
        }
        pruneSnapshots()
        persistSnapshots()
    } catch {
        try { target.removeItem(BROWSE_STORAGE_KEY) } catch { /* best effort */ }
    }
}

function snapshotCopy(snapshot) {
    return {
        ...snapshot,
        items: snapshot.items.map(item => ({
            ...item,
            exif: { ...item.exif },
            previewSrcSet: item.previewSrcSet.map(value => ({ ...value })),
            palette: item.palette ? [...item.palette] : undefined,
        })),
    }
}

export function readExploreBrowseState(key) {
    loadSnapshots()
    pruneSnapshots()
    const snapshot = browseSnapshots.get(key)
    if (!snapshot) return null
    snapshot.lastAccessedAt = Date.now()
    browseSnapshots.delete(key)
    browseSnapshots.set(key, snapshot)
    persistSnapshots()
    return { ...snapshotCopy(snapshot), stale: Date.now() - snapshot.dataSavedAt > BROWSE_FRESH_MS }
}

export function writeExploreBrowseState(key, value) {
    loadSnapshots()
    if (!Array.isArray(value?.items)) return null
    if (value.items.length > BROWSE_MAX_ITEMS) {
        return browseSnapshots.get(key) ? snapshotCopy(browseSnapshots.get(key)) : null
    }
    const now = Date.now()
    const snapshot = sanitizeSnapshot({
        ...value,
        key,
        dataSavedAt: now,
        lastAccessedAt: now,
        scrollY: Number.isFinite(Number(value.scrollY)) ? Number(value.scrollY) : 0,
    })
    if (!snapshot) return null
    browseSnapshots.delete(key)
    browseSnapshots.set(key, snapshot)
    pruneSnapshots(now)
    persistSnapshots()
    return snapshotCopy(snapshot)
}

export function saveExploreBrowseScroll(key, scrollY) {
    loadSnapshots()
    const snapshot = browseSnapshots.get(key)
    const value = Number(scrollY)
    if (!snapshot || !Number.isFinite(value) || value < 0 || value > 10_000_000) return
    snapshot.scrollY = value
    snapshot.lastAccessedAt = Date.now()
    browseSnapshots.delete(key)
    browseSnapshots.set(key, snapshot)
    persistSnapshots()
}

export function clearExploreBrowseState() {
    browseLoaded = true
    browseSnapshots.clear()
    try { storage()?.removeItem(BROWSE_STORAGE_KEY) } catch { /* best effort */ }
}

export function clearExploreClientState() {
    clearExploreResponseCache()
    clearExploreBrowseState()
}
