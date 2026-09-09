import { useEffect, useRef, useState } from 'react'
import { Blurhash } from 'react-blurhash'

const lazyCallbacks = new Map()
let sharedLazyObserver = null
let sharedObserverConstructor = null

function getLazyObserver() {
    if (typeof IntersectionObserver === 'undefined') return null
    if (!sharedLazyObserver || sharedObserverConstructor !== IntersectionObserver) {
        sharedLazyObserver?.disconnect()
        sharedObserverConstructor = IntersectionObserver
        sharedLazyObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.target) {
                    lazyCallbacks.get(entry.target)?.(entry.isIntersecting)
                    return
                }
                lazyCallbacks.forEach((load) => load(entry.isIntersecting))
            })
        // Retain a generous buffer in both directions, but release distant
        // decoded images as well as their DOM nodes on long gallery visits.
        }, { rootMargin: '800px', threshold: 0 })
    }
    return sharedLazyObserver
}

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
    style,
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
        if (!src || eager) return undefined
        const element = containerRef.current
        const observer = getLazyObserver()
        if (!element || !observer) {
            setVisibleSrc(src)
            return undefined
        }

        lazyCallbacks.set(element, (visible) => {
            setVisibleSrc(visible ? src : null)
            if (!visible) setLoadedIdentity(null)
        })
        observer.observe(element)
        return () => {
            lazyCallbacks.delete(element)
            if (observer.unobserve) observer.unobserve(element)
            else observer.disconnect?.()
        }
    }, [eager, src])

    return (
        <div ref={containerRef} className={`relative overflow-hidden ${className}`} style={style}>
            {shouldLoad && blurhash && !isLoaded && (
                <div className="absolute inset-0 z-0 pointer-events-none" aria-hidden="true">
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
                    className={`absolute inset-0 z-0 h-full w-full object-cover transition-opacity duration-300 ease-out ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
                />
            )}
        </div>
    )
}
