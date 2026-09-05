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

export function registerLightboxLayer(dialog, useViewportScrollLock) {
    const restoreFocus = document.activeElement
    if (!layers.length) {
        const bodyKeys = ['overflow', 'overscrollBehavior', 'position', 'top', 'left', 'right', 'width']
        const rootKeys = ['overflow', 'overscrollBehavior']
        pageState = {
            body: Object.fromEntries(bodyKeys.map(key => [key, document.body.style[key]])),
            root: Object.fromEntries(rootKeys.map(key => [key, document.documentElement.style[key]])),
            scroll: [window.scrollX, window.scrollY],
            hadLock: document.documentElement.hasAttribute('data-lightbox-scroll-lock'),
            useViewportScrollLock,
            restoreFocus,
        }
        document.documentElement.setAttribute('data-lightbox-scroll-lock', '')
        if (useViewportScrollLock) {
            Object.assign(document.documentElement.style, { overflow: 'hidden', overscrollBehavior: 'none' })
            Object.assign(document.body.style, { overflow: 'hidden', overscrollBehavior: 'none' })
        } else {
            Object.assign(document.body.style, {
                overflow: 'hidden', position: 'fixed', top: `-${pageState.scroll[1]}px`,
                left: `-${pageState.scroll[0]}px`, right: '0', width: '100%',
            })
        }
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
        if (!pageState.useViewportScrollLock) window.scrollTo(...pageState.scroll)
        pageState = null
    }
}
