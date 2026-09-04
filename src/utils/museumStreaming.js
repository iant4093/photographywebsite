// Keep the only uploads allowed during navigation small and evenly spaced.
// Detail textures still wait for idle time; base photographs must make progress
// even when a visitor holds W for the entire length of an archive room.
export const MUSEUM_BASE_COVER_WIDTH = 256
export const MUSEUM_VISIBLE_COVER_PRIORITY = 9000

export function museumCoverUploadAllowed({
    width = 0,
    priority = 0,
    interactionBusy = false,
    inputPending = false,
    sinceLastUpload = Infinity,
    lastUploadDuration = 0,
} = {}) {
    if (inputPending) return false
    if (!interactionBusy) return true
    const interval = Math.max(100, Math.min(320, lastUploadDuration * 16))
    return width > 0 && width <= MUSEUM_BASE_COVER_WIDTH
        && priority >= MUSEUM_VISIBLE_COVER_PRIORITY
        && sinceLastUpload >= interval
}

export function museumPreloadPaintings(rooms, limit = 76) {
    // Prepare the first viewing area of every nearby room before spending the
    // entire look-ahead budget on the far end of the largest category.
    const result = []
    const seen = new Set()
    const longest = Math.max(0, ...rooms.map(room => room.paintings.length))
    for (let start = 0; start < longest && result.length < limit; start += 8) {
        for (const room of rooms) {
            for (const painting of room.paintings.slice(start, start + 8)) {
                if (seen.has(painting.id)) continue
                seen.add(painting.id)
                result.push(painting)
                if (result.length >= limit) return result
            }
        }
    }
    return result
}
