export const HOME_SECTION_SORT_OPTIONS = [
    'Curated order',
    'Newest albums',
    'Oldest albums',
    'Title: A–Z',
    'Title: Z–A',
    'Most photo albums',
    'Fewest photo albums',
]

export function sortHomePhotoSections(curatedCategories, groupedAlbums, mode = 0) {
    const categories = [...curatedCategories]
    if (!Number.isInteger(mode) || mode < 1 || mode > 6) return categories

    const curatedIndex = new Map(categories.map((category, index) => [category, index]))
    const latestUpload = (category) => (groupedAlbums[category] || []).reduce((latest, album) => {
        const next = album?.uploadedAt || album?.createdAt || ''
        return next > latest ? next : latest
    }, '')

    return categories.sort((left, right) => {
        let order
        if (mode < 3) {
            const leftDate = latestUpload(left)
            const rightDate = latestUpload(right)
            order = !leftDate || !rightDate
                ? (!leftDate && rightDate ? 1 : (leftDate && !rightDate ? -1 : 0))
                : leftDate.localeCompare(rightDate) * (mode === 1 ? -1 : 1)
        } else if (mode < 5) {
            order = left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
            if (mode === 4) order *= -1
        } else {
            const leftCount = groupedAlbums[left]?.length || 0
            const rightCount = groupedAlbums[right]?.length || 0
            order = mode === 5 ? rightCount - leftCount : leftCount - rightCount
        }

        return order || curatedIndex.get(left) - curatedIndex.get(right)
    })
}
