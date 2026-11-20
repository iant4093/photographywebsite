export const MUSEUM_BASE_COVER_WIDTH = 960
export const MUSEUM_VISIBLE_COVER_PRIORITY = 9000
export const MUSEUM_APPROACH_PRIORITY = 11000
export const MUSEUM_INSPECTION_COVER_WIDTH = 1920
export const MUSEUM_LOW_POWER_INSPECTION_WIDTH = 1440
export const MUSEUM_DETAIL_BLEND_SECONDS = 0.65

export function museumArtworkFallbackWidths(targetWidth) {
    return [...new Set([targetWidth, MUSEUM_BASE_COVER_WIDTH])]
        .filter(width => width > 0 && width <= targetWidth)
}

export function museumCoverLoadAllowed({ width = 0, priority = 0, interactionBusy = false, inputPending = false } = {}) {
    if (inputPending) return false
    if (!interactionBusy) return true
    if (width <= 0) return false
    if (width <= MUSEUM_BASE_COVER_WIDTH) return priority >= MUSEUM_VISIBLE_COVER_PRIORITY
    return width <= MUSEUM_INSPECTION_COVER_WIDTH && priority >= MUSEUM_APPROACH_PRIORITY
}

export function museumArtworkBlend(elapsed, duration = MUSEUM_DETAIL_BLEND_SECONDS) {
    const progress = Math.max(0, Math.min(1, elapsed / duration))
    return progress * progress * (3 - (2 * progress))
}

export function museumArtworkTransitionProgress(elapsed, revealElapsed, delta) {
    const step = Math.max(0, Math.min(0.05, delta))
    const nextElapsed = Math.min(MUSEUM_DETAIL_BLEND_SECONDS, elapsed + step)
    const nextReveal = Math.min(MUSEUM_DETAIL_BLEND_SECONDS, revealElapsed + step)
    return { elapsed: nextElapsed, revealElapsed: nextReveal, blend: museumArtworkBlend(nextElapsed), opacity: museumArtworkBlend(nextReveal) }
}

export function museumArtworkPreviewCandidates(candidates, currentIds = new Set()) {
    // The same six slots can prepare photographs just beyond the view edge or
    // farther down the room. Nearby side walls stay ready for a natural turn;
    // distant photographs behind the visitor never consume this budget.
    return candidates.filter(({ painting, distance, facing, visible }) => (
        Number.isFinite(distance) && distance >= 0
        && distance <= (currentIds.has(painting.id) ? 40 : 36)
        && (visible || facing > 0.2 || distance < 10)
    )).sort((left, right) => (
        // Prefer the current viewing area, with a small release bias to avoid
        // cancelling/recreating texture jobs at a painting-row boundary.
        (left.distance - (left.visible ? 3 : 0) - (currentIds.has(left.painting.id) ? 1 : 0))
        - (right.distance - (right.visible ? 3 : 0) - (currentIds.has(right.painting.id) ? 1 : 0))
    ))
}

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
    const eligible = museumCoverLoadAllowed({ width, priority, interactionBusy, inputPending })
    const minInterval = width > MUSEUM_BASE_COVER_WIDTH ? 240 : 100
    const interval = Math.max(minInterval, Math.min(480, lastUploadDuration * 16))
    return eligible && sinceLastUpload >= interval
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
