import { REDUCED_MOTION_QUERY } from './albumPreviewPolicy'

// A preview is valid only while the visitor is dwelling on its card.
// Capture also covers horizontal rows, whose scroll events do not bubble.
export function stopPreviewOnLeave(stop) {
    const hide = () => { if (document.hidden) stop() }
    const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY)
    const preferenceChanged = () => { if (reducedMotion.matches || navigator.connection?.saveData) stop() }
    document.addEventListener('scroll', stop, { capture: true, passive: true })
    document.addEventListener('pointerdown', stop, { passive: true })
    document.addEventListener('visibilitychange', hide)
    reducedMotion.addEventListener?.('change', preferenceChanged)
    navigator.connection?.addEventListener?.('change', preferenceChanged)
    return () => {
        document.removeEventListener('scroll', stop, true)
        document.removeEventListener('pointerdown', stop)
        document.removeEventListener('visibilitychange', hide)
        reducedMotion.removeEventListener?.('change', preferenceChanged)
        navigator.connection?.removeEventListener?.('change', preferenceChanged)
    }
}
