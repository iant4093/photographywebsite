const CAMERA = '<path d="M8 5 9.5 3.5h5L16 5h4a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V6.5A1.5 1.5 0 0 1 4 5Z"/><circle cx="12" cy="12" r="4.2"/><path d="M18 8h.5"/><circle cx="12" cy="12" r=".55"/>'
const SYMBOLS = {
    camera: CAMERA,
    photo: CAMERA + '<g class="camera-cursor-flash"><path d="M18 1v-3m3 5 2.5-2.5M23 7h3"/></g>',
    link: '<path d="m5 19 14-14M5 5h14v14"/>',
    next: '<path d="M3 12h18m-7-7 7 7-7 7"/>',
    previous: '<path d="M21 12H3m7-7-7 7 7 7"/>',
    close: '<path d="m5 5 14 14M19 5 5 19"/>',
    'drag-y': '<path d="M12 2v20M8 6l4-4 4 4M8 18l4 4 4-4M8 10h8m-8 4h8"/>',
    'drag-y-held': '<path d="M12 5v14M9 8l3-3 3 3M9 16l3 3 3-3M10 10.5h4m-4 3h4"/>',
    loading: '<circle cx="12" cy="12" r="9"/><path d="m12 3 5 9m3-6-6 9m4 4H8m4 2-5-9m-3 6 6-9M6 5h10"/>',
}

// Native controls retain their own pointer; no computed cursor lookup is used,
// because the active overlay temporarily hides CSS cursors on the document.
const NATIVE_SELECTOR = [
    '[data-camera-cursor="native"]', '[inert]', ':disabled', '[aria-disabled="true"]',
    'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"])',
    'textarea', 'select', '[contenteditable]:not([contenteditable="false"])',
    'video', 'audio', 'iframe', 'canvas', 'dialog[open]',
    '[role="slider"]', '[role="spinbutton"]',
].join(',')
const ACTION_SELECTOR = 'a[href], button, summary, label, [role="button"], [role="link"], input[type="checkbox"], input[type="radio"], input[type="button"], input[type="submit"], input[type="reset"]'
const TEXT_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre, code, dt, dd'

function symbolMarkup(state) {
    // Only these static, source-controlled paths ever reach innerHTML.
    const geometry = SYMBOLS[state]
    return `<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g stroke="#fffdf8" stroke-width="4.2">${geometry}</g><g stroke="#231f1a" stroke-width="1.55">${geometry}</g></svg>`
}

export function installCameraCursor() {
    const finePointer = window.matchMedia('(any-pointer: fine)')
    const forcedColors = window.matchMedia('(forced-colors: active)')
    const root = document.documentElement
    const cursor = document.createElement('div')
    cursor.className = 'camera-cursor'
    cursor.setAttribute('aria-hidden', 'true')
    const shape = document.createElement('div')
    shape.className = 'camera-cursor-shape'
    cursor.append(shape)
    document.body.append(cursor)

    let frame = null
    let pressTimer = null
    let inside = false
    let pointerType = 'mouse'
    let x = 0
    let y = 0
    let pressed = false
    let lastTarget = null
    let dragTarget = null
    let photoTarget = null
    let state = null
    const removers = []
    const listen = (target, name, callback, options) => {
        target.addEventListener(name, callback, options)
        removers.push(() => target.removeEventListener(name, callback, options))
    }
    const hide = () => {
        photoTarget = null
        root.removeAttribute('data-camera-cursor-active')
        cursor.classList.remove('is-visible')
    }
    const suspend = () => {
        inside = false
        pressed = false
        dragTarget = null
        cursor.classList.remove('is-pressed')
        hide()
    }

    function update() {
        frame = null
        if (!inside || pointerType !== 'mouse' || !finePointer.matches || forcedColors.matches
            || document.hidden || document.fullscreenElement || document.pointerLockElement) {
            hide()
            return
        }
        const pointed = dragTarget?.isConnected ? dragTarget : document.elementFromPoint?.(x, y) || lastTarget
        if (!(pointed instanceof Element) || !pointed.isConnected || pointed.closest(NATIVE_SELECTOR)) {
            hide()
            return
        }
        const annotated = pointed.closest('[data-camera-cursor]')
        const requested = annotated?.getAttribute('data-camera-cursor')
        let nextState = Object.hasOwn(SYMBOLS, requested) ? requested : null
        if (!nextState && pointed.closest('[aria-busy="true"]')) nextState = 'loading'
        if (!nextState && pointed.closest(ACTION_SELECTOR)) nextState = 'link'
        if (!nextState && pointed.closest(TEXT_SELECTOR)) {
            hide()
            return
        }
        nextState ||= 'camera'
        if (nextState === 'drag-y' && pressed) nextState = 'drag-y-held'
        const nextPhoto = nextState === 'photo' ? annotated : null
        if (state !== nextState || photoTarget !== nextPhoto) {
            state = nextState
            photoTarget = nextPhoto
            cursor.dataset.state = state
            shape.innerHTML = symbolMarkup(state)
        }
        cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`
        cursor.classList.add('is-visible')
        root.setAttribute('data-camera-cursor-active', '')
    }

    const schedule = () => {
        if (inside && frame === null) frame = window.requestAnimationFrame(update)
    }
    const move = (event) => {
        pointerType = event.pointerType
        x = event.clientX
        y = event.clientY
        lastTarget = event.target
        inside = true
        if (pointerType !== 'mouse') suspend()
        else schedule()
    }
    const release = () => {
        pressed = false
        dragTarget = null
        window.clearTimeout(pressTimer)
        pressTimer = window.setTimeout(() => cursor.classList.remove('is-pressed'), 100)
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
        window.clearTimeout(pressTimer)
        cursor.classList.add('is-pressed')
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
    listen(document, 'scroll', schedule, { capture: true, passive: true })
    listen(window, 'resize', schedule, { passive: true })
    listen(finePointer, 'change', suspend)
    listen(forcedColors, 'change', suspend)

    // Refresh a stationary pointer when a route, lazy image, or portal changes.
    // Ignore our own SVG writes so the observer cannot become an animation loop.
    const observer = new MutationObserver((records) => {
        if (records.some(record => !cursor.contains(record.target))) schedule()
    })
    observer.observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-camera-cursor', 'disabled', 'aria-disabled', 'aria-busy', 'inert'],
    })

    return () => {
        removers.forEach(remove => remove())
        observer.disconnect()
        if (frame !== null) window.cancelAnimationFrame(frame)
        window.clearTimeout(pressTimer)
        hide()
        cursor.remove()
    }
}
