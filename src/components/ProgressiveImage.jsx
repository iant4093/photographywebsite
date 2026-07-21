import { useEffect, useRef, useState } from 'react'
import { Blurhash } from 'react-blurhash'

export default function ProgressiveImage({
    src,
    srcSet,
    sizes,
    blurhash,
    alt,
    width,
    height,
    eager = false,
    className = '',
    onError,
}) {
    const [visibleSrc, setVisibleSrc] = useState(eager ? src : null)
    const [loadedIdentity, setLoadedIdentity] = useState(null)
    const [failedResponsiveIdentity, setFailedResponsiveIdentity] = useState(null)
    const containerRef = useRef(null)
    const shouldLoad = eager || visibleSrc === src
    const responsiveIdentity = srcSet ? `${src}\n${srcSet}` : ''
    const effectiveSrcSet = responsiveIdentity && failedResponsiveIdentity !== responsiveIdentity
        ? srcSet
        : undefined
    const imageIdentity = effectiveSrcSet ? `responsive:${responsiveIdentity}` : `fallback:${src}`
    const isLoaded = loadedIdentity === imageIdentity

    useEffect(() => {
        if (!src || eager || visibleSrc === src) return undefined
        const element = containerRef.current
        if (!element || typeof IntersectionObserver === 'undefined') {
            setVisibleSrc(src)
            return undefined
        }

        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                setVisibleSrc(src)
                observer.disconnect()
            }
        }, { rootMargin: '240px', threshold: 0.01 })
        observer.observe(element)
        return () => observer.disconnect()
    }, [eager, src, visibleSrc])

    return (
        <div ref={containerRef} className={`relative overflow-hidden ${className}`}>
            {shouldLoad && blurhash && (
                <div className={`absolute inset-0 z-10 transition-opacity duration-500 ${isLoaded ? 'opacity-0' : 'opacity-100'}`} aria-hidden="true">
                    <Blurhash hash={blurhash} width="100%" height="100%" resolutionX={24} resolutionY={24} punch={1} />
                </div>
            )}
            {shouldLoad && (
                <img
                    key={imageIdentity}
                    src={src}
                    srcSet={effectiveSrcSet}
                    sizes={sizes}
                    alt={alt}
                    width={width}
                    height={height}
                    loading={eager ? 'eager' : 'lazy'}
                    fetchPriority={eager ? 'high' : 'low'}
                    decoding="async"
                    onLoad={() => setLoadedIdentity(imageIdentity)}
                    onError={(event) => {
                        if (effectiveSrcSet) {
                            setFailedResponsiveIdentity(responsiveIdentity)
                            return
                        }
                        setLoadedIdentity(imageIdentity)
                        onError?.(event)
                    }}
                    className={`absolute inset-0 z-0 h-full w-full object-cover transition-all duration-500 ease-out ${isLoaded ? 'scale-100 opacity-100' : 'scale-[1.02] opacity-0'}`}
                />
            )}
        </div>
    )
}
