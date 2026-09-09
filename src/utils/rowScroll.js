export const ROW_SCROLL_DURATION_MS = 600
const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value))
const SCROLL_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' '])

export function rowScrollTarget(element, direction, from = element.scrollLeft) {
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth)
    const current = clamp(from, maximum)
    const forward = direction === 'right'
    const desired = clamp(current + (forward ? 1 : -1) * element.clientWidth * 0.8, maximum)
    // Sibling layout offsets exclude the decorative transforms on album cards.
    // The first card's start is the row's padded resting position at scrollLeft 0.
    const first = element.firstElementChild?.offsetLeft || 0
    const stops = [...new Set([0, ...Array.from(element.children,
        child => clamp(child.offsetLeft - first, maximum)), maximum])].sort((a, b) => a - b)
    const candidates = stops.filter(stop => forward ? stop > current + 1 : stop < current - 1)
    if (!candidates.length) return current
    const withinPage = candidates.filter(stop => forward ? stop <= desired + 1 : stop >= desired - 1)
    return forward ? (withinPage.at(-1) ?? candidates[0]) : (withinPage[0] ?? candidates.at(-1))
}

// One animation owns desktop arrow scrolling. It exists only while an arrow
// move is active; wheel/touch/keyboard input takes over immediately.
export function createRowScrollController(element) {
    let frame = null
    let destination = null
    let lastDirection = null
    const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const cancel = () => {
        if (frame !== null) window.cancelAnimationFrame(frame)
        frame = null
        destination = null
        lastDirection = null
    }
    const keydown = event => { if (SCROLL_KEYS.has(event.key)) cancel() }
    const visibility = () => { if (document.hidden) cancel() }
    element.addEventListener('wheel', cancel, { passive: true })
    element.addEventListener('pointerdown', cancel, { passive: true })
    element.addEventListener('touchstart', cancel, { passive: true })
    element.addEventListener('keydown', keydown)
    window.addEventListener('resize', cancel)
    document.addEventListener('visibilitychange', visibility)
    motionPreference?.addEventListener?.('change', cancel)

    return {
        scroll(direction) {
            const start = clamp(element.scrollLeft, Math.max(0, element.scrollWidth - element.clientWidth))
            // Repeated presses advance the intended destination, not a partly
            // completed frame. Reversing starts from the actual current position.
            const from = lastDirection === direction && destination !== null ? destination : start
            const end = rowScrollTarget(element, direction, from)
            cancel()
            if (Math.abs(end - start) < 1 || motionPreference?.matches) {
                element.scrollLeft = end
                return
            }
            destination = end
            lastDirection = direction
            let startedAt = null
            const tick = timestamp => {
                startedAt ??= timestamp
                const progress = Math.min(1, (timestamp - startedAt) / ROW_SCROLL_DURATION_MS)
                const eased = (1 - Math.cos(Math.PI * progress)) / 2
                element.scrollLeft = start + (end - start) * eased
                if (progress < 1) frame = window.requestAnimationFrame(tick)
                else cancel()
            }
            frame = window.requestAnimationFrame(tick)
        },
        cancel,
        destroy() {
            cancel()
            element.removeEventListener('wheel', cancel)
            element.removeEventListener('pointerdown', cancel)
            element.removeEventListener('touchstart', cancel)
            element.removeEventListener('keydown', keydown)
            window.removeEventListener('resize', cancel)
            document.removeEventListener('visibilitychange', visibility)
            motionPreference?.removeEventListener?.('change', cancel)
        },
    }
}
