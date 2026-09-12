const CAMERA = '<path d="M8 5 9.5 3.5h5L16 5h4a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V6.5A1.5 1.5 0 0 1 4 5Z"/><circle cx="12" cy="12" r="4.2"/><path d="M18 8h.5"/><circle cx="12" cy="12" r=".55"/>'
const SYMBOLS = {
    camera: CAMERA,
    photo: CAMERA + '<g class="camera-cursor-flash"><path d="M18 1v-3m3 5 2.5-2.5M23 7h3"/></g>',
    link: '<path d="m5 19 14-14M5 5h14v14"/>',
    next: '<path d="M3 12h18m-7-7 7 7-7 7"/>',
    previous: '<path d="M21 12H3m7-7-7 7 7 7"/>',
    close: '<path d="m5 5 14 14M19 5 5 19"/>',
    'zoom-in': '<circle cx="10" cy="10" r="7"/><path d="m15 15 7 7M6.5 10h7M10 6.5v7"/>',
    'zoom-out': '<circle cx="10" cy="10" r="7"/><path d="m15 15 7 7M6.5 10h7"/>',
    'drag-y': '<path d="M12 2v20M8 6l4-4 4 4M8 18l4 4 4-4M8 10h8m-8 4h8"/>',
    'drag-y-held': '<path d="M12 5v14M9 8l3-3 3 3M9 16l3 3 3-3M10 10.5h4m-4 3h4"/>',
    loading: '<circle cx="12" cy="12" r="9"/><path d="m12 3 5 9m3-6-6 9m4 4H8m4 2-5-9m-3 6 6-9M6 5h10"/>',
}

// Native controls retain their own pointer without computed-style reads.
const NATIVE_SELECTOR = [
    '[data-camera-cursor="native"]', '[inert]', ':disabled', '[aria-disabled="true"]',
    'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"])',
    'textarea', 'select', '[contenteditable]:not([contenteditable="false"])',
    'audio', 'iframe', 'dialog[open]',
    '[role="slider"]', '[role="spinbutton"]',
].join(',')
const ACTION_SELECTOR = 'a[href], button, summary, label, [role="button"], [role="link"], input[type="checkbox"], input[type="radio"], input[type="button"], input[type="submit"], input[type="reset"]'
const TEXT_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre, code, dt, dd'

function measureText(element) {
    const rectangles = []
    const range = document.createRange()
    if (typeof range.getClientRects !== 'function') return rectangles
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text
    while ((text = walker.nextNode())) {
        if (!text.textContent.trim()) continue
        range.selectNodeContents(text)
        // A text range gives one rectangle per rendered line, excluding the
        // empty remainder of the block and the space after its last line.
        for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) rectangles.push(rect)
        }
    }
    return rectangles
}

function classifyTarget(pointed) {
    if (pointed.closest(NATIVE_SELECTOR)) return { native: true }
    const annotated = pointed.closest('[data-camera-cursor]')
    const requested = annotated?.getAttribute('data-camera-cursor')
    const media = pointed.closest('video, canvas')
    const decorativeAlbumMedia = requested === 'photo'
        && media?.closest('[aria-hidden="true"]') && !media.hasAttribute('controls')
    if (media && !decorativeAlbumMedia) return { native: true }
    let state = Object.hasOwn(SYMBOLS, requested) ? requested : null
    if (!state && pointed.closest('[aria-busy="true"]')) state = 'loading'
    if (!state && pointed.closest(ACTION_SELECTOR)) state = 'link'
    return {
        state: state || 'camera',
        text: !state && Boolean(pointed.closest(TEXT_SELECTOR)),
    }
}

