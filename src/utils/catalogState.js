import { isSafeCursor, mergeUniqueById } from './apiResponse'

const catalogSnapshots = new Map()
const MAX_SNAPSHOT_AGE_MS = 5 * 60_000
const MAX_CATALOG_PAGES = 100

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

export function clearCatalogSnapshots() {
    catalogSnapshots.clear()
}

export function deleteCatalogSnapshot(key) {
    catalogSnapshots.delete(key)
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
