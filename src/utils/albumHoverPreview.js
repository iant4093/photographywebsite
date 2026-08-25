import { mediaPreviewCandidates } from './mediaUrls'

export const ALBUM_HOVER_DELAY_MS = 650
export const ALBUM_HOVER_FRAME_MS = 2200
export const ALBUM_HOVER_FADE_MS = 600
export const ALBUM_HOVER_PREVIEW_WIDTH = 640
export const ALBUM_HOVER_PREVIEW_LIMIT = 5

function comparablePath(value) {
    if (!value) return ''
    try {
        return new URL(value, window.location.origin).pathname
    } catch {
        return String(value).split(/[?#]/, 1)[0]
    }
}

export function canRunAlbumHoverPreview() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function selectAlbumHoverPreviews(detail, coverImageUrl, random = Math.random) {
    const coverPath = comparablePath(coverImageUrl)
    const seen = new Set()
    const candidates = (Array.isArray(detail?.images) ? detail.images : [])
        .filter((image) => {
            const imagePaths = [image?.url, image?.thumbnailUrl, image?.coverImageUrl]
                .map(comparablePath)
                .filter(Boolean)
            return !coverPath || !imagePaths.includes(coverPath)
        })
        .map((image) => {
            const preview = mediaPreviewCandidates(image)
                .find(({ width }) => width === ALBUM_HOVER_PREVIEW_WIDTH)
            return preview?.url ? { url: preview.url } : null
        })
        .filter((preview) => {
            if (!preview || seen.has(preview.url)) return false
            seen.add(preview.url)
            return true
        })

    for (let index = candidates.length - 1; index > 0; index -= 1) {
        const sample = Math.min(0.999999, Math.max(0, Number(random()) || 0))
        const swapIndex = Math.floor(sample * (index + 1))
        ;[candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]]
    }

    return candidates.slice(0, ALBUM_HOVER_PREVIEW_LIMIT)
}

export function preloadAlbumHoverPreview(url) {
    if (!url || typeof Image === 'undefined') return Promise.reject(new Error('Image loading unavailable'))

    return new Promise((resolve, reject) => {
        const image = new Image()
        let settled = false
        const finish = (callback, value) => {
            if (settled) return
            settled = true
            image.onload = null
            image.onerror = null
            callback(value)
        }

        image.decoding = 'async'
        image.fetchPriority = 'low'
        image.onload = () => finish(resolve, image)
        image.onerror = () => finish(reject, new Error('Album preview failed to load'))
        image.src = url
        image.decode?.().then(() => finish(resolve, image)).catch(() => {})
    })
}

function stylePreviewImage(image) {
    image.alt = ''
    image.setAttribute('aria-hidden', 'true')
    image.setAttribute('draggable', 'false')
    image.className = 'absolute inset-0 h-full w-full object-cover pointer-events-none'
    Object.assign(image.style, {
        zIndex: '10',
        opacity: '0',
        transition: `opacity ${ALBUM_HOVER_FADE_MS}ms ease`,
    })
}

export function start({ container, coverImageUrl, loadDetail }) {
    if (!canRunAlbumHoverPreview()) return { stop() {} }

    let active = true
    let currentImage = null
    const timers = new Set()
    const previewImages = new Set()
    const later = (callback, delay) => {
        const timer = window.setTimeout(() => {
            timers.delete(timer)
            if (active) callback()
        }, delay)
        timers.add(timer)
    }

    later(async () => {
        const detail = await loadDetail()
        if (!active) return
        const frames = selectAlbumHoverPreviews(detail, coverImageUrl)
        if (frames.length < 2) return

        let frameIndex = 0
        const failed = new Set()
        const showNextFrame = async () => {
            if (!active) return
            let nextFrame = null
            while (!nextFrame && failed.size < frames.length) {
                const candidate = frames[frameIndex % frames.length]
                frameIndex += 1
                if (failed.has(candidate.url)) continue
                try {
                    nextFrame = {
                        ...candidate,
                        image: await preloadAlbumHoverPreview(candidate.url),
                    }
                } catch {
                    failed.add(candidate.url)
                }
            }
            if (!nextFrame || !active) return

            const previousImage = currentImage
            const nextImage = nextFrame.image
            stylePreviewImage(nextImage)
            previewImages.add(nextImage)
            container?.appendChild(nextImage)
            currentImage = nextImage
            later(() => {
                nextImage.style.opacity = '1'
                if (previousImage) {
                    previousImage.style.opacity = '0'
                    later(() => {
                        previousImage.remove()
                        previewImages.delete(previousImage)
                    }, ALBUM_HOVER_FADE_MS)
                }
                later(showNextFrame, ALBUM_HOVER_FRAME_MS)
            }, 16)
        }

        await showNextFrame()
    }, ALBUM_HOVER_DELAY_MS)

    return {
        stop() {
            active = false
            timers.forEach((timer) => window.clearTimeout(timer))
            timers.clear()
            previewImages.forEach((image) => image.remove())
            previewImages.clear()
            currentImage = null
        },
    }
}
