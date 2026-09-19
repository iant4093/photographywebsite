import { fetchRandomPhotos } from './api'
import { cdnUrl, mediaPreviewCandidates } from './mediaUrls'

function previewOnly(photo) {
    // mediaThumbnailUrl deliberately falls back to originals elsewhere in the
    // site. This decorative effect must never take that fallback.
    return mediaPreviewCandidates(photo)[0]?.url || photo?.thumbnailUrl || cdnUrl(photo?.thumbKey) || ''
}

function preload(url, signal) {
    return new Promise(resolve => {
        if (signal.aborted) return resolve(null)
        const image = new Image()
        let settled = false
        const finish = (loaded) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            signal.removeEventListener('abort', abort)
            image.onload = null
            image.onerror = null
            if (!loaded) image.removeAttribute('src')
            resolve(loaded ? url : null)
        }
        const abort = () => finish(false)
        const timeout = setTimeout(abort, 3500)
        signal.addEventListener('abort', abort, { once: true })
        image.decoding = 'async'
        image.fetchPriority = 'low'
        image.onload = () => {
            if (image.decode) image.decode().then(() => finish(!signal.aborted), () => finish(false))
            else finish(!signal.aborted)
        }
        image.onerror = abort
        image.src = url
    })
}

export async function loadMistyEchoPhotos(signal) {
    const { images } = await fetchRandomPhotos({ category: 'Misty', limit: 6, priority: 'low', signal })
    if (signal.aborted) return []
    const urls = [...new Set(images.map(previewOnly).filter(Boolean))].slice(0, 6)
    return (await Promise.all(urls.map(url => preload(url, signal)))).filter(Boolean)
}
