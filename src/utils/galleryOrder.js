function normalizedOrder(value) {
    return Number.isInteger(value) && value >= 0 ? value : null
}

function compareNewestFirst(left, right) {
    const dateOrder = String(right?.createdAt || '').localeCompare(String(left?.createdAt || ''))
    if (dateOrder !== 0) return dateOrder
    const titleOrder = String(left?.title || '').localeCompare(
        String(right?.title || ''),
        undefined,
        { sensitivity: 'base', numeric: true },
    )
    if (titleOrder !== 0) return titleOrder
    return String(left?.albumId || '').localeCompare(String(right?.albumId || ''))
}

export function compareGalleryAlbums(left, right) {
    const leftOrder = normalizedOrder(left?.galleryOrder)
    const rightOrder = normalizedOrder(right?.galleryOrder)
    if (leftOrder !== null || rightOrder !== null) {
        if (leftOrder === null) return 1
        if (rightOrder === null) return -1
        if (leftOrder !== rightOrder) return leftOrder - rightOrder
    }

    return compareNewestFirst(left, right)
}

export function sortGalleryAlbums(albums) {
    return [...albums].sort(compareGalleryAlbums)
}

function categoryOrder(category, groupedAlbums) {
    const albums = groupedAlbums[category] || []
    for (const album of albums) {
        const order = normalizedOrder(album?.galleryCategoryOrder)
        if (order !== null) return order
    }
    return null
}

export function sortGalleryCategories(categories, groupedAlbums) {
    return [...categories].sort((left, right) => {
        const leftOrder = categoryOrder(left, groupedAlbums)
        const rightOrder = categoryOrder(right, groupedAlbums)
        if (leftOrder !== null || rightOrder !== null) {
            if (leftOrder === null) return 1
            if (rightOrder === null) return -1
            if (leftOrder !== rightOrder) return leftOrder - rightOrder
        }
        if (left === 'Uncategorized') return 1
        if (right === 'Uncategorized') return -1
        return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
    })
}
