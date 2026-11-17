import { preloadLightboxMotion } from './lightboxMotionControl'

const triggers = new WeakMap()
const mediaSelector = '[data-lightbox-item]'
const reduceMotion = '(prefers-reduced-motion: reduce)'

export function prefersReducedLightboxMotion() {
    return window.matchMedia?.(reduceMotion).matches === true
}

export function lightboxRect(element) {
    if (!element?.isConnected) return null
    const rect = element.getBoundingClientRect()
    return fitsViewport(rect) ? rect : null
}

export function fitsViewport(rect) {
    return rect?.width > 0 && rect.height > 0 && rect.left >= -1 && rect.top >= -1
        && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1
}

export function rememberLightboxTrigger(element, kind, key, visual = element) {
    if (!element) return null
    element.focus({ preventScroll: true })
    if (prefersReducedLightboxMotion()) return null
    const rect = lightboxRect(visual)
    if (!rect) return null
    if (element.animate) void preloadLightboxMotion()
    const image = visual.querySelector('img')
    const style = getComputedStyle(visual)
    const origin = {
        element, visual, kind, key, rect,
        image: image?.complete && image.naturalWidth ? image.currentSrc || image.src : '',
        radius: style.borderRadius,
        background: style.backgroundColor,
        border: style.borderTopColor,
    }
    triggers.set(element, origin)
    return origin
}

export function takeLightboxTrigger(kind, key, explicitOrigin, element) {
    const origin = explicitOrigin || triggers.get(element)
    if (!origin) return null
    if (origin.element) triggers.delete(origin.element)
    return origin.kind === kind && (origin.key == null || origin.key === key) ? origin : null
}

export function findLightboxReturn(origin, key) {
    if (!origin) return null
    if (origin.kind === 'museum' && !origin.element) return fitsViewport(origin.rect) ? origin : null
    const scope = origin.element?.closest('[data-lightbox-grid]')
    const element = origin.key == null || origin.key === key ? origin.element
        : [...(scope?.querySelectorAll(mediaSelector) || [])].find(tile => tile.getAttribute('data-lightbox-item') === key)
    const visual = element === origin.element ? origin.visual : element
    const rect = lightboxRect(visual)
    if (!rect) return null
    const scroller = element.closest('.museum-album-scroll')
    if (scroller) {
        const bounds = scroller.getBoundingClientRect()
        if (rect.top < bounds.top || rect.bottom > bounds.bottom) return null
    }
    return { ...origin, element, visual, rect }
}
