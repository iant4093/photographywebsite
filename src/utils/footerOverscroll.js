const SETTLE_MS = 700
const GESTURE_GAP_MS = 220
const ATTEMPT_WINDOW_MS = 5000
const MIN_ATTEMPT_SPACING_MS = 350
const INTERACTIVE = 'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="listbox"], [role="dialog"], [aria-modal="true"]'

// Count fresh gestures, never wheel-event volume: a single trackpad fling can
// produce hundreds of events after the document has reached the footer.
export function installFooterOverscroll({ onAttempt, onTrigger }) {
    let bottomSince = null
    let lastWheelAt = -Infinity
    let wheelDistance = 0
    let wheelEligible = false
    let attempts = 0
    let lastAttemptAt = -Infinity
    let touch = null

    const resetAttempts = () => {
        attempts = 0
        lastAttemptAt = -Infinity
        wheelEligible = false
        wheelDistance = 0
    }

    const atFooter = () => {
        const footer = document.querySelector('.linen-footer')
        if (!footer || document.visibilityState === 'hidden') return false
        const root = document.scrollingElement || document.documentElement
        const viewport = window.innerHeight
        const rect = footer.getBoundingClientRect()
        const bodyStyle = getComputedStyle(document.body)
        const rootStyle = getComputedStyle(document.documentElement)
        return rect.height > 0 && rect.bottom <= viewport + 3 && rect.bottom > 0
            && root.scrollHeight - viewport - Math.max(0, window.scrollY) <= 3
            && !document.querySelector('[aria-modal="true"], dialog[open]')
            && !['hidden', 'clip'].includes(bodyStyle.overflowY || bodyStyle.overflow)
            && !['hidden', 'clip'].includes(rootStyle.overflowY || rootStyle.overflow)
    }

    const updateBottom = () => {
        if (!atFooter()) {
            bottomSince = null
            resetAttempts()
        } else if (bottomSince === null) {
            bottomSince = performance.now()
        }
    }

    const eligibleTarget = (target) => {
        if (!(target instanceof Element) || target.closest(INTERACTIVE)) return false
        // Scroll gestures inside any scrollable panel belong to that panel,
        // including when it has already reached its own bottom.
        for (let node = target; node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node)
            if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflowX}`)
                && (node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2)) return false
        }
        return true
    }

    const ready = (target) => {
        updateBottom()
        return bottomSince !== null && performance.now() - bottomSince >= SETTLE_MS
            && eligibleTarget(target)
    }

    const countAttempt = () => {
        const now = performance.now()
        if (now - lastAttemptAt < MIN_ATTEMPT_SPACING_MS) return
        if (now - lastAttemptAt > ATTEMPT_WINDOW_MS) attempts = 0
        lastAttemptAt = now
        attempts += 1
        if (attempts === 1) onAttempt?.()
        if (attempts >= 3) {
            resetAttempts()
            onTrigger()
        }
    }

    const onWheel = (event) => {
        const now = performance.now()
        const freshGesture = now - lastWheelAt >= GESTURE_GAP_MS
        lastWheelAt = now
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
            || event.deltaY <= 0 || Math.abs(event.deltaX) >= event.deltaY || !ready(event.target)) {
            resetAttempts()
            return
        }
        if (freshGesture) {
            wheelDistance = 0
            wheelEligible = true
        }
        if (!wheelEligible) return
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
        wheelDistance += Math.min(event.deltaY * unit, 160)
        if (wheelDistance >= 100) {
            wheelEligible = false
            countAttempt()
        }
    }

    const onTouchStart = (event) => {
        touch = !event.defaultPrevented && event.touches.length === 1 && ready(event.target)
            ? { x: event.touches[0].clientX, y: event.touches[0].clientY, id: event.touches[0].identifier }
            : null
        if (!touch) resetAttempts()
    }
    const onTouchMove = (event) => {
        if (!touch) return
        const current = event.touches[0]
        if (event.touches.length !== 1 || current.identifier !== touch.id
            || current.clientY > touch.y + 12 || Math.abs(current.clientX - touch.x) > 60) {
            touch = null
            resetAttempts()
        }
    }
    const onTouchEnd = (event) => {
        const start = touch
        touch = null
        const end = Array.from(event.changedTouches).find(point => point.identifier === start?.id)
        if (!start || !end || !ready(event.target)) return
        const distance = start.y - end.clientY
        if (distance >= 80 && distance > Math.abs(start.x - end.clientX) * 1.5) countAttempt()
    }
    const cancelTouch = () => {
        touch = null
        resetAttempts()
    }
    const onKeyDown = (event) => {
        if (['ArrowUp', 'PageUp', 'Home', 'Escape'].includes(event.key)) resetAttempts()
        if (!['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)
            || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
        if (ready(event.target)) countAttempt()
        else resetAttempts()
    }
    const onBlur = () => {
        bottomSince = null
        cancelTouch()
    }

    const listeners = [
        [window, 'scroll', updateBottom], [window, 'resize', onBlur],
        [window, 'wheel', onWheel], [window, 'touchstart', onTouchStart],
        [window, 'touchmove', onTouchMove], [window, 'touchend', onTouchEnd],
        [window, 'touchcancel', cancelTouch], [window, 'keydown', onKeyDown],
        [window, 'blur', onBlur], [document, 'visibilitychange', onBlur],
    ]
    for (const [target, type, handler] of listeners) target.addEventListener(type, handler, { passive: true })
    updateBottom()
    return () => {
        for (const [target, type, handler] of listeners) target.removeEventListener(type, handler)
    }
}
