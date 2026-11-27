import { useLayoutEffect } from 'react'
import useMediaQuery from './useMediaQuery'

export default function useStableMobileViewport() {
    const touchViewport = useMediaQuery('(pointer: coarse)')

    useLayoutEffect(() => {
        if (!touchViewport || !window.CSS?.supports?.('height', '100svh')) return undefined

        const root = document.documentElement
        const orientation = window.screen.orientation
        const probe = document.createElement('div')
        probe.setAttribute('aria-hidden', 'true')
        probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100svh;box-sizing:content-box;'
            + 'padding-bottom:calc(100lvh - 100svh);visibility:hidden;pointer-events:none'
        document.body.append(probe)

        let width
        let angle
        const measure = () => {
            if (width === root.clientWidth && angle === orientation?.angle) return
            const large = probe.getBoundingClientRect().height
            if (!large) return
            const small = parseFloat(getComputedStyle(probe).height)
            // Toolbar and keyboard changes can report a new height during a
            // scroll. Keep the document geometry until the screen changes.
            width = root.clientWidth
            angle = orientation?.angle
            root.style.setProperty('--linen-viewport-small-height', `${small}px`)
            root.style.setProperty('--linen-viewport-large-height', `${large}px`)
        }

        measure()
        window.addEventListener('resize', measure)
        orientation?.addEventListener('change', measure)
        return () => {
            window.removeEventListener('resize', measure)
            orientation?.removeEventListener('change', measure)
            probe.remove()
            root.style.removeProperty('--linen-viewport-small-height')
            root.style.removeProperty('--linen-viewport-large-height')
        }
    }, [touchViewport])
}
