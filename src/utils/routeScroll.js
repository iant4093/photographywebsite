const positions = new Map()
const STORAGE_KEY = 'ian:route-scroll:v1'
const MAX_ENTRIES = 100

export function clearRouteScrollPositions() {
    positions.clear()
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* optional */ }
}

function readPositions() {
    try {
        const values = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]')
        for (const [key, value] of values.slice(-MAX_ENTRIES)) {
            if (typeof key === 'string' && Number.isFinite(value?.top) && value.top >= 0) positions.set(key, value)
        }
    } catch { /* Scroll memory also works when storage is unavailable. */ }
}

function persist() {
    while (positions.size > MAX_ENTRIES) positions.delete(positions.keys().next().value)
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...positions])) } catch { /* optional */ }
}

const locked = () => document.documentElement.matches('[data-lightbox-scroll-lock], [data-menu-scroll-lock]')
const offset = () => ({ top: Math.max(0, window.scrollY), left: Math.max(0, window.scrollX) })

function containerPath(element) {
    const main = document.getElementById('main-content')
    if (!(element instanceof Element) || !main?.contains(element)
        || element.closest('[role="dialog"], [role="listbox"]')) return null
    const path = []
    for (let node = element; node && node !== main; node = node.parentElement) {
        path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node))
    }
    return path.join('.')
}

function findContainer(path) {
    let node = document.getElementById('main-content')
    for (const index of path.split('.')) node = node?.children[Number(index)]
    return node
}

// Observe layout instead of guessing how many milliseconds an API, lazy chunk,
// font, or image will need. Never save a clamped intermediate restoration.
export function watchScrollPosition({ key, route, restore, restoreRoute, fallback, hash, preserve }) {
    if (!positions.size) readPositions()
    const saved = restore ? positions.get(key) || (restoreRoute ? positions.get(`return:${route}`) : null) : null
    let target = saved || (fallback !== undefined ? { top: fallback, left: 0 } : null)
    if (!target && !hash && !preserve && locked()) target = { top: 0, left: 0 }
    let pending = Boolean(target || hash)
    let current = target || (preserve ? offset() : { top: 0, left: 0 })
    let containers = { ...current.containers }
    let frame = 0
    let disposed = false
    let restoring = false
    let settledTimer = 0
    const root = document.documentElement
    const oldAnchor = root.style.overflowAnchor
    if (pending) root.style.overflowAnchor = 'none'

    const remember = () => {
        const value = { ...current, containers }
        positions.set(key, value)
        positions.set(`return:${route}`, value)
    }
    const finish = () => {
        pending = false
        root.style.overflowAnchor = oldAnchor
        resize?.disconnect()
        mutations.disconnect()
        window.clearTimeout(settledTimer)
    }
    const attempt = () => {
        frame = 0
        if (disposed || !pending || locked()) return
        const main = document.getElementById('main-content')
        if (main?.querySelector('[data-route-loading]')) return
        const busy = main?.querySelector('[aria-busy="true"], [data-scroll-loading="true"]')
        if (!target && hash) {
            if (busy) return
            let id
            try { id = decodeURIComponent(hash.slice(1)) } catch { id = hash.slice(1) }
            const anchor = document.getElementById(id)
            if (!anchor) return
            anchor.scrollIntoView?.({ block: 'start' })
            current = offset()
            remember()
            finish()
            return
        }
        if (!target) return
        restoring = true
        window.scrollTo({ top: target.top, left: target.left || 0, behavior: 'instant' })
        restoring = false
        let reached = Math.abs(window.scrollY - target.top) <= 1
        for (const [path, position] of Object.entries(containers)) {
            const element = findContainer(path)
            if (!element) { reached = false; continue }
            element.scrollTop = position.top
            element.scrollLeft = position.left
            if (Math.abs(element.scrollTop - position.top) > 1 || Math.abs(element.scrollLeft - position.left) > 1) reached = false
        }
        // A short stable layout window covers fonts/images immediately after
        // mounting. Resize/mutation events restart it; user input ends it.
        window.clearTimeout(settledTimer)
        if (reached && !busy) settledTimer = window.setTimeout(finish, 250)
    }
    const schedule = () => {
        if (!frame && pending) frame = window.requestAnimationFrame(attempt)
    }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    const mutations = new MutationObserver(schedule)
    if (pending) {
        resize?.observe(document.body)
        mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy', 'data-scroll-loading'] })
        mutations.observe(root, { attributes: true, attributeFilter: ['data-lightbox-scroll-lock', 'data-menu-scroll-lock'] })
        schedule()
    } else if (!preserve) {
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    }
    const save = () => {
        if (pending || restoring || locked()) return
        current = offset()
        remember()
    }
    const saveContainer = event => {
        if (pending || locked()) return
        const path = containerPath(event.target)
        if (path === null) return
        containers = { ...containers, [path]: { top: event.target.scrollTop, left: event.target.scrollLeft } }
        remember()
    }
    const interrupt = event => {
        if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
        if (locked()) return
        if (pending) {
            finish()
            target = null
        }
        save()
    }
    const pagehide = () => { save(); persist() }
    // Capture clicks before React navigation can replace the document content.
    document.addEventListener('click', save, true)
    document.addEventListener('scroll', saveContainer, { capture: true, passive: true })
    window.addEventListener('scroll', save, { passive: true })
    window.addEventListener('pagehide', pagehide)
    window.addEventListener('wheel', interrupt, { passive: true })
    window.addEventListener('touchstart', interrupt, { passive: true })
    window.addEventListener('keydown', interrupt)
    return () => {
        disposed = true
        // Cleanup may run after the old DOM has disappeared. Use our last
        // observed offset, never window.scrollY from the shorter next page.
        remember()
        persist()
        finish()
        window.cancelAnimationFrame(frame)
        document.removeEventListener('click', save, true)
        document.removeEventListener('scroll', saveContainer, true)
        window.removeEventListener('scroll', save)
        window.removeEventListener('pagehide', pagehide)
        window.removeEventListener('wheel', interrupt)
        window.removeEventListener('touchstart', interrupt)
        window.removeEventListener('keydown', interrupt)
    }
}
