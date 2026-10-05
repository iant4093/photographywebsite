// TV mode: settings, ordering and the decode-ahead image cache.
import { mediaDisplayUrl, mediaId, mediaPreviewCandidates, mediaPreviewSrcSet } from './mediaUrls'

export const TV_SETTINGS_KEY = 'ian:tv-settings:v1'
export const TV_INTERVALS = [5, 8, 15, 30, 60]
export const TV_DEFAULTS = Object.freeze({
    interval: 8,
    order: 'shuffle',
    motion: true,
    clock: true,
    caption: true,
    progress: false,
    background: 'blur',
})

const CHOICES = {
    interval: TV_INTERVALS,
    order: ['shuffle', 'newest'],
    background: ['blur', 'dark'],
}

/** Saved settings merged over the defaults; anything unknown is ignored. */
export function readTvSettings(storage = globalThis.localStorage) {
    let saved
    try {
        saved = JSON.parse(storage?.getItem(TV_SETTINGS_KEY) || '{}')
    } catch {
        saved = null
    }
    const settings = { ...TV_DEFAULTS }
    for (const [key, value] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
        if (CHOICES[key] ? CHOICES[key].includes(value) : typeof TV_DEFAULTS[key] === 'boolean' && typeof value === 'boolean') {
            settings[key] = value
        }
    }
    return settings
}

export function saveTvSettings(settings, storage = globalThis.localStorage) {
    try {
        storage?.setItem(TV_SETTINGS_KEY, JSON.stringify(settings))
    } catch {
        // Private windows and blocked storage simply keep the defaults.
    }
}

export function shuffled(items, random = Math.random) {
    const result = [...items]
    for (let index = result.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1))
        ;[result[index], result[swap]] = [result[swap], result[index]]
    }
    return result
}

/** Usable favorites only: each needs a displayable image. */
export function slideshowPhotos(images) {
    const seen = new Set()
    return (Array.isArray(images) ? images : []).filter((image) => {
        const id = mediaId(image)
        if (!id || seen.has(id) || !(mediaPreviewSrcSet(image) || mediaDisplayUrl(image))) return false
        seen.add(id)
        return true
    })
}

/** The CSS width a photo occupies when contained in ``bounds``. */
export function fittedWidth(image, bounds) {
    if (!bounds?.width || !bounds?.height) return 0
    const width = Number(image?.width)
    const height = Number(image?.height)
    if (!(width > 0 && height > 0)) return bounds.width
    return Math.max(1, Math.ceil(Math.min(bounds.width, bounds.height * width / height)))
}

export function sizesFor(image, bounds) {
    const width = fittedWidth(image, bounds)
    return width ? `${width}px` : '100vw'
}

/** A small preview for the blurred backdrop. */
export function backdropUrl(image) {
    return mediaPreviewCandidates(image)[0]?.url || mediaDisplayUrl(image)
}

/**
 * Decodes photos ahead of the slideshow with the same srcset and sizes the
 * slide uses, so the browser picks the same file and the slide paints from
 * cache. Holds a reference to every decoded image it keeps, and releases the
 * ones that fall out of the window.
 */
export function createPreloader({ onReady, ImageClass = globalThis.Image } = {}) {
    const entries = new Map()
    let queue = []
    let active = 0
    const CONCURRENCY = 2

    function pump() {
        while (active < CONCURRENCY && queue.length) {
            const { key, image, sizes, decode } = queue.shift()
            const entry = entries.get(key)
            if (!entry || entry.started) continue
            entry.started = true
            active += 1
            const element = new ImageClass()
            entry.element = element
            element.decoding = 'async'
            if (decode) element.fetchPriority = 'high'
            const srcSet = mediaPreviewSrcSet(image)
            if (srcSet) {
                element.sizes = sizes
                element.srcset = srcSet
            }
            const finish = (ok) => {
                if (entry.finished) return
                entry.finished = true
                active -= 1
                if (entries.get(key) === entry) {
                    entry.ready = ok
                    entry.failed = !ok
                    onReady?.(key, ok)
                }
                pump()
            }
            element.onload = () => {
                if (!decode || typeof element.decode !== 'function') return finish(true)
                element.decode().then(() => finish(true), () => finish(true))
            }
            element.onerror = () => finish(false)
            element.src = mediaDisplayUrl(image)
        }
    }

    return {
        /** Keep exactly these photos: [{key, image, sizes, decode}] in priority order. */
        want(items) {
            const keep = new Set(items.map((item) => item.key))
            for (const [key, entry] of entries) {
                if (keep.has(key)) continue
                if (entry.element) {
                    entry.element.onload = entry.element.onerror = null
                    if (!entry.finished) {
                        entry.finished = true
                        active -= 1
                    }
                    entry.element.removeAttribute?.('srcset')
                    entry.element.removeAttribute?.('src')
                }
                entries.delete(key)
            }
            queue = []
            for (const item of items) {
                const current = entries.get(item.key)
                if (current && current.sizes !== item.sizes && !current.started) entries.delete(item.key)
                if (!entries.has(item.key)) entries.set(item.key, { sizes: item.sizes, started: false, ready: false })
                if (!entries.get(item.key).started) queue.push(item)
            }
            pump()
        },
        isReady(key) {
            return entries.get(key)?.ready === true
        },
        hasFailed(key) {
            return entries.get(key)?.failed === true
        },
        clear() {
            this.want([])
        },
    }
}
