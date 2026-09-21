// URL-only history, not decoded image storage. Different responsive candidates
// and refreshed signed URLs remain different images. Never persisted to disk.
const ready = new Set()
const LIMIT = 192

export function isImageReady(url) {
    return Boolean(url && ready.has(url))
}

export function markImageReady(url) {
    if (!url) return
    ready.delete(url)
    ready.add(url)
    if (ready.size > LIMIT) ready.delete(ready.values().next().value)
}
