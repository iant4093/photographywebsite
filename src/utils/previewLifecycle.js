// A hover preview is valid only while the visitor is dwelling on its card.
// Capture also covers horizontal rows, whose scroll events do not bubble.
export function stopPreviewOnLeave(stop) {
    const hide = () => { if (document.hidden) stop() }
    document.addEventListener('scroll', stop, { capture: true, passive: true })
    document.addEventListener('visibilitychange', hide)
    return () => {
        document.removeEventListener('scroll', stop, true)
        document.removeEventListener('visibilitychange', hide)
    }
}
