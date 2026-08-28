export function supportsImmersiveGallery() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false
    try {
        const canvas = document.createElement('canvas')
        return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
    } catch {
        return false
    }
}
