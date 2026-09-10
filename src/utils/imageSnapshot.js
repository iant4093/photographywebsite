export const SNAPSHOT_EDGE = 192
export const MAX_IMAGE_SNAPSHOTS = 96
const snapshots = new Map()

export function releaseImageSnapshot(container) {
    const canvas = snapshots.get(container)
    if (canvas) {
        canvas.remove()
        canvas.width = canvas.height = 0
    }
    snapshots.delete(container)
}

export function touchImageSnapshot(container) {
    const canvas = snapshots.get(container)
    if (!canvas) return
    snapshots.delete(container)
    snapshots.set(container, canvas)
}

// Copy already-displayed pixels into a small backing surface. Drawing a
// cross-origin image is allowed; we never read/export its pixels or re-fetch it.
// At most 96 * 192 * 192 * 4 = 13.5 MiB of snapshot backing pixels are retained.
export function captureImageSnapshot(container, image) {
    if (!container || !image.naturalWidth || !image.naturalHeight) return
    if (snapshots.has(container)) { touchImageSnapshot(container); return }
    const canvas = document.createElement('canvas')
    const ratio = Math.min(1, SNAPSHOT_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
    try {
        const context = canvas.getContext('2d')
        if (!context) return
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
    } catch {
        // Keep the BlurHash fallback if this image cannot be drawn.
        return
    }
    canvas.className = 'progressive-image-snapshot absolute inset-0 h-full w-full object-cover'
    canvas.setAttribute('aria-hidden', 'true')
    container.append(canvas)
    snapshots.set(container, canvas)
    while (snapshots.size > MAX_IMAGE_SNAPSHOTS) releaseImageSnapshot(snapshots.keys().next().value)
}
