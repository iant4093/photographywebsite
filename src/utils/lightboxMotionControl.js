export const lightboxMotionControllers = new WeakMap()

let installer
let pending

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

export function mountLightboxMotion(dialog, config, trigger) {
    const motion = config()
    if (!motion) return undefined
    if (!dialog?.animate) {
        motion.onOpened?.()
        return undefined
    }
    if (installer) return installer(dialog, config, trigger)
    let release
    let waiting = true
    dialog.dataset.lightboxBooting = ''
    const show = () => {
        waiting = false
        delete dialog.dataset.lightboxBooting
    }
    // A slow or failed animation chunk should leave the ordinary viewer usable.
    const timer = window.setTimeout(() => {
        show()
        motion.onOpened?.()
    }, 120)
    void preloadLightboxMotion().then(install => {
        if (!waiting) return
        clearTimeout(timer)
        show()
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
    const controller = lightboxMotionControllers.get(element?.closest('.linen-lightbox'))
    if (controller) controller.requestClose(close)
    else close()
}

export function settleLightboxEntrance(element) {
    lightboxMotionControllers.get(element)?.settle()
}
