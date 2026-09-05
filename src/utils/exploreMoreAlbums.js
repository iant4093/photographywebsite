const SELECTION_LIMIT = 3
const STORAGE_PREFIX = 'ian:explore-more:v1:'

export function selectExploreMoreAlbums(items, { albumId, category, type }) {
    const categoryName = category || 'Uncategorized'
    const mediaType = type === 'video' ? 'video' : 'photo'
    const candidates = [...new Map(items.filter((album) => (
        album?.albumId
        && album.albumId !== albumId
        && album.visibility === 'public'
        && (album.status === undefined || album.status === 'active')
        && (album.category || 'Uncategorized') === categoryName
        && (album.type === 'video' ? 'video' : 'photo') === mediaType
    )).map((album) => [album.albumId, album])).values()]

    // Partially shuffle the complete category pool, sampling without replacement.
    const count = Math.min(SELECTION_LIMIT, candidates.length)
    for (let index = 0; index < count; index += 1) {
        const randomIndex = index + Math.floor(Math.random() * (candidates.length - index))
        ;[candidates[index], candidates[randomIndex]] = [candidates[randomIndex], candidates[index]]
    }
    const selection = candidates.slice(0, count)
    const storageKey = `${STORAGE_PREFIX}${JSON.stringify([mediaType, categoryName, albumId])}`

    try {
        const previousIds = JSON.parse(window.sessionStorage.getItem(storageKey) || '[]')
        // A fresh random draw can repeat by chance. Swap in an unselected album
        // when possible so returning to this page also changes the membership.
        if (
            candidates.length > count
            && Array.isArray(previousIds)
            && previousIds.length === count
            && selection.every((album) => previousIds.includes(album.albumId))
        ) {
            const replacementIndex = count + Math.floor(Math.random() * (candidates.length - count))
            selection[Math.floor(Math.random() * count)] = candidates[replacementIndex]
        }
        window.sessionStorage.setItem(storageKey, JSON.stringify(selection.map((album) => album.albumId)))
    } catch {
        // Random sampling still works when browser storage is unavailable.
    }

    return selection
}
