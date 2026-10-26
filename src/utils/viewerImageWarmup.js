import { isImageReady, markImageReady } from './imageReadiness'
import { mediaPreviewCandidates } from './mediaUrls'
import { allowPhotoPrefetch } from './photoPrefetch'

// Load the exact srcSet candidate a contain-fit viewer will request into the
// HTTP cache, without decoding it. Unlike prefetchPhoto this has no decoded-size
// cap, so tall portraits are warmed too. Images, not fetch: the CSP allows
// Google's thumbnail host for img-src only.
export function warmViewerImage(photo, cssWidth) {
    const candidates = mediaPreviewCandidates(photo)
    if (!allowPhotoPrefetch() || !candidates.length || !(cssWidth > 0)) return () => {}
    const width = cssWidth * (window.devicePixelRatio || 1)
    const candidate = candidates.find(item => item.width >= width) || candidates.at(-1)
    if (isImageReady(candidate.url)) return () => {}
    const image = new Image()
    image.decoding = 'async'
    image.fetchPriority = 'low'
    image.onload = () => markImageReady(candidate.url)
    image.src = candidate.url
    return () => {
        image.onload = null
        // Abort only unfinished downloads; finished ones stay in the cache.
        if (!image.complete) image.removeAttribute('src')
    }
}
