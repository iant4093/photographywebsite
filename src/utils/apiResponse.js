export function normalizePage(payload) {
    if (Array.isArray(payload)) return { items: payload, nextCursor: null }
    if (!payload || typeof payload !== 'object') return { items: [], nextCursor: null }

    const items = Array.isArray(payload.items)
        ? payload.items
        : Array.isArray(payload.albums)
            ? payload.albums
            : []

    const page = {
        items,
        nextCursor: payload.nextToken || payload.nextCursor || payload.cursor || payload.paginationToken || null,
    }
    if (Number.isFinite(Number(payload.total)) && Number(payload.total) >= 0) {
        page.total = Number(payload.total)
    }
    return page
}

export function mergeUniqueById(existing, incoming) {
    const merged = new Map()
    for (const item of [...existing, ...incoming]) {
        const key = item?.albumId || item?.id
        if (key) merged.set(key, item)
    }
    return [...merged.values()]
}

export function isSafeCursor(cursor) {
    return cursor == null || (typeof cursor === 'string' && cursor.length <= 4096)
}
