export function afterImageDecode(image, onReady, onError) {
    if (!image?.isConnected) return
    const src = image.getAttribute('src')
    const srcSet = image.getAttribute('srcset')
    const candidate = image.currentSrc
    const isCurrent = () => image.isConnected && image.getAttribute('src') === src
        && image.getAttribute('srcset') === srcSet && image.currentSrc === candidate
    const ready = () => {
        if (!isCurrent()) return
        image.getBoundingClientRect()
        onReady()
    }
    const failed = () => {
        if (isCurrent()) onError?.({ type: 'error', currentTarget: image })
    }
    if (typeof image.decode !== 'function') { ready(); return }
    try { image.decode().then(ready, failed) } catch { failed() }
}
