const BOTTOM_GRACE_MS = 250
const RELEASE_MS = 380
const WHEEL_PULL_PX = 1200
const WHEEL_PULL_MS = 900
const TOUCH_PULL_PX = 180
const TOUCH_PULL_MS = 450
const INTERACTIVE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="listbox"], [role="dialog"], [aria-modal="true"]'

// Build resistance from continued input past the footer. Touch input has a
// physical contact; wheel input also needs sustained pressure and a check for
// the decaying tail of a trackpad fling, since browsers expose no momentum flag.
export function installFooterOverscroll({ onAttempt, onTrigger, onProgress }) {
    let bottomSince = null
    let lastWheelAt = -Infinity
    let lastDelta = 0
    let falling = 0
    let momentum = false
    let distance = 0
    let startedAt = null
    let warmed = false
    let triggered = false
    let releaseTimer
    let touch = null
    let activeKey = null

    const resetPull = () => {
        clearTimeout(releaseTimer)
        distance = 0
        startedAt = null
        warmed = false
        triggered = false
        onProgress?.(0)
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
            resetPull()
            if (touch) touch.bottomY = null
        } else if (bottomSince === null) {
            bottomSince = performance.now()
        }
    }

    const eligibleTarget = (target, keyboard = false) => {
        if (!(target instanceof Element) || target.closest(INTERACTIVE)
            || (keyboard && target.closest('a, button'))) return false
        // Scrolling a panel belongs to that panel, even at its own bottom.
        for (let node = target; node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node)
            if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflowX}`)
                && (node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2)) return false
        }
        return true
    }

    const applyPull = (nextDistance, requiredDistance, requiredMs) => {
        if (triggered) return
        const now = performance.now()
        startedAt ??= now
        distance = nextDistance
        const progress = Math.min(1, distance / requiredDistance, (now - startedAt) / requiredMs)
        if (!warmed && distance >= requiredDistance * 0.2) {
            warmed = true
            onAttempt?.()
        }
        onProgress?.(progress)
        if (progress >= 1) {
            triggered = true
            onProgress?.(0)
            onTrigger()
        }
    }

    const onWheel = (event) => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
            || event.deltaY <= 0 || Math.abs(event.deltaX) >= event.deltaY || !eligibleTarget(event.target)) {
            resetPull()
            lastDelta = 0
            return
        }
        const now = performance.now()
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
        const delta = event.deltaY * unit
        if (now - lastWheelAt > RELEASE_MS) resetPull()
        if (now - lastWheelAt > 220 || delta > lastDelta * 1.25) {
            falling = 0
            momentum = false
        } else if (delta < lastDelta * 0.97) {
            falling += 1
            if (falling >= 3) momentum = true
        } else if (!momentum) falling = 0
        lastDelta = delta
        lastWheelAt = now
        updateBottom()
        if (bottomSince === null || now - bottomSince < BOTTOM_GRACE_MS || momentum || delta < 4) {
            resetPull()
            return
        }
        clearTimeout(releaseTimer)
        releaseTimer = setTimeout(resetPull, RELEASE_MS)
        applyPull(distance + Math.min(delta, 64), WHEEL_PULL_PX, WHEEL_PULL_MS)
    }

    const onTouchStart = (event) => {
        resetPull()
        touch = !event.defaultPrevented && event.touches.length === 1 && eligibleTarget(event.target)
            ? { x: event.touches[0].clientX, bottomY: atFooter() ? event.touches[0].clientY : null, id: event.touches[0].identifier }
            : null
    }
    const cancelTouch = () => {
        touch = null
        resetPull()
    }
    const onTouchMove = (event) => {
        if (!touch) return
        const current = event.touches[0]
        if (event.defaultPrevented || event.touches.length !== 1 || current.identifier !== touch.id
            || Math.abs(current.clientX - touch.x) > 60 || !eligibleTarget(event.target)) {
            cancelTouch()
            return
        }
        updateBottom()
        if (bottomSince === null) return
        // A drag may begin above the footer: only its remaining travel once the
        // footer is reached contributes. Keep the finger down to activate.
        touch.bottomY ??= current.clientY
        const travel = Math.max(0, touch.bottomY - current.clientY)
        if (travel < distance - 6) {
            touch.bottomY = current.clientY
            resetPull()
            return
        }
        if (travel > 0) applyPull(travel, TOUCH_PULL_PX, TOUCH_PULL_MS)
    }
    const onKeyDown = (event) => {
        if (['ArrowUp', 'PageUp', 'Home', 'Escape'].includes(event.key)) {
            activeKey = null
            resetPull()
        }
        if (!['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)
            || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
        updateBottom()
        if (bottomSince === null || !eligibleTarget(event.target, true)) {
            activeKey = null
            resetPull()
            return
        }
        if (!event.repeat) { resetPull(); activeKey = event.key }
        if (activeKey !== event.key) return
        clearTimeout(releaseTimer)
        releaseTimer = setTimeout(resetPull, RELEASE_MS + 400)
        applyPull(distance + 48, WHEEL_PULL_PX, WHEEL_PULL_MS)
    }
    const onKeyUp = () => { activeKey = null; resetPull() }
    const onBlur = () => {
        bottomSince = null
        activeKey = null
        cancelTouch()
    }

    const listeners = [
        [window, 'scroll', updateBottom], [window, 'resize', onBlur],
        [window, 'wheel', onWheel], [window, 'touchstart', onTouchStart],
        [window, 'touchmove', onTouchMove], [window, 'touchend', cancelTouch],
        [window, 'touchcancel', cancelTouch], [window, 'keydown', onKeyDown],
        [window, 'keyup', onKeyUp], [window, 'blur', onBlur], [document, 'visibilitychange', onBlur],
    ]
    for (const [target, type, handler] of listeners) target.addEventListener(type, handler, { passive: true })
    updateBottom()
    return () => {
        clearTimeout(releaseTimer)
        for (const [target, type, handler] of listeners) target.removeEventListener(type, handler)
    }
}
