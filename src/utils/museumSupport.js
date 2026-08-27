export function supportsImmersiveGallery() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false
    const wideEnough = window.innerWidth >= 900
    const hasFinePointer = window.matchMedia?.('(any-pointer: fine)').matches ?? wideEnough
    try {
        const canvas = document.createElement('canvas')
        return wideEnough
            && hasFinePointer
            && Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
    } catch {
        return false
    }
}

