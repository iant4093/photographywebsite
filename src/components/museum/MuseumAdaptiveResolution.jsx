import { useEffect, useLayoutEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { createMuseumResolutionController, museumResolutionProfile } from '../../utils/museumResolution'

export default function MuseumAdaptiveResolution({ enabled, firefox, requestFrames, onDprChange }) {
    const { gl, size, setDpr } = useThree()
    const profile = useMemo(() => museumResolutionProfile({
        touchMode: true,
        width: size.width,
        height: size.height,
        devicePixelRatio: window.devicePixelRatio,
        deviceMemory: navigator.deviceMemory,
        firefox,
    }), [size.width, size.height, firefox])
    const controller = useMemo(() => createMuseumResolutionController({
        ...profile,
        // Safari's address bar can resize the viewport while walking. Preserve
        // a learned resolution rather than raising GPU load on every resize.
        initialDpr: gl.getPixelRatio(),
    }), [gl, profile])

    // Resize the existing drawing buffer; the world, textures and player stay
    // mounted. The pixel budget also applies after a tablet rotates.
    useLayoutEffect(() => {
        const dpr = controller.snapshot().dpr
        setDpr(dpr)
        onDprChange(dpr)
        requestFrames(2)
    }, [controller, onDprChange, requestFrames, setDpr])

    useEffect(() => {
        controller.reset()
        const reset = () => controller.reset()
        document.addEventListener('visibilitychange', reset)
        document.addEventListener('freeze', reset)
        window.addEventListener('blur', reset)
        window.addEventListener('focus', reset)
        window.addEventListener('pagehide', reset)
        window.addEventListener('pageshow', reset)
        return () => {
            document.removeEventListener('visibilitychange', reset)
            document.removeEventListener('freeze', reset)
            window.removeEventListener('blur', reset)
            window.removeEventListener('focus', reset)
            window.removeEventListener('pagehide', reset)
            window.removeEventListener('pageshow', reset)
        }
    }, [controller, enabled])

    useFrame(() => {
        // Simulation delta is deliberately clamped by MuseumFrameDriver. Real
        // wall time is needed to notice sustained slow rendering on a phone.
        const nextDpr = controller.sample(performance.now(), enabled
            && document.visibilityState !== 'hidden' && document.hasFocus())
        if (nextDpr !== null) {
            setDpr(nextDpr)
            onDprChange(nextDpr)
            requestFrames(2)
        }
    })
    return null
}
