export function navigateBackOr(navigate, fallback) {
    const historyIndex = Number(globalThis.window?.history?.state?.idx)
    if (Number.isInteger(historyIndex) && historyIndex > 0) {
        navigate(-1)
        return
    }
    navigate(fallback)
}

export function scrollToTop() {
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    window.dispatchEvent(new Event('route-scroll-intent'))
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'instant' : 'smooth' })
}
