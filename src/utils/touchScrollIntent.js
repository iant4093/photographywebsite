// A history swipe can still deliver movement after the restored page mounts.
// Only a new gesture can interrupt the page's scroll restoration or morph.
export function watchTouchScroll(onScroll, signal) {
    const options = { passive: true, capture: true, signal }
    let start
    const reset = () => { start = undefined }
    const begin = event => {
        const touch = event.touches?.length === 1 && event.touches[0]
        start = touch ? {
            id: touch.identifier,
            x: touch.clientX,
            y: touch.clientY,
            inScrollRow: event.target instanceof Element
                && event.target.closest('[data-scroll-row], .photo-stats-timeline-scroll, .floating-lane'),
        } : undefined
    }
    const move = event => {
        if (!start || event.touches?.length !== 1) return
        const touch = event.touches[0]
        if (touch.identifier !== start.id) return
        const x = Math.abs(touch.clientX - start.x)
        const y = Math.abs(touch.clientY - start.y)
        if (Math.max(x, y) < 8) return
        // Leave horizontal gestures at the OS navigation edges to the browser.
        const atEdge = start.x <= 24 || start.x >= window.innerWidth - 24
        const scrolling = y > x || (start.inScrollRow && !atEdge)
        reset()
        if (scrolling) onScroll(event)
    }
    window.addEventListener('touchstart', begin, options)
    window.addEventListener('touchmove', move, options)
    window.addEventListener('touchend', reset, options)
    window.addEventListener('touchcancel', reset, options)
    return () => {
        window.removeEventListener('touchstart', begin, true)
        window.removeEventListener('touchmove', move, true)
        window.removeEventListener('touchend', reset, true)
        window.removeEventListener('touchcancel', reset, true)
    }
}
