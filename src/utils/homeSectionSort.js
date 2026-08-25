export const HOME_SECTION_SORT_OPTIONS = [
    { value: 'curated', label: 'Curated order' },
    { value: 'newest', label: 'Newest albums' },
    { value: 'oldest', label: 'Oldest albums' },
    { value: 'title-asc', label: 'Title: A–Z' },
    { value: 'title-desc', label: 'Title: Z–A' },
    { value: 'most-albums', label: 'Most photo albums' },
    { value: 'fewest-albums', label: 'Fewest photo albums' },
]

function uploadedAt(album) {
    const timestamp = Date.parse(album?.uploadedAt || album?.createdAt || '')
    return Number.isFinite(timestamp) ? timestamp : null
}

function sectionUploadTime(category, groupedAlbums) {
    let newest = null
    for (const album of groupedAlbums[category] || []) {
        const timestamp = uploadedAt(album)
        if (timestamp !== null && (newest === null || timestamp > newest)) newest = timestamp
    }
    return newest
}

function compareNullableNumbers(left, right, direction) {
    if (left === null && right === null) return 0
    if (left === null) return 1
    if (right === null) return -1
    return direction * (left - right)
}

export function sortHomePhotoSections(curatedCategories, groupedAlbums, mode = 'curated') {
    const categories = [...curatedCategories]
    if (mode === 'curated') return categories

    const curatedIndex = new Map(categories.map((category, index) => [category, index]))
    const fallBackToCurated = (left, right) => curatedIndex.get(left) - curatedIndex.get(right)

    return categories.sort((left, right) => {
        let order
        if (mode === 'newest' || mode === 'oldest') {
            order = compareNullableNumbers(
                sectionUploadTime(left, groupedAlbums),
                sectionUploadTime(right, groupedAlbums),
                mode === 'newest' ? -1 : 1,
            )
        } else if (mode === 'title-asc' || mode === 'title-desc') {
            order = left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
            if (mode === 'title-desc') order *= -1
        } else if (mode === 'most-albums' || mode === 'fewest-albums') {
            const leftCount = groupedAlbums[left]?.length || 0
            const rightCount = groupedAlbums[right]?.length || 0
            order = mode === 'most-albums' ? rightCount - leftCount : leftCount - rightCount
        } else {
            return fallBackToCurated(left, right)
        }

        return order || fallBackToCurated(left, right)
    })
}
