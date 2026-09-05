import { useCallback, useLayoutEffect, useState } from 'react'

// A portrait can occupy far less than the viewport width in a contain-fit
// viewer. Give srcset that actual CSS width; the browser still applies DPR.
export default function useContainedImageSizes() {
    const [container, containerRef] = useState(null)
    const [bounds, setBounds] = useState({ width: 0, height: 0 })

    useLayoutEffect(() => {
        if (!container) return undefined
        let active = true
        const measure = () => {
            if (!active) return
            const rect = container.getBoundingClientRect()
            const width = Math.max(0, Math.ceil(rect.width))
            const height = Math.max(0, Math.ceil(rect.height))
            setBounds(previous => previous.width === width && previous.height === height
                ? previous : { width, height })
        }
        measure()
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
        observer?.observe(container)
        window.addEventListener('resize', measure, { passive: true })
        return () => {
            active = false
            observer?.disconnect()
            window.removeEventListener('resize', measure)
        }
    }, [container])

    const sizesFor = useCallback((image) => {
        if (!bounds.width || !bounds.height) return '100vw'
        const width = Number(image?.width)
        const height = Number(image?.height)
        const hasDimensions = Number.isFinite(width) && width > 0
            && Number.isFinite(height) && height > 0
            && typeof image?.width !== 'boolean' && typeof image?.height !== 'boolean'
        const fittedWidth = hasDimensions
            ? Math.min(bounds.width, bounds.height * width / height)
            : bounds.width
        return `${Math.max(1, Math.ceil(fittedWidth))}px`
    }, [bounds])

    return { containerRef, sizesFor }
}
