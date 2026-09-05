import { useEffect, useRef, useState } from 'react'
import AccessibleLightbox from './AccessibleLightbox'
import {
    mediaBeforeDisplayUrl,
    mediaBeforeSrcSet,
    mediaDisplayUrl,
    mediaId,
    mediaPreviewSrcSet,
    mediaThumbnailUrl,
} from '../utils/mediaUrls'
import LightboxShareButton from './LightboxShareButton'
import useContainedImageSizes from '../hooks/useContainedImageSizes'

const PHOTO_CROSSFADE_MS = 360
const ORIGINAL_REFRESH_INTERVAL_MS = 20_000
const ORIGINAL_REFRESH_SLOW_INTERVAL_MS = 60_000

function freshComparison(id) {
    return { id, requested: false, returningToEdit: false, attempt: 0, loadedKey: null, failedKey: null }
}

function afterImageDecode(image, onReady, onError) {
    if (!image?.isConnected) return
    const src = image.getAttribute('src')
    const srcSet = image.getAttribute('srcset')
    const candidate = image.currentSrc
    const isCurrent = () => image.isConnected && image.getAttribute('src') === src
        && image.getAttribute('srcset') === srcSet && image.currentSrc === candidate
    const ready = () => {
        if (!isCurrent()) return
        // Establish the hidden layer's initial style even when a cached image
        // decodes before the browser's first paint, so its fade still runs.
        image.getBoundingClientRect()
        onReady()
    }
    const failed = () => {
        if (isCurrent()) onError?.({ type: 'error', currentTarget: image })
    }
    if (typeof image.decode !== 'function') {
        ready()
        return
    }
    try { image.decode().then(ready, failed) } catch { failed() }
}

function runOriginalRefresh(requestRef, callback, event, image, isCurrent, context = { reason: 'original-status' }) {
    const key = mediaId(image) || image
    const active = requestRef.current
    if (active) {
        if (active.key === key) return active.promise
        if (active.queued?.key === key) {
            if (context.reason === 'media-error') {
                Object.assign(active.queued, { callback, event, image, isCurrent, context })
            }
            return active.queued.promise
        }
        // Keep only the latest waiting selection, so rapid navigation cannot
        // build a queue of obsolete reads behind one slow request.
        active.queued?.resolve()
        let resolve
        const promise = new Promise((complete) => { resolve = complete })
        active.queued = { key, callback, event, image, isCurrent, context, promise, resolve }
        return promise
    }
    let result
    try { result = callback(event, image, context) } catch { /* Keep the edit available. */ }
    const request = { key, promise: null, queued: null }
    request.promise = Promise.resolve(result).catch(() => {}).finally(() => {
        if (requestRef.current !== request) return
        requestRef.current = null
        const queued = request.queued
        if (queued?.isCurrent()) {
            runOriginalRefresh(requestRef, queued.callback, queued.event, queued.image, queued.isCurrent, queued.context).then(queued.resolve)
        } else queued?.resolve()
    })
    requestRef.current = request
    return request.promise
}

