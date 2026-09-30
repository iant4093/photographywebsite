import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observeRetainedImage } from '../utils/imageRetention'
import { imagePlaceholder } from '../utils/imagePlaceholder'
import { captureImageSnapshot, releaseImageSnapshot, touchImageSnapshot } from '../utils/imageSnapshot'
import { isImageReady, markImageReady } from '../utils/imageReadiness'

// Signed-cookie media keeps the same URL when the API reissues its cookies, so
// an image that failed while a cookie was expired would never reload. Retry a
// bounded number of times with a query the edge cache policy ignores.
const PRIVATE_MEDIA_RETRY_DELAYS_MS = [1500, 4000, 8000]

function isPrivateMediaSource(value) {
    try {
        const url = new URL(value, window.location.href)
        return url.origin === window.location.origin && url.pathname.startsWith('/private-media/')
    } catch {
        return false
    }
}

function cacheBustedSource(src, attempt) {
    return attempt > 0 ? `${src}${src.includes('?') ? '&' : '?'}r=${attempt}` : src
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
    near = false,
    viewportFirst = false,
    className = '',
    style,
    onError,
}) {
    const [visibleSrc, setVisibleSrc] = useState(eager ? src : null)
    const [loadedIdentity, setLoadedIdentity] = useState(null)
    const [fastReveal, setFastReveal] = useState(false)
    const loadStarted = useRef(0)
    const imageNode = useRef(null)
    const imageSettled = useRef(false)
    const imageRef = useCallback(image => {
        imageNode.current = image
        imageSettled.current = false
        if (image) loadStarted.current = performance.now()
    }, [])
    const [failedResponsiveIdentity, setFailedResponsiveIdentity] = useState(null)
    const containerRef = useRef(null)
    const retentionRef = useRef(null)
    const snapshotRef = useRef(null)
    const [placeholder, setPlaceholder] = useState({ hash: '', url: '' })
    // Keyed by the source pair so a changed src/srcSet starts from attempt 0.
    const [privateRetry, setPrivateRetry] = useState({ source: '', attempt: 0 })
    const retryTimer = useRef(0)
    const eagerPlaceholder = useMemo(() => eager ? imagePlaceholder(blurhash) : '', [blurhash, eager])
    const shouldLoad = eager || visibleSrc === src
    const responsiveIdentity = srcSet ? `${src}\n${srcSet}` : ''
    const effectiveSrcSet = responsiveIdentity && failedResponsiveIdentity !== responsiveIdentity
        ? srcSet
        : undefined
    const imageIdentity = effectiveSrcSet ? `responsive:${responsiveIdentity}` : `fallback:${src}`
    const isLoaded = loadedIdentity === imageIdentity
    const sourceIdentity = `${src}\n${srcSet || ''}`
    const retryAttempt = privateRetry.source === sourceIdentity ? privateRetry.attempt : 0

    useEffect(() => () => window.clearTimeout(retryTimer.current), [src, srcSet])

    useEffect(() => {
        const container = snapshotRef.current
        return () => releaseImageSnapshot(container)
    }, [src, srcSet])

    useEffect(() => {
        if (!src || (eager && !viewportFirst)) return undefined
        const element = containerRef.current
        if (!element) return undefined
        const retained = observeRetainedImage(element, (visible) => {
            setVisibleSrc(visible ? src : null)
            if (!visible) setLoadedIdentity(null)
            else touchImageSnapshot(snapshotRef.current)
            if (visible && blurhash) {
                setPlaceholder(previous => previous.hash === blurhash ? previous
                    : { hash: blurhash, url: imagePlaceholder(blurhash) })
            }
        }, near, { viewportFirst, eager })
        retentionRef.current = retained
        // Cached images and final errors may settle before a subscription.
        const image = imageNode.current
        if (image && (imageSettled.current || (image.complete && image.naturalWidth))) retained.loaded(image)
        return () => {
            retained.dispose()
            if (retentionRef.current === retained) retentionRef.current = null
        }
    }, [blurhash, eager, near, src, viewportFirst])

    const placeholderUrl = eager ? eagerPlaceholder : placeholder.hash === blurhash ? placeholder.url : ''

    return (
        <div ref={containerRef} className={`relative overflow-hidden ${className}`} style={style}>
            {placeholderUrl && (
                <div className="progressive-image-placeholder absolute inset-0 z-0 pointer-events-none"
                    aria-hidden="true" style={{ backgroundImage: `url("${placeholderUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
            )}
            <div ref={snapshotRef} className="absolute inset-0 z-0 pointer-events-none" aria-hidden="true" />
            {shouldLoad && (
                <img
                    ref={imageRef}
                    key={`${imageIdentity}#${retryAttempt}`}
                    src={cacheBustedSource(src, retryAttempt)}
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
                        imageSettled.current = true
                        const url = event.currentTarget.currentSrc || event.currentTarget.src
                        setFastReveal(isImageReady(url) || performance.now() - loadStarted.current < 80)
                        markImageReady(url)
                        retentionRef.current?.loaded(event.currentTarget)
                        setLoadedIdentity(imageIdentity)
                    }}
                    // Copy only once the first reveal finishes: this keeps the
                    // initial fade intact and avoids extra work on the load frame.
                    onAnimationEnd={(event) => captureImageSnapshot(snapshotRef.current, event.currentTarget)}
                    onError={(event) => {
                        if (effectiveSrcSet) {
                            setFailedResponsiveIdentity(responsiveIdentity)
                            return
                        }
                        imageSettled.current = true
                        retentionRef.current?.loaded(event.currentTarget)
                        const resolved = event.currentTarget.currentSrc || event.currentTarget.src || src
                        if (!isPrivateMediaSource(resolved)) {
                            setLoadedIdentity(imageIdentity)
                            onError?.(event)
                            return
                        }
                        // Report only the first failure: it asks the page to
                        // refresh metadata, which reissues the cookies the
                        // retries depend on. Keep the placeholder meanwhile.
                        if (retryAttempt === 0) onError?.(event)
                        if (retryAttempt >= PRIVATE_MEDIA_RETRY_DELAYS_MS.length) {
                            setLoadedIdentity(imageIdentity)
                            return
                        }
                        window.clearTimeout(retryTimer.current)
                        retryTimer.current = window.setTimeout(() => {
                            setPrivateRetry({ source: sourceIdentity, attempt: retryAttempt + 1 })
                        }, PRIVATE_MEDIA_RETRY_DELAYS_MS[retryAttempt])
                    }}
                    className={`absolute inset-0 z-0 h-full w-full object-cover ${isLoaded ? `opacity-100 progressive-image-ready ${fastReveal ? 'progressive-image-returned' : ''}` : 'opacity-0'}`}
                />
            )}
        </div>
    )
}
