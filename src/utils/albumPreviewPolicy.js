export const MOBILE_PREVIEW_QUERY = '(hover: none), (pointer: coarse), (max-width: 720px)'
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function canRunAlbumPreview(trigger = 'hover') {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    if (window.matchMedia(REDUCED_MOTION_QUERY).matches || navigator.connection?.saveData) return false
    const mobile = window.matchMedia(MOBILE_PREVIEW_QUERY).matches
    return trigger === 'focus' ? mobile : !mobile && window.matchMedia('(hover: hover) and (pointer: fine)').matches
}
