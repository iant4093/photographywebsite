export const RECENT_IMAGE_LIFETIME_MS = 8000
export const MAX_RECENT_IMAGES = 24
export const MAX_RECENT_IMAGE_BYTES = 24 * 1024 * 1024
const UNKNOWN_IMAGE_BYTES = 1024 * 1024

function backgroundLoadLimit() {
    const connection = navigator.connection
    if (connection?.saveData) return 0
    return /(^|-)2g$|3g/.test(connection?.effectiveType || '')
        || (connection?.downlink > 0 && connection.downlink < 2)
        || connection?.rtt >= 150 ? 1 : 2
}

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
    let loadFrame = null
    const observers = new Map()
    const waiting = new Set()
    const loading = new Set()
    const priorityWaiting = new Set()
    const priorityLoading = new Set()
    let viewportObserver = null
    const startPriorityLoad = element => {
        priorityWaiting.delete(element)
        priorityLoading.add(element)
        const record = records.get(element)
        record.resident = true
        record.change(true)
    }
    const pump = () => {
        if (loadFrame !== null || document.hidden || (!waiting.size && !priorityWaiting.size)) return
        loadFrame = requestAnimationFrame(() => {
            loadFrame = null
            if (document.hidden) return
            for (const element of waiting) {
                if (loading.size >= 2) break
                waiting.delete(element)
                const record = records.get(element)
                if (!record?.visible) continue
                loading.add(element)
                record.resident = true
                record.change(true)
            }
            // Visible photos never wait for an offscreen download to finish,
            // including after a fast scroll or browser Back restoration.
            for (const element of priorityWaiting) {
                if (records.get(element)?.inViewport) startPriorityLoad(element)
            }
            // Both observers must have reported before starting speculation.
            // Eager first-row images participate in this gate too.
            if ([...priorityWaiting, ...priorityLoading].some(element => {
                const record = records.get(element)
                return !record.viewportKnown || (record.inViewport && priorityLoading.has(element))
            })) return
            const limit = backgroundLoadLimit()
            for (const element of priorityWaiting) {
                if (priorityLoading.size >= limit) break
                startPriorityLoad(element)
            }
        })
    }
    const releaseLoad = element => {
        waiting.delete(element)
        loading.delete(element)
        priorityWaiting.delete(element)
        priorityLoading.delete(element)
        pump()
    }
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
        releaseLoad(element)
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
    const notify = entries => {
        // Protect returning images before making room for newly distant ones.
        for (const entry of entries) {
            const record = records.get(entry.target)
            if (!record || !entry.isIntersecting) continue
            record.visible = true
            forget(entry.target)
            if (record.viewportFirst && !record.resident) priorityWaiting.add(entry.target)
            else if (record.near && !record.resident) waiting.add(entry.target)
            else {
                record.resident = true
                record.change(true)
            }
        }
        for (const entry of entries) {
            const record = records.get(entry.target)
            if (!record || entry.isIntersecting) continue
            record.visible = false
            waiting.delete(entry.target)
            priorityWaiting.delete(entry.target)
            if (record.eager || !record.resident || recent.has(entry.target)) continue
            record.expiresAt = Date.now() + RECENT_IMAGE_LIFETIME_MS
            recent.set(entry.target, record)
            recentBytes += record.bytes
        }
        prune()
        pump()
    }
    const observerFor = near => {
        if (!observers.has(near)) observers.set(near, new IntersectionObserver(notify, {
            rootMargin: near ? '120px 0px' : '800px',
            // Only the featured strip uses the narrow, queued loading window.
            // Both policies still share the same decoded-memory/retention cap.
            scrollMargin: near ? '0px 100px' : '0px 360px',
            threshold: 0,
        }))
        return observers.get(near)
    }
    const hidden = () => {
        if (!document.hidden) { pump(); return }
        for (const element of recent.keys()) evict(element)
        prune()
    }
    document.addEventListener('visibilitychange', hidden)
    navigator.connection?.addEventListener?.('change', pump)

    return {
        add(element, change, near, { viewportFirst = false, eager = false }) {
            const observer = observerFor(near)
            records.set(element, { change, near, observer, viewportFirst, eager,
                viewportKnown: false, inViewport: false, visible: false, resident: eager, bytes: UNKNOWN_IMAGE_BYTES })
            if (viewportFirst) {
                viewportObserver ??= new IntersectionObserver(entries => {
                    for (const entry of entries) {
                        const record = records.get(entry.target)
                        if (!record) continue
                        record.viewportKnown = true
                        record.inViewport = entry.isIntersecting
                    }
                    pump()
                }, { rootMargin: '0px', threshold: 0 })
                if (eager) priorityLoading.add(element)
                viewportObserver.observe(element)
            }
            observer.observe(element)
        },
        loaded(element, image) {
            const record = records.get(element)
            if (!record) return
            if (record.viewportFirst) record.resident = true
            const bytes = decodedImageBytes(image)
            if (recent.has(element)) recentBytes += bytes - record.bytes
            record.bytes = bytes
            releaseLoad(element)
            prune()
        },
        remove(element) {
            forget(element)
            records.get(element)?.observer.unobserve?.(element)
            if (records.get(element)?.viewportFirst) viewportObserver?.unobserve(element)
            records.delete(element)
            releaseLoad(element)
            prune()
            return records.size
        },
        destroy() {
            window.clearTimeout(timer)
            if (loadFrame !== null) cancelAnimationFrame(loadFrame)
            observers.forEach(observer => observer.disconnect())
            viewportObserver?.disconnect()
            waiting.clear()
            loading.clear()
            priorityWaiting.clear()
            priorityLoading.clear()
            document.removeEventListener('visibilitychange', hidden)
            navigator.connection?.removeEventListener?.('change', pump)
        },
    }
}

export function observeRetainedImage(element, change, near = false, priority = {}) {
    if (typeof IntersectionObserver === 'undefined') {
        change(true)
        return { loaded() {}, dispose() {} }
    }
    shared ??= createRetentionObserver()
    const owner = shared
    owner.add(element, change, near, priority)
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
