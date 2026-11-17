// The source tile is gone by the time a single-video album finishes loading.
let opening

export function rememberVideoNavigation(path, event, visual) {
    if (!path.endsWith('?play=1') || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const rect = visual?.getBoundingClientRect()
    const img = visual?.querySelector('img')
    if (!rect?.width || !rect.height || rect.top < 0 || rect.left < 0
        || rect.right > innerWidth || rect.bottom > innerHeight || !img?.complete || !img.naturalWidth) return
    opening = { path, time: performance.now(), rect, image: img.currentSrc || img.src }
}

export function rememberVideoLink(event) {
    const link = event.currentTarget
    rememberVideoNavigation(link.pathname + link.search, event, link.querySelector('.album-card-image'))
}

export function takeVideoNavigation(path) {
    const origin = opening
    opening = undefined
    return origin?.path === path && performance.now() - origin.time < 5000 ? { ...origin, kind: 'video' } : null
}
