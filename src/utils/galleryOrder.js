function normalizedOrder(value) {
    return Number.isInteger(value) && value >= 0 ? value : null
}

export function compareGalleryAlbums(left, right) {
    const leftOrder = normalizedOrder(left?.galleryOrder)
    const rightOrder = normalizedOrder(right?.galleryOrder)
    if (leftOrder !== null || rightOrder !== null) {
        if (leftOrder === null) return 1
        if (rightOrder === null) return -1
        if (leftOrder !== rightOrder) return leftOrder - rightOrder
    }

    const titleOrder = String(left?.title || '').localeCompare(
        String(right?.title || ''),
        undefined,
        { sensitivity: 'base', numeric: true },
    )
    if (titleOrder !== 0) return titleOrder
    return String(left?.albumId || '').localeCompare(String(right?.albumId || ''))
}

export function sortGalleryAlbums(albums) {
    return [...albums].sort(compareGalleryAlbums)
}
