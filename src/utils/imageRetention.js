export const RECENT_IMAGE_LIFETIME_MS = 8000
export const MAX_RECENT_IMAGES = 24
export const MAX_RECENT_IMAGE_BYTES = 24 * 1024 * 1024
const UNKNOWN_IMAGE_BYTES = 1024 * 1024

// These are estimates of decoded pixels, not network transfer sizes. With a
// width-descriptor srcset, naturalWidth is density-corrected; use the selected
// source width so high-DPI images cannot silently exceed the retention budget.
export function decodedImageBytes(image) {
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (!width || !height) return UNKNOWN_IMAGE_BYTES
    let sourceWidth = width
    if (image.srcset) {
        sourceWidth = width * Math.max(1, window.devicePixelRatio || 1)
        for (const candidate of image.srcset.split(',')) {
            const match = candidate.trim().match(/^(\S+)\s+(\d+)w$/)
            if (!match) continue
            try {
                if (new URL(match[1], document.baseURI).href === image.currentSrc) {
                    sourceWidth = Number(match[2])
                    break
                }
            } catch { /* Keep the conservative fallback for malformed srcsets. */ }
        }
    }
    return Math.ceil(sourceWidth * sourceWidth * height / width * 4)
}

let shared = null

function createRetentionObserver() {
    const records = new Map()
    const recent = new Map()
    let recentBytes = 0
    let timer = null
    const forget = element => {
        const record = recent.get(element)
        if (!record) return
        recentBytes -= record.bytes
        recent.delete(element)
    }
    const evict = element => {
        const record = recent.get(element)
        forget(element)
        record.resident = false
        record.change(false)
    }
    const prune = () => {
        window.clearTimeout(timer)
        timer = null
        const now = Date.now()
        for (const [element, record] of recent) {
            if (record.expiresAt <= now || recent.size > MAX_RECENT_IMAGES || recentBytes > MAX_RECENT_IMAGE_BYTES) evict(element)
            else break
        }
        const oldest = recent.values().next().value
        if (oldest) timer = window.setTimeout(prune, Math.max(0, oldest.expiresAt - now))
    }
    const observer = new IntersectionObserver(entries => {
        // Protect returning images before making room for newly distant ones.
        for (const entry of entries) {
            const record = records.get(entry.target)
            if (!record || !entry.isIntersecting) continue
            forget(entry.target)
            record.resident = true
            record.change(true)
        }
        for (const entry of entries) {
            const record = records.get(entry.target)
            if (!record || entry.isIntersecting || !record.resident || recent.has(entry.target)) continue
            record.expiresAt = Date.now() + RECENT_IMAGE_LIFETIME_MS
            recent.set(entry.target, record)
            recentBytes += record.bytes
        }
        prune()
    }, {
        rootMargin: '800px',
        // rootMargin alone cannot see past nested horizontal scroll clipping.
        // Older browsers ignore this option; retention still works there.
        scrollMargin: '0px 360px',
        threshold: 0,
    })
    const hidden = () => {
        if (!document.hidden) return
        for (const element of recent.keys()) evict(element)
        prune()
    }
    document.addEventListener('visibilitychange', hidden)

    return {
        add(element, change) {
            records.set(element, { change, resident: false, bytes: UNKNOWN_IMAGE_BYTES })
            observer.observe(element)
        },
        loaded(element, image) {
            const record = records.get(element)
            if (!record) return
            const bytes = decodedImageBytes(image)
            if (recent.has(element)) recentBytes += bytes - record.bytes
            record.bytes = bytes
            prune()
        },
        remove(element) {
            forget(element)
            records.delete(element)
            observer.unobserve?.(element)
            prune()
            return records.size
        },
        destroy() {
            window.clearTimeout(timer)
            observer.disconnect()
            document.removeEventListener('visibilitychange', hidden)
        },
    }
}

export function observeRetainedImage(element, change) {
    if (typeof IntersectionObserver === 'undefined') {
        change(true)
        return { loaded() {}, dispose() {} }
    }
    shared ??= createRetentionObserver()
    const owner = shared
    owner.add(element, change)
    return {
        loaded: image => owner.loaded(element, image),
        dispose() {
            if (owner.remove(element) === 0) {
                owner.destroy()
                if (shared === owner) shared = null
            }
        },
    }
}
