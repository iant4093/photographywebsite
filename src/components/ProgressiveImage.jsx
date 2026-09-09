import { useEffect, useMemo, useRef, useState } from 'react'
import { observeRetainedImage } from '../utils/imageRetention'
import { imagePlaceholder } from '../utils/imagePlaceholder'

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
    const retentionRef = useRef(null)
    const [placeholder, setPlaceholder] = useState({ hash: '', url: '' })
    const eagerPlaceholder = useMemo(() => eager ? imagePlaceholder(blurhash) : '', [blurhash, eager])
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
        if (!element) return undefined
        const retained = observeRetainedImage(element, (visible) => {
            setVisibleSrc(visible ? src : null)
            if (!visible) setLoadedIdentity(null)
            if (visible && blurhash) {
                setPlaceholder(previous => previous.hash === blurhash ? previous
                    : { hash: blurhash, url: imagePlaceholder(blurhash) })
            }
        })
        retentionRef.current = retained
        return () => {
            retained.dispose()
            if (retentionRef.current === retained) retentionRef.current = null
        }
    }, [blurhash, eager, src])

    const placeholderUrl = eager ? eagerPlaceholder : placeholder.hash === blurhash ? placeholder.url : ''

    return (
        <div ref={containerRef} className={`relative overflow-hidden ${className}`} style={style}>
            {placeholderUrl && (
                <div className="progressive-image-placeholder absolute inset-0 z-0 pointer-events-none"
                    aria-hidden="true" style={{ backgroundImage: `url("${placeholderUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
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
                    // The observer already controls loading distance, including
                    // nested rows. A second native lazy gate can delay swipes.
                    loading="eager"
                    fetchPriority={eager ? 'high' : 'auto'}
                    decoding="async"
                    onLoad={(event) => {
                        retentionRef.current?.loaded(event.currentTarget)
                        setLoadedIdentity(imageIdentity)
                    }}
                    onError={(event) => {
                        if (effectiveSrcSet) {
                            setFailedResponsiveIdentity(responsiveIdentity)
                            return
                        }
                        setLoadedIdentity(imageIdentity)
                        onError?.(event)
                    }}
                    className={`absolute inset-0 z-0 h-full w-full object-cover ${isLoaded ? 'opacity-100 progressive-image-ready' : 'opacity-0'}`}
                />
            )}
        </div>
    )
}
