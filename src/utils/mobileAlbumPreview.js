import { canRunAlbumPreview, MOBILE_PREVIEW_QUERY, REDUCED_MOTION_QUERY } from './albumPreviewPolicy'

export const MOBILE_PREVIEW_DWELL_MS = 550
const MIN_VISIBLE = 0.6
let coordinator = null

// All catalog rows share one observer, idle timer, and active preview. Scrolling
// only cancels work; layout is read once the visitor has settled on a card.
function createCoordinator() {
    const cards = new Map()
    const visible = new Set()
    const pointers = new Set()
    const removers = []
    let observer = null
    let timer = null
    let active = null
    const listen = (target, name, callback, options) => {
        target?.addEventListener?.(name, callback, options)
        removers.push(() => target?.removeEventListener?.(name, callback, options))
    }
    const stop = () => {
        window.clearTimeout(timer)
        timer = null
        active?.stop()
        active = null
    }
    const blocked = () => document.hidden || pointers.size > 0
        || document.documentElement.hasAttribute('data-lightbox-scroll-lock')
        || document.documentElement.hasAttribute('data-menu-scroll-lock')
    const select = () => {
        timer = null
        if (!canRunAlbumPreview('focus') || blocked() || active) return
        const width = window.innerWidth
        const height = window.innerHeight
        let best = null
        let distance = Infinity
        for (const element of visible) {
            if (!element.isConnected) continue
            const rect = element.getBoundingClientRect()
            if (!rect.width || !rect.height) continue
            const x = rect.left + rect.width / 2
            const y = rect.top + rect.height / 2
            const dx = Math.abs(x / width - 0.5)
            const dy = Math.abs(y / height - 0.5)
            // Ignore peripheral cards even if a short row is fully visible.
            if (dx > 0.35 || dy > 0.3) continue
            const pointed = document.elementFromPoint(x, y)
            if (!pointed || !element.contains(pointed)) continue
            const score = dx * dx + dy * dy
            if (score < distance) { best = element; distance = score }
        }
        if (!best) return
        active = cards.get(best)
        // Retain this selection after a finite preview ends or autoplay is
        // denied. Observer notifications must not start an endless retry loop.
        active?.start()
    }
    const schedule = () => {
        if (observer && !active && timer === null && !blocked()) {
            timer = window.setTimeout(select, MOBILE_PREVIEW_DWELL_MS)
        }
    }
    const moved = () => { stop(); schedule() }
    const configure = () => {
        const previous = active
        stop()
        // A responsive/hybrid device can switch from a desktop hover while
        // media is still loading. Cancel those controllers before mobile focus
        // is allowed to choose a different card.
        cards.forEach(callbacks => { if (callbacks !== previous) callbacks.stop() })
        observer?.disconnect()
        observer = null
        visible.clear()
        if (!canRunAlbumPreview('focus') || typeof IntersectionObserver === 'undefined') return
        observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting && entry.intersectionRatio >= MIN_VISIBLE) visible.add(entry.target)
                else {
                    visible.delete(entry.target)
                    if (active === cards.get(entry.target)) stop()
                }
            }
            schedule()
        }, { threshold: [0, MIN_VISIBLE] })
        cards.forEach((_callbacks, element) => observer.observe(element))
    }
    listen(document, 'scroll', moved, { capture: true, passive: true })
    listen(window, 'resize', moved, { passive: true })
    listen(window.visualViewport, 'resize', moved, { passive: true })
    listen(document, 'pointerdown', event => { pointers.add(event.pointerId); stop() }, { passive: true })
    const release = event => { pointers.delete(event.pointerId); schedule() }
    listen(document, 'pointerup', release, { passive: true })
    listen(document, 'pointercancel', release, { passive: true })
    listen(window, 'blur', () => { pointers.clear(); stop() })
    listen(document, 'visibilitychange', () => { pointers.clear(); moved() })
    listen(window.matchMedia(MOBILE_PREVIEW_QUERY), 'change', configure)
    listen(window.matchMedia(REDUCED_MOTION_QUERY), 'change', configure)
    listen(navigator.connection, 'change', configure)
    const locks = new MutationObserver(moved)
    locks.observe(document.documentElement, {
        attributes: true, attributeFilter: ['data-lightbox-scroll-lock', 'data-menu-scroll-lock'],
    })
    configure()
    return {
        add(element, callbacks) { cards.set(element, callbacks); observer?.observe(element) },
        remove(element) {
            if (active === cards.get(element)) stop()
            cards.delete(element)
            visible.delete(element)
            observer?.unobserve(element)
            schedule()
            return cards.size
        },
        destroy() { stop(); observer?.disconnect(); locks.disconnect(); removers.forEach(remove => remove()) },
    }
}

export function registerMobileAlbumPreview(element, callbacks) {
    if (!element) return () => {}
    coordinator ??= createCoordinator()
    const owner = coordinator
    owner.add(element, callbacks)
    return () => {
        if (owner.remove(element) === 0) {
            owner.destroy()
            if (coordinator === owner) coordinator = null
        }
    }
}
