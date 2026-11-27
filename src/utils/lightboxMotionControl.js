export const lightboxMotionControllers = new WeakMap()

let installer
let pending

export function usesTouchMediaFade(kind) {
    return (kind === 'photo' || kind === 'video' || kind === 'button')
        && window.matchMedia('(pointer: coarse)').matches
}

export function preloadLightboxMotion() {
    pending ||= import('./lightboxMotion').then(module => {
        installer = module.installLightboxMotion
        return installer
    }).catch(() => {
        pending = undefined
        return undefined
    })
    return pending
}

// Touch viewers fade the actual dialog at its final size. No image copy needs
// to be decoded, measured or resized in the first frames of a tap.
function mountMediaFade(dialog, { kind, onOpened }) {
    const content = kind === 'video' ? dialog.querySelector('.linen-lightbox-content') : null
    const rest = 'translateY(0px) scale(1)'
    const offset = 'translateY(12px) scale(.985)'
    const enter = { duration: 310, easing: 'cubic-bezier(.25,.55,.35,1)', fill: 'both' }
    const exit = { duration: 260, easing: 'ease-in-out', fill: 'both' }
    let animation = dialog.animate([{ opacity: 0 }, { opacity: 1 }], enter)
    let movement = content?.animate([{ transform: offset }, { transform: rest }], enter)
    let closing = false
    const cancel = () => {
        animation?.cancel()
        movement?.cancel()
        animation = movement = null
    }
    const settle = () => {
        if (!animation || closing) return
        cancel()
        onOpened?.()
    }
    animation.finished.then(settle, () => {})
    lightboxMotionControllers.set(dialog, {
        settle,
        requestClose(close) {
            if (closing) return
            closing = true
            dialog.querySelector('video')?.pause()
            const opacity = Number(getComputedStyle(dialog).opacity)
            const pose = movement && content.isConnected ? getComputedStyle(content).transform : rest
            cancel()
            animation = dialog.animate([{ opacity }, { opacity: 0 }], exit)
            if (content?.isConnected) movement = content.animate([{ transform: pose }, { transform: offset }], exit)
            animation.finished.then(close, () => {})
        },
    })
    return () => {
        cancel()
        lightboxMotionControllers.delete(dialog)
    }
}

export function mountLightboxMotion(dialog, config, trigger) {
    const motion = config()
    if (!motion) return undefined
    if (!dialog?.animate) {
        motion.onOpened?.()
        return undefined
    }
    if (usesTouchMediaFade(motion.kind) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return mountMediaFade(dialog, motion)
    }
    if (installer) return installer(dialog, config, trigger)
    const photoCard = motion.kind === 'photo' && motion.origin?.kind === 'photo' && motion.origin.rect
    const waitingAttribute = photoCard ? 'data-lightbox-awaiting' : 'data-lightbox-booting'
    let release
    let waiting = true
    dialog.setAttribute(waitingAttribute, '')
    const show = () => {
        if (!waiting) return false
        waiting = false
        dialog.removeAttribute(waitingAttribute)
        if (photoCard) lightboxMotionControllers.delete(dialog)
        return true
    }
    const finish = () => { if (show()) motion.onOpened?.() }
    // Keep a cold photo card's origin while the chunk loads. Close and
    // keyboard navigation can still bypass the pending entrance.
    const timer = photoCard ? undefined : window.setTimeout(finish, 120)
    if (photoCard) lightboxMotionControllers.set(dialog, {
        settle: finish,
        requestClose(close) { if (show()) close() },
    })
    void preloadLightboxMotion().then(install => {
        clearTimeout(timer)
        if (!show()) return
        if (install) release = install(dialog, config, trigger)
        else motion.onOpened?.()
    })
    return () => {
        clearTimeout(timer)
        show()
        release?.()
    }
}

export function requestLightboxClose(element, close) {
    const dialog = element?.closest('.linen-lightbox')
    const controller = lightboxMotionControllers.get(dialog)
    if (!controller) return close()
    dialog.dispatchEvent(new Event('lightboxclosing'))
    controller.requestClose(close)
}

export function settleLightboxEntrance(element) {
    lightboxMotionControllers.get(element)?.settle()
}