// Small static SVGs are rendered by the browser's native cursor layer. Mouse
// position never waits for JavaScript, layout, React, or an animation frame.
const CURSORS = Object.fromEntries(Object.entries(SYMBOLS).map(([state, geometry]) => {
    const variant = scale => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="-7 -7 38 38" fill="none" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(12 12) scale(${scale}) translate(-12 -12)"><g stroke="#fffdf8" stroke-width="4.2">${geometry}</g><g stroke="#231f1a" stroke-width="1.55">${geometry}</g></g></svg>`
        return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, auto`
    }
    return [state, { normal: variant(1), pressed: variant(0.8) }]
}))

export function installCameraCursor() {
    const finePointer = window.matchMedia('(any-pointer: fine)')
    const forcedColors = window.matchMedia('(forced-colors: active)')
    const root = document.documentElement
    let frame = null
    let inside = false
    let pointerType = 'mouse'
    let x = 0
    let y = 0
    let pressed = false
    let lastTarget = null
    let dragTarget = null
    let state = null
    let visible = false
    let appliedIcon = null
    let classifiedTarget = null
    let classification = null
    let textRectangles = null
    let observedText = null
    let needsHitTest = false
    const removers = []
    const listen = (target, name, callback, options) => {
        target.addEventListener(name, callback, options)
        removers.push(() => target.removeEventListener(name, callback, options))
    }
    const hide = () => {
        if (!visible) return
        visible = false
        root.removeAttribute('data-camera-cursor-active')
    }
    const suspend = () => {
        inside = false
        pressed = false
        dragTarget = null
        hide()
    }

    function update() {
        frame = null
        // Consume changes that arrived between the pointer event and this frame.
        // Ordinary movement otherwise uses the browser's event target directly.
        readMutations(observer.takeRecords())
        if (!inside || pointerType !== 'mouse' || !finePointer.matches || forcedColors.matches
            || document.hidden || document.fullscreenElement || document.pointerLockElement) {
            hide()
            return
        }
        const pointed = dragTarget?.isConnected ? dragTarget
            : needsHitTest || !(lastTarget instanceof Element) || !lastTarget.isConnected
                ? document.elementFromPoint?.(x, y) || lastTarget : lastTarget
        needsHitTest = false
        lastTarget = pointed
        if (!(pointed instanceof Element) || !pointed.isConnected) {
            hide()
            return
        }
        if (classifiedTarget !== pointed || !classification) {
            classifiedTarget = pointed
            classification = classifyTarget(pointed)
            textRectangles = null
            const nextText = classification.text ? pointed : null
            if (nextText !== observedText) {
                textResizeObserver?.disconnect()
                observedText = nextText
                if (observedText) textResizeObserver?.observe(observedText)
            }
        }
        if (classification.native) {
            hide()
            return
        }
        if (classification.text) {
            textRectangles ??= measureText(pointed)
            if (textRectangles.some(rect => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)) {
                hide()
                return
            }
        }
        let nextState = classification.state
        if (nextState === 'drag-y' && pressed) nextState = 'drag-y-held'
        const icon = CURSORS[nextState][pressed ? 'pressed' : 'normal']
        if (appliedIcon !== icon) {
            appliedIcon = icon
            root.style.setProperty('--camera-cursor-image', icon)
        }
        if (state !== nextState) {
            state = nextState
            root.dataset.cameraCursorState = state
        }
        if (!visible) {
            visible = true
            root.setAttribute('data-camera-cursor-active', '')
        }
    }

    const schedule = () => {
        if (inside && frame === null) frame = window.requestAnimationFrame(update)
    }
    const layoutChanged = event => {
        if (event?.target === root && event.type !== 'scroll') return
        textRectangles = null
        needsHitTest = true
        schedule()
    }
    const textResizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(layoutChanged)
    const move = (event) => {
        readMutations(observer.takeRecords())
        pointerType = event.pointerType
        x = event.clientX
        y = event.clientY
        const changed = lastTarget !== event.target || !inside
        lastTarget = event.target
        inside = true
        if (pointerType !== 'mouse') suspend()
        else if (changed || !classification || classification.text || needsHitTest) schedule()
    }
    const release = () => {
        pressed = false
        dragTarget = null
        needsHitTest = true
        schedule()
    }

    listen(document, 'pointermove', move, { passive: true })
    listen(document, 'pointerover', move, { passive: true })
    listen(document, 'pointerdown', (event) => {
        if (event.pointerType !== 'mouse') { suspend(); return }
        if (event.button !== 0) return
        move(event)
        pressed = true
        dragTarget = event.target instanceof Element ? event.target.closest('[data-camera-cursor="drag-y"]') : null
        schedule()
    }, { passive: true })
    listen(document, 'pointerup', release, { passive: true })
    listen(document, 'pointercancel', suspend, { passive: true })
    listen(document, 'lostpointercapture', release, { passive: true })
    listen(document, 'pointerout', (event) => { if (!event.relatedTarget) suspend() }, { passive: true })
    listen(root, 'pointerleave', suspend, { passive: true })
    listen(window, 'blur', suspend)
    listen(document, 'visibilitychange', suspend)
    listen(document, 'fullscreenchange', suspend)
    listen(document, 'pointerlockchange', suspend)
    listen(document, 'dragstart', suspend)
    listen(document, 'keydown', (event) => { if (event.key === 'Tab') suspend() })
    listen(document, 'scroll', layoutChanged, { capture: true, passive: true })
    listen(window, 'resize', layoutChanged, { passive: true })
    listen(document, 'load', layoutChanged, { capture: true, passive: true })
    if (document.fonts?.addEventListener) listen(document.fonts, 'loadingdone', layoutChanged)
    listen(document, 'transitionend', layoutChanged, { passive: true })
    listen(document, 'animationend', layoutChanged, { passive: true })
    listen(finePointer, 'change', suspend)
    listen(forcedColors, 'change', suspend)

    // Refresh a stationary pointer when a route, lazy image, or portal changes.
    // Cursor styles live on html, outside this body observer.
    function readMutations(records) {
        const changed = records.some(record => record.type !== 'characterData' || classifiedTarget?.contains(record.target))
        if (changed) {
            classification = null
            textRectangles = null
            needsHitTest = true
        }
        return changed
    }
    const observer = new MutationObserver(records => { if (readMutations(records)) schedule() })
    observer.observe(document.body, {
        childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ['data-camera-cursor', 'disabled', 'aria-disabled', 'aria-busy', 'aria-hidden', 'controls', 'inert', 'contenteditable', 'open', 'href', 'type', 'role'],
    })

    return () => {
        removers.forEach(remove => remove())
        observer.disconnect()
        textResizeObserver?.disconnect()
        if (frame !== null) window.cancelAnimationFrame(frame)
        hide()
        root.removeAttribute('data-camera-cursor-state')
        root.style.removeProperty('--camera-cursor-image')
    }
}
