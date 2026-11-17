// Dialogs can contain other portal dialogs. Share one page lock so closing a
// photo, or unmounting the entire route, restores the page exactly once.
const layers = []
const backgrounds = new Map()
let pageState = null

function restoreBackgrounds() {
    backgrounds.forEach(({ hidden, inert }, element) => {
        if (hidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', hidden)
        element.toggleAttribute('inert', inert)
    })
}

function isolateTopLayer() {
    restoreBackgrounds()
    const top = layers.at(-1)?.dialog
    if (!top) return
    for (const element of document.body.children) {
        if (!backgrounds.has(element)) backgrounds.set(element, {
            hidden: element.getAttribute('aria-hidden'), inert: element.hasAttribute('inert'),
        })
        if (element === top) {
            element.removeAttribute('inert')
            element.removeAttribute('aria-hidden')
        } else {
            element.setAttribute('inert', '')
            element.setAttribute('aria-hidden', 'true')
        }
    }
}

export function registerLightboxLayer(dialog) {
    const restoreFocus = document.activeElement
    if (!layers.length) {
        const root = document.documentElement
        const keys = ['overflow', 'overscrollBehavior']
        pageState = {
            body: Object.fromEntries(keys.map(key => [key, document.body.style[key]])),
            root: Object.fromEntries(keys.map(key => [key, root.style[key]])),
            scroll: { left: window.scrollX, top: window.scrollY },
            hadLock: root.hasAttribute('data-lightbox-scroll-lock'),
            restoreFocus,
        }
        // Keep the root's scroll position and scroll-linked card poses intact.
        const lock = { overflow: 'hidden', overscrollBehavior: 'none' }
        root.setAttribute('data-lightbox-scroll-lock', '')
        Object.assign(root.style, lock)
        Object.assign(document.body.style, lock)
    }
    const layer = { dialog, restoreFocus }
    layers.push(layer)
    isolateTopLayer()
    return () => {
        const wasTop = layers.at(-1) === layer
        layers.splice(layers.indexOf(layer), 1)
        if (layers.length) {
            isolateTopLayer()
            // React removes the portal after effect cleanup. Do not retain
            // closed photo DOM (and decoded images) until the album closes.
            backgrounds.delete(dialog)
            if (wasTop) {
                const top = layers.at(-1).dialog
                const target = top.contains(restoreFocus) ? restoreFocus : top
                target?.focus({ preventScroll: true })
            }
            return
        }
        restoreBackgrounds()
        backgrounds.clear()
        Object.assign(document.body.style, pageState.body)
        Object.assign(document.documentElement.style, pageState.root)
        if (!pageState.hadLock) document.documentElement.removeAttribute('data-lightbox-scroll-lock')
        pageState.restoreFocus?.focus?.({ preventScroll: true })
        const { left, top } = pageState.scroll
        if (window.scrollX !== left || window.scrollY !== top) window.scrollTo({ left, top, behavior: 'instant' })
        pageState = null
    }
}