function PhotoLightbox({
    images,
    index,
    ariaLabel,
    onClose,
    onNext,
    onPrevious,
    onRetry,
    onDownload,
    onPrint,
    canShare = true,
    shareTitle,
    shareUrl,
    onBeforeRefresh,
    onMediaError,
    loading = false,
    emptyMessage = '',
}) {
    const { containerRef, sizesFor } = useContainedImageSizes()
    const [loadedImageId, setLoadedImageId] = useState(null)
    const [settledImage, setSettledImage] = useState(null)
    const [printing, setPrinting] = useState(false)
    const settledImageRef = useRef(null)
    const transitionTimerRef = useRef(null)
    const activeImage = images[index]
    const activeId = activeImage ? (mediaId(activeImage) || index) : 'pending'
    const thumbUrl = activeImage ? mediaThumbnailUrl(activeImage) : ''
    const activeRawUrl = activeImage ? mediaDisplayUrl(activeImage) : ''
    const previewSrcSet = activeImage ? mediaPreviewSrcSet(activeImage) : ''
    const [comparison, setComparison] = useState(() => freshComparison(activeId))
    const refreshedOriginalsRef = useRef(new Set())
    const originalRequestRef = useRef(null)
    const originalRefreshRef = useRef({ callback: onBeforeRefresh, image: activeImage, id: activeId, requested: false })
    const before = activeImage && typeof activeImage === 'object' ? activeImage.before : null
    const beforeUrl = mediaBeforeDisplayUrl(activeImage)
    const beforeSrcSet = mediaBeforeSrcSet(activeImage)
    const beforeSourceKey = JSON.stringify([activeId, beforeUrl, beforeSrcSet])
    const beforeRequestKey = `${beforeSourceKey}:${comparison.attempt}`
    const beforeIsReady = before?.status === 'ready' && Boolean(beforeUrl)
    const comparisonRequested = comparison.id === activeId && comparison.requested
    const originalLoaded = beforeIsReady && comparison.loadedKey === beforeRequestKey
    const waitingForEdited = originalLoaded && comparison.returningToEdit && loadedImageId !== activeId
    const showingBefore = originalLoaded && (comparisonRequested || waitingForEdited)
    const beforeLoadFailed = comparison.failedKey === beforeRequestKey
    const hasBeforeRefresh = Boolean(onBeforeRefresh)

    // Reset during an identity change so returning to a previous photograph also
    // starts with its edit, without resetting the existing navigation crossfade.
    if (comparison.id !== activeId) setComparison(freshComparison(activeId))

    useEffect(() => () => {
        window.clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = null
        refreshedOriginalsRef.current.clear()
    }, [activeId])

    useEffect(() => {
        const previous = originalRefreshRef.current
        const needsResolution = previous.id === activeId && previous.requested && comparisonRequested
            && before?.status === 'unresolved' && previous.image?.before?.status !== 'unresolved'
        if (originalRefreshRef.current.id !== activeId || !comparisonRequested) {
            const active = originalRequestRef.current
            active?.queued?.resolve()
            if (active) active.queued = null
        }
        originalRefreshRef.current = { callback: onBeforeRefresh, image: activeImage, id: activeId, requested: comparisonRequested }
        if (!needsResolution || !onBeforeRefresh) return

        // A protected-media refresh replaces the photo with a fresh unresolved
        // hint. Resume a comparison that is already open after any old request
        // finishes; its response belongs to the photo object it started with.
        const isCurrent = () => {
            const current = originalRefreshRef.current
            return current.id === activeId && current.image === activeImage && current.requested
        }
        const resolveOriginal = () => {
            if (!isCurrent()) return
            const { callback, image } = originalRefreshRef.current
            void runOriginalRefresh(originalRequestRef, callback, undefined, image, isCurrent)
        }
        const pending = originalRequestRef.current?.promise
        if (pending) void pending.then(resolveOriginal)
        else resolveOriginal()
    }, [onBeforeRefresh, activeImage, activeId, before?.status, comparisonRequested])

    useEffect(() => () => {
        originalRefreshRef.current.requested = false
        const active = originalRequestRef.current
        active?.queued?.resolve()
        if (active) active.queued = null
    }, [])

    useEffect(() => {
        if (!comparisonRequested || before?.status !== 'pending' || !hasBeforeRefresh) return undefined
        let cancelled = false
        let inFlight = false
        let attempts = 0
        let timer = null
        const schedule = () => {
            if (cancelled || inFlight || document.visibilityState === 'hidden') return
            timer = window.setTimeout(poll, attempts < 3 ? ORIGINAL_REFRESH_INTERVAL_MS : ORIGINAL_REFRESH_SLOW_INTERVAL_MS)
        }
        const poll = async () => {
            timer = null
            if (cancelled || document.visibilityState === 'hidden') return
            inFlight = true
            attempts += 1
            try {
                const { callback, image } = originalRefreshRef.current
                await runOriginalRefresh(originalRequestRef, callback, undefined, image, () => !cancelled && document.visibilityState !== 'hidden')
            } catch { /* Leave the selected edit available; the next check is bounded. */ }
            inFlight = false
            schedule()
        }
        const handleVisibility = () => {
            window.clearTimeout(timer)
            timer = null
            schedule()
        }
        document.addEventListener('visibilitychange', handleVisibility)
        schedule()
        return () => {
            cancelled = true
            window.clearTimeout(timer)
            document.removeEventListener('visibilitychange', handleVisibility)
        }
    }, [activeId, before?.status, comparisonRequested, comparison.attempt, hasBeforeRefresh])

    if (!activeImage && !loading && !emptyMessage) return null

    const isLegacyOrDemo = typeof activeImage === 'string'
    const hasOriginalComparison = Boolean(before && ['unresolved', 'ready', 'pending', 'unavailable', 'failed'].includes(before.status))
    const hasPhotoMetadata = !isLegacyOrDemo && Boolean(activeImage?.exif)
    const hasOutgoingImage = settledImage && settledImage.id !== activeId

    const handleFullImageLoad = (event) => afterImageDecode(event.currentTarget, () => {
        const nextSettledImage = {
            id: activeId,
            image: activeImage,
            rawUrl: activeRawUrl,
            previewSrcSet,
        }

        setLoadedImageId(activeId)
        window.clearTimeout(transitionTimerRef.current)

        if (!settledImageRef.current || settledImageRef.current.id === activeId) {
            settledImageRef.current = nextSettledImage
            setSettledImage(nextSettledImage)
            return
        }

        transitionTimerRef.current = window.setTimeout(() => {
            settledImageRef.current = nextSettledImage
            setSettledImage(nextSettledImage)
            transitionTimerRef.current = null
        }, PHOTO_CROSSFADE_MS)
    }, onMediaError)

    const handlePrint = async (event) => {
        event.stopPropagation()
        if (!onPrint || !activeImage || printing) return
        setPrinting(true)
        try {
            await onPrint(event, activeImage, index)
        } finally {
            setPrinting(false)
        }
    }

    const refreshOriginal = (event, allowMediaError = false, isRetry = false) => {
        // Checking a processing status is not a media failure. In protected
        // viewers the error callback may require an entirely new access check.
        const refresh = onBeforeRefresh || (allowMediaError ? onMediaError : undefined)
        if (!refresh || refreshedOriginalsRef.current.has(beforeSourceKey)) return
        refreshedOriginalsRef.current.add(beforeSourceKey)
        // Immediate checks, retries, and scheduled checks share one in-flight
        // promise so a slow first request cannot trigger overlapping reads.
        return runOriginalRefresh(originalRequestRef, refresh, event, activeImage, () => (
            originalRefreshRef.current.id === activeId && originalRefreshRef.current.requested && document.visibilityState !== 'hidden'
        ), { reason: allowMediaError || isRetry ? 'media-error' : 'original-status' })
    }

    const handleBeforeToggle = (event) => {
        if (comparisonRequested && (beforeLoadFailed || (before?.status === 'failed' && onBeforeRefresh))) {
            refreshedOriginalsRef.current.delete(beforeSourceKey)
            setComparison((current) => ({ ...current, attempt: current.attempt + 1, loadedKey: null, failedKey: null }))
            refreshOriginal(event, beforeLoadFailed, true)
            return
        }
        setComparison((current) => ({
            ...current,
            requested: !current.requested,
            returningToEdit: showingBefore && current.requested && loadedImageId !== activeId,
        }))
        if (!comparisonRequested && !beforeIsReady && before?.status !== 'unavailable') {
            refreshedOriginalsRef.current.delete(beforeSourceKey)
            refreshOriginal(event)
        }
    }

    const handleBeforeLoad = (event) => afterImageDecode(event.currentTarget, () => {
        setComparison((current) => (
            current.id === activeId && current.attempt === comparison.attempt
                ? { ...current, loadedKey: beforeRequestKey, failedKey: null }
                : current
        ))
    }, handleBeforeError)

    const handleBeforeError = (event) => {
        if (!event.currentTarget.isConnected) return
        setComparison((current) => (
            current.id === activeId && current.attempt === comparison.attempt
                ? { ...current, loadedKey: null, failedKey: beforeRequestKey }
                : current
        ))
        refreshOriginal(event, true)
    }

    let beforeMessage = ''
    if (waitingForEdited) beforeMessage = 'Loading edited photo…'
    else if (comparisonRequested && !showingBefore) {
        if (before?.status === 'unavailable') beforeMessage = 'Unable to locate original'
        else if (beforeLoadFailed || before?.status === 'failed') beforeMessage = 'Original could not be loaded.'
        else if (beforeIsReady || before?.status === 'unresolved') beforeMessage = 'Loading original…'
        else beforeMessage = 'Preparing original…'
    }
    const beforeBusy = waitingForEdited || (comparisonRequested && !showingBefore && !beforeLoadFailed && (['unresolved', 'pending'].includes(before?.status) || beforeIsReady))
    const beforeHasError = comparisonRequested && (beforeLoadFailed || before?.status === 'failed')
    const beforeNeedsRetry = beforeHasError && (beforeLoadFailed || hasBeforeRefresh)
    const beforeUnavailable = comparisonRequested && before?.status === 'unavailable'
    const beforeButtonLabel = waitingForEdited ? 'Cancel loading edited photo'
        : beforeNeedsRetry ? 'Retry original'
        : beforeUnavailable ? 'Unable to locate original'
            : beforeBusy ? 'Cancel loading original'
                : comparisonRequested ? 'Show edited photo' : 'Show original photo'
    const beforeTitle = beforeMessage || (showingBefore ? 'Before — Camera JPG. Show edited photo' : 'After — Edited. Show original camera JPG')

    return (
        <AccessibleLightbox
            ariaLabel={ariaLabel}
            onClose={onClose}
            onNext={images.length > 1 ? onNext : undefined}
            onPrevious={images.length > 1 ? onPrevious : undefined}
            className="linen-responsive-lightbox linen-photo-lightbox fixed inset-0 z-[1000] bg-charcoal/90 flex flex-col items-center justify-center p-4 md:p-12 mb-0"
        >
            <button
                type="button"
                onClick={onClose}
                className="linen-lightbox-close fixed z-[1001] w-12 h-12 text-white/80 hover:text-white transition-colors cursor-pointer flex items-center justify-center"
                style={{
                    top: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))',
                    right: 'max(1rem, calc(env(safe-area-inset-right) + 0.5rem))',
                }}
                aria-label="Close photo viewer"
                title="Close Photo Viewer"
                data-lightbox-initial-focus
            >
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>

            <div
                className={`linen-lightbox-content flex-1 w-full min-h-0 flex flex-col items-center justify-center relative z-0 ${hasPhotoMetadata ? 'has-photo-metadata' : ''}`}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="linen-lightbox-media-stage flex-1 min-h-0 flex items-center justify-center w-full relative">
                    {activeImage ? (
                        <div
                            ref={containerRef}
                            className="linen-lightbox-media absolute inset-0"
                            style={{ gridTemplate: 'minmax(0, 1fr) / minmax(0, 1fr)' }}
                        >
                            <img
                                key={`placeholder-${activeId}`}
                                src={thumbUrl}
                                alt=""
                                width={activeImage.width}
                                height={activeImage.height}
                                style={{ width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '100%', visibility: showingBefore || loadedImageId === activeId ? 'hidden' : undefined }}
                                className={`linen-lightbox-placeholder object-contain blur-sm opacity-50 z-10 pointer-events-none ${showingBefore || loadedImageId === activeId ? 'is-placeholder-hidden' : ''}`}
                            />
                            {hasOutgoingImage && (
                                <img
                                    src={settledImage.rawUrl}
                                    srcSet={settledImage.previewSrcSet || undefined}
                                    sizes={sizesFor(settledImage.image)}
                                    alt=""
                                    aria-hidden="true"
                                    width={settledImage.image.width}
                                    height={settledImage.image.height}
                                    decoding="async"
                                    style={{ width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '100%', visibility: showingBefore ? 'hidden' : undefined }}
                                    className={`linen-lightbox-photo linen-lightbox-photo-outgoing is-loaded object-contain relative z-20 ${loadedImageId === activeId ? 'is-exiting' : ''}`}
                                />
                            )}
                            <img
                                key={`preview-${activeId}`}
                                src={activeRawUrl}
                                srcSet={previewSrcSet || undefined}
                                sizes={sizesFor(activeImage)}
                                alt="Full size preview"
                                aria-hidden={showingBefore || undefined}
                                onLoad={handleFullImageLoad}
                                onError={onMediaError}
                                width={activeImage.width}
                                height={activeImage.height}
                                decoding="async"
                                style={{ width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '100%', visibility: showingBefore ? 'hidden' : undefined }}
                                className={`linen-lightbox-photo linen-lightbox-edited object-contain relative z-30 ${loadedImageId === activeId ? 'is-loaded' : ''} ${showingBefore ? 'is-comparison-hidden' : ''}`}
                            />
                            {(comparisonRequested || comparison.loadedKey === beforeRequestKey) && beforeIsReady && !beforeLoadFailed && (
                                <img
                                    key={`original-${beforeRequestKey}`}
                                    src={beforeUrl}
                                    srcSet={beforeSrcSet || undefined}
                                    sizes={sizesFor(before)}
                                    alt="Before — Camera JPG"
                                    aria-hidden={!showingBefore || undefined}
                                    onLoad={handleBeforeLoad}
                                    onError={handleBeforeError}
                                    width={before.width}
                                    height={before.height}
                                    decoding="async"
                                    style={{ width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '100%', visibility: showingBefore ? 'visible' : 'hidden' }}
                                    className={`linen-lightbox-photo linen-lightbox-original object-contain relative z-30 ${showingBefore ? 'is-loaded' : ''}`}
                                />
                            )}
                        </div>
                    ) : (
                        <div className="text-center text-white px-6">
                            {loading ? (
                                <p role="status" className="text-sm tracking-[0.18em] uppercase">Finding random photos…</p>
                            ) : (
                                <>
                                    <p role="alert" className="text-sm">{emptyMessage}</p>
                                    {onRetry && (
                                        <button
                                            type="button"
                                            onClick={onRetry}
                                            className="mt-5 border border-white/50 px-5 py-2 text-xs uppercase tracking-[0.16em] text-white transition-colors hover:bg-white hover:text-charcoal"
                                        >
                                            Try again
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <div className="linen-lightbox-footer">
                {(images.length > 1 || hasPhotoMetadata) && (
                    <nav className={`linen-lightbox-nav ${images.length > 1 ? 'has-navigation' : ''}`} aria-label="Photo navigation">
                        {images.length > 1 && (
                            <button
                                type="button"
                                onClick={(event) => { event.stopPropagation(); onPrevious() }}
                                className="linen-lightbox-previous absolute left-4 md:left-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                                aria-label="Previous photo"
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                </svg>
                            </button>
                        )}
                        {hasPhotoMetadata && (
                            <div className="linen-lightbox-metadata shrink-0 mt-4 text-center animate-fade-in max-w-2xl px-4">
                                {activeImage.exif.model && (
                                    <p title={activeImage.exif.model} className="text-white font-medium text-sm md:text-base drop-shadow-md">
                                        {activeImage.exif.model}
                                    </p>
                                )}
                                {activeImage.exif.lens && (
                                    <p title={activeImage.exif.lens} className="text-white/80 text-xs md:text-sm drop-shadow-md mb-1">
                                        {activeImage.exif.lens}
                                    </p>
                                )}
                                <div className="flex items-center justify-center gap-4 text-white/70 text-xs md:text-sm font-light tracking-wide italic mt-2">
                                    {activeImage.exif.focalLength && <span>{activeImage.exif.focalLength}</span>}
                                    {activeImage.exif.focalRatio && <span>{activeImage.exif.focalRatio}</span>}
                                    {activeImage.exif.shutterSpeed && <span>{activeImage.exif.shutterSpeed}</span>}
                                    {activeImage.exif.iso && <span>{activeImage.exif.iso}</span>}
                                </div>
                            </div>
                        )}
                        {images.length > 1 && (
                            <button
                                type="button"
                                onClick={(event) => { event.stopPropagation(); onNext() }}
                                className="linen-lightbox-next absolute right-4 md:right-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                                aria-label="Next photo"
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>
                        )}
                    </nav>
                )}

                {activeImage && (
                    <div className="linen-lightbox-actions shrink-0 mt-6 flex flex-col items-center gap-2 z-10" onClick={(event) => event.stopPropagation()}>
                        <div className="linen-lightbox-action-buttons flex items-center justify-center gap-2">
                            {hasOriginalComparison && (
                                <button
                                    type="button"
                                    onClick={handleBeforeToggle}
                                    className="linen-lightbox-before inline-flex items-center gap-2 rounded-full border border-white/30 px-4 py-2.5 text-sm text-white/80 transition-colors hover:border-white/60 hover:bg-white/10 hover:text-white active:scale-[0.98] cursor-pointer touch-manipulation"
                                    aria-label={beforeButtonLabel}
                                    aria-pressed={showingBefore}
                                    aria-busy={beforeBusy || undefined}
                                    title={beforeNeedsRetry ? `${beforeTitle} Click to retry.` : beforeTitle}
                                >
                                    <svg className={`linen-lightbox-before-indicator h-5 w-5 ${beforeBusy ? 'is-spinning' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                        {beforeBusy ? (
                                            <path strokeLinecap="round" strokeWidth={1.5} d="M12 3a9 9 0 109 9" />
                                        ) : beforeHasError || beforeUnavailable ? (
                                            <><circle cx="12" cy="12" r="9" strokeWidth={1.5} /><path strokeLinecap="round" strokeWidth={1.5} d="M12 7v6m0 4h.01" /></>
                                        ) : (
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v18M9 5H5a2 2 0 00-2 2v10a2 2 0 002 2h4m6-14h4a2 2 0 012 2v10a2 2 0 01-2 2h-4M3 16l4-4 2 2m6-3 6 6" />
                                        )}
                                    </svg>
                                    <span className="linen-lightbox-before-label" aria-hidden="true">
                                        <span className="linen-lightbox-before-word" data-label="Before"><span className={showingBefore ? 'is-active' : ''}>Before</span></span>
                                        <span>/</span>
                                        <span className="linen-lightbox-before-word" data-label="After"><span className={!showingBefore ? 'is-active' : ''}>After</span></span>
                                    </span>
                                </button>
                            )}
                            {canShare && (
                                <LightboxShareButton
                                    media={activeImage}
                                    index={index}
                                    mediaType="photo"
                                    shareTitle={shareTitle}
                                    shareUrl={shareUrl}
                                />
                            )}
                            {onDownload && (
                                <button
                                    type="button"
                                    onClick={(event) => onDownload(event, activeImage, index)}
                                    className="linen-lightbox-download inline-flex items-center gap-2 rounded-full border border-white/30 px-4 py-2.5 text-sm text-white/80 transition-colors hover:border-white/60 hover:bg-white/10 hover:text-white active:scale-[0.98] cursor-pointer touch-manipulation"
                                    title={showingBefore ? 'Download Edited Photo' : 'Download Photo'}
                                    aria-label={showingBefore ? 'Download edited photo' : 'Download photo'}
                                >
                                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                    </svg>
                                    <span>Download</span>
                                </button>
                            )}
                            {onPrint && (
                                <button
                                    type="button"
                                    onClick={handlePrint}
                                    disabled={printing}
                                    className="linen-lightbox-print inline-flex items-center gap-2 rounded-full border border-white/30 px-4 py-2.5 text-sm text-white/80 transition-colors hover:border-white/60 hover:bg-white/10 hover:text-white active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 cursor-pointer touch-manipulation"
                                    aria-label={showingBefore ? 'Order a print of the edited photo' : 'Order a print of this photo'}
                                >
                                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 9V3h12v6M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2m-12-4h12v7H6v-7z" />
                                    </svg>
                                    <span>{printing ? 'Preparing…' : 'Order a Print'}</span>
                                </button>
                            )}
                        </div>
                        {hasOriginalComparison && (beforeHasError || beforeUnavailable) && (
                            <span className="linen-lightbox-before-tooltip" aria-hidden="true">{beforeMessage}</span>
                        )}
                        {hasOriginalComparison && (
                            <span className="linen-lightbox-before-status" role="status" aria-live="polite" aria-atomic="true">
                                {showingBefore ? 'Before — Camera JPG' : 'After — Edited'}{beforeMessage ? `. ${beforeMessage}` : ''}
                            </span>
                        )}
                        <span className="linen-lightbox-counter text-white/70 text-sm font-medium drop-shadow-md">
                            {index + 1} / {images.length}
                        </span>
                    </div>
                )}
            </div>
        </AccessibleLightbox>
    )
}

export default PhotoLightbox
