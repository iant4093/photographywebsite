import { isSafeCursor, mergeUniqueById } from './apiResponse'

const catalogSnapshots = new Map()
const pendingCatalogMutations = new Map()
const MAX_SNAPSHOT_AGE_MS = 5 * 60_000
const MAX_STALE_SNAPSHOT_AGE_MS = 30 * 60_000
const MAX_PENDING_MUTATION_AGE_MS = 10 * 60_000
const MAX_CATALOG_PAGES = 100
const MAX_PERSISTED_ITEMS = 500
const SNAPSHOT_SCHEMA_VERSION = 3
const SNAPSHOT_STORAGE_PREFIX = 'ian:public-catalog:v3:'
const PERSISTED_CATALOG_KEYS = ['public-photos', 'public-videos']
const PUBLIC_ALBUM_FIELDS = [
    'albumId',
    'type',
    'title',
    'description',
    'category',
    'createdAt',
    'uploadedAt',
    'visibility',
    'status',
    'imageCount',
    'coverImageUrl',
    'coverThumbnailUrl',
    'coverBlurhash',
    'galleryOrder',
    'galleryCategoryOrder',
]

function prunePendingCatalogMutations() {
    const cutoff = Date.now() - MAX_PENDING_MUTATION_AGE_MS
    for (const [albumId, mutation] of pendingCatalogMutations) {
        if (mutation.savedAt < cutoff) pendingCatalogMutations.delete(albumId)
    }
}

function albumMatchesType(album, type) {
    return type === 'video' ? album?.type === 'video' : album?.type !== 'video'
}

export class CatalogPaginationError extends Error {
    constructor(message, code) {
        super(message)
        this.name = 'CatalogPaginationError'
        this.code = code
    }
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return
    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
    throw new DOMException('Request aborted', 'AbortError')
}

function snapshotStorage() {
    try {
        return typeof window !== 'undefined' ? window.sessionStorage : null
    } catch {
        return null
    }
}

function storageKey(key) {
    return `${SNAPSHOT_STORAGE_PREFIX}${key}`
}

function validatedSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (value.version !== SNAPSHOT_SCHEMA_VERSION) return null
    if (!Number.isFinite(value.savedAt) || value.savedAt <= 0) return null
    if (!Array.isArray(value.items) || value.items.length > MAX_PERSISTED_ITEMS) return null
    if (!isSafeCursor(value.nextCursor ?? null)) return null
    if (value.items.some((album) => (
        !album
        || typeof album !== 'object'
        || Array.isArray(album)
        || typeof album.albumId !== 'string'
        || !album.albumId
    ))) return null
    return {
        items: value.items.map((album) => Object.fromEntries(
            PUBLIC_ALBUM_FIELDS
                .filter((field) => album[field] !== undefined)
                .map((field) => [field, album[field]]),
        )),
        nextCursor: value.nextCursor ?? null,
        savedAt: value.savedAt,
    }
}

function readPersistedSnapshot(key) {
    if (!PERSISTED_CATALOG_KEYS.includes(key)) return null
    const storage = snapshotStorage()
    if (!storage) return null
    try {
        const parsed = validatedSnapshot(JSON.parse(storage.getItem(storageKey(key)) || 'null'))
        if (!parsed || Date.now() - parsed.savedAt > MAX_STALE_SNAPSHOT_AGE_MS) {
            storage.removeItem(storageKey(key))
            return null
        }
        return parsed
    } catch {
        storage.removeItem(storageKey(key))
        return null
    }
}

function persistSnapshot(key, snapshot) {
    if (!PERSISTED_CATALOG_KEYS.includes(key)) return
    const storage = snapshotStorage()
    if (!storage || !Array.isArray(snapshot.items) || snapshot.items.length > MAX_PERSISTED_ITEMS) return
    try {
        const items = snapshot.items.map((album) => Object.fromEntries(
            PUBLIC_ALBUM_FIELDS
                .filter((field) => album?.[field] !== undefined)
                .map((field) => [field, album[field]]),
        ))
        storage.setItem(storageKey(key), JSON.stringify({
            version: SNAPSHOT_SCHEMA_VERSION,
            items,
            nextCursor: snapshot.nextCursor ?? null,
            savedAt: snapshot.savedAt,
        }))
    } catch {
        // Storage can be disabled or full. The in-memory cache remains valid.
    }
}

function removePersistedSnapshot(key) {
    try {
        snapshotStorage()?.removeItem(storageKey(key))
    } catch {
        // Storage cleanup is best effort.
    }
}

