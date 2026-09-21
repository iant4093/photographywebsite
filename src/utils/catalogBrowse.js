// The first page is always fetched immediately. Defer the remaining catalog
// until browsing is imminent, then allow it to finish so all section ordering
// and year filters remain complete. Search intentionally does not use this gate.
export function waitForCatalogBrowse(target, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'))
    if (!target || typeof IntersectionObserver === 'undefined') return Promise.resolve()
    const near = () => target.getBoundingClientRect().top <= window.innerHeight + 600
    if (document.visibilityState !== 'hidden' && near()) return Promise.resolve()

    return new Promise((resolve, reject) => {
        const region = target.closest('section') || target
        let interested = false
        const cleanup = () => {
            observer.disconnect()
            region.removeEventListener('focusin', interest)
            region.removeEventListener('pointerdown', interest)
            document.removeEventListener('visibilitychange', check)
            window.removeEventListener('scroll', check)
            signal?.removeEventListener('abort', abort)
        }
        const check = () => {
            if (document.visibilityState === 'hidden' || (!interested && !near())) return
            cleanup()
            resolve()
        }
        const interest = () => { interested = true; check() }
        const abort = () => {
            cleanup()
            reject(new DOMException('Request aborted', 'AbortError'))
        }
        const observer = new IntersectionObserver(check, { rootMargin: '600px 0px' })
        observer.observe(target)
        region.addEventListener('focusin', interest)
        region.addEventListener('pointerdown', interest)
        document.addEventListener('visibilitychange', check)
        window.addEventListener('scroll', check, { passive: true })
        signal?.addEventListener('abort', abort, { once: true })
        check()
    })
}
