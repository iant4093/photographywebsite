import { isImageReady, markImageReady } from './imageReadiness'
import { mediaPreviewCandidates } from './mediaUrls'

export function allowPhotoPrefetch() {
    const connection = navigator.connection
    return !document.hidden && !connection?.saveData
        && !['slow-2g', '2g', '3g'].includes(connection?.effectiveType)
        && !(connection?.downlink > 0 && connection.downlink < 1.5)
}

// One responsive preview, never an original. The caller owns and releases this
// one decoded image on navigation/unmount. URLs already seen in the grid skip it.
export function prefetchPhoto(image, cssWidth) {
    const candidates = mediaPreviewCandidates(image)
    if (!allowPhotoPrefetch() || !candidates.length || !(cssWidth > 0)) return () => {}
    const width = cssWidth * (window.devicePixelRatio || 1)
    const candidate = candidates.find(item => item.width >= width) || candidates.at(-1)
    const decodedBytes = candidate.width ** 2 * Number(image.height) / Number(image.width) * 4
    if (!Number.isFinite(decodedBytes) || decodedBytes > 12 * 1024 * 1024 || isImageReady(candidate.url)) return () => {}
    const preload = new Image()
    let active = true
    preload.decoding = 'async'
    preload.fetchPriority = 'low'
    preload.onload = () => {
        Promise.resolve().then(() => preload.decode?.()).then(() => {
            if (active) markImageReady(candidate.url)
        }).catch(() => {})
    }
    preload.src = candidate.url
    return () => {
        active = false
        preload.onload = null
        preload.removeAttribute('src')
    }
}