export function getCatalogSnapshot(key) {
    let snapshot = catalogSnapshots.get(key)
    if (!snapshot) {
        snapshot = readPersistedSnapshot(key)
        if (snapshot) catalogSnapshots.set(key, snapshot)
    }
    if (!snapshot) return null
    const age = Date.now() - snapshot.savedAt
    if (age > MAX_STALE_SNAPSHOT_AGE_MS) {
        catalogSnapshots.delete(key)
        removePersistedSnapshot(key)
        return null
    }
    return { ...snapshot, stale: age > MAX_SNAPSHOT_AGE_MS }
}

export function setCatalogSnapshot(key, value) {
    const snapshot = { ...value, savedAt: Date.now() }
    catalogSnapshots.set(key, snapshot)
    persistSnapshot(key, snapshot)
}

export function invalidateCatalogSnapshots() {
    catalogSnapshots.clear()
    for (const key of PERSISTED_CATALOG_KEYS) removePersistedSnapshot(key)
}

export function clearCatalogSnapshots() {
    invalidateCatalogSnapshots()
    pendingCatalogMutations.clear()
}

export function deleteCatalogSnapshot(key) {
    catalogSnapshots.delete(key)
    removePersistedSnapshot(key)
}

export function recordPublicCatalogUpsert(album) {
    const albumId = album?.albumId
    if (typeof albumId !== 'string' || !albumId) {
        invalidateCatalogSnapshots()
        return
    }
    const retainedFields = album.visibility === 'public'
        ? PUBLIC_ALBUM_FIELDS
        : ['albumId', 'type', 'visibility', 'status']
    const publicAlbum = Object.fromEntries(
        retainedFields
            .filter((field) => album[field] !== undefined)
            .map((field) => [field, album[field]]),
    )
    pendingCatalogMutations.set(albumId, {
        kind: 'upsert',
        album: publicAlbum,
        savedAt: Date.now(),
    })
    invalidateCatalogSnapshots()
}

export function recordPublicCatalogDeletion(albumId) {
    if (typeof albumId !== 'string' || !albumId) {
        invalidateCatalogSnapshots()
        return
    }
    pendingCatalogMutations.set(albumId, { kind: 'delete', savedAt: Date.now() })
    invalidateCatalogSnapshots()
}

export function reconcilePublicCatalogItems(items, type) {
    prunePendingCatalogMutations()
    const reconciled = new Map()
    for (const album of Array.isArray(items) ? items : []) {
        if (album?.albumId && albumMatchesType(album, type)) reconciled.set(album.albumId, album)
    }

    for (const [albumId, mutation] of pendingCatalogMutations) {
        reconciled.delete(albumId)
        const album = mutation.album
        if (
            mutation.kind === 'upsert'
            && album?.visibility === 'public'
            && (album.status === undefined || album.status === 'active')
            && albumMatchesType(album, type)
        ) {
            reconciled.set(albumId, album)
        }
    }

    return [...reconciled.values()].sort((left, right) => (
        String(right?.createdAt || '').localeCompare(String(left?.createdAt || ''))
    ))
}

export async function loadCompleteCatalog({
    fetchPage,
    initialItems = [],
    initialCursor = null,
    hasInitialPage = false,
    onPage,
    signal,
}) {
    if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function')

    let items = initialItems
    let cursor = hasInitialPage ? initialCursor : null
    const seenCursors = new Set()

    throwIfAborted(signal)
    if (hasInitialPage && !cursor) return { items, nextCursor: null }

    for (let pageNumber = 0; pageNumber < MAX_CATALOG_PAGES; pageNumber += 1) {
        throwIfAborted(signal)
        if (cursor) {
            if (seenCursors.has(cursor)) {
                throw new CatalogPaginationError(
                    'The service returned an invalid pagination sequence.',
                    'REPEATED_CURSOR',
                )
            }
            seenCursors.add(cursor)
        }

        const page = await fetchPage(cursor)
        throwIfAborted(signal)
        items = mergeUniqueById(items, page?.items || [])
        cursor = page?.nextCursor ?? null
        if (!isSafeCursor(cursor)) {
            throw new CatalogPaginationError(
                'The service returned an invalid pagination cursor.',
                'BAD_CURSOR',
            )
        }

        const snapshot = { items, nextCursor: cursor }
        onPage?.(snapshot)
        if (!cursor) return snapshot
    }

    throw new CatalogPaginationError(
        'The catalog exceeded the safe pagination limit.',
        'PAGE_LIMIT',
    )
}
