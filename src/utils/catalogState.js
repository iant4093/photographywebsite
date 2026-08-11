import { isSafeCursor, mergeUniqueById } from './apiResponse'

const catalogSnapshots = new Map()
const pendingCatalogMutations = new Map()
const MAX_SNAPSHOT_AGE_MS = 5 * 60_000
const MAX_PENDING_MUTATION_AGE_MS = 10 * 60_000
const MAX_CATALOG_PAGES = 100
const PUBLIC_ALBUM_FIELDS = [
    'albumId',
    'type',
    'title',
    'description',
    'category',
    'createdAt',
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

export function getCatalogSnapshot(key) {
    const snapshot = catalogSnapshots.get(key)
    if (!snapshot || Date.now() - snapshot.savedAt > MAX_SNAPSHOT_AGE_MS) return null
    return snapshot
}

export function setCatalogSnapshot(key, value) {
    catalogSnapshots.set(key, { ...value, savedAt: Date.now() })
}

export function invalidateCatalogSnapshots() {
    catalogSnapshots.clear()
}

export function clearCatalogSnapshots() {
    catalogSnapshots.clear()
    pendingCatalogMutations.clear()
}

export function deleteCatalogSnapshot(key) {
    catalogSnapshots.delete(key)
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
