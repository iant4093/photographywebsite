import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import AccessibleLightbox from './AccessibleLightbox'
import PhotoLightboxNavigation from './PhotoLightboxNavigation'
import PhotoZoomFrame from './PhotoZoomFrame'
import LightboxShareButton from './LightboxShareButton'
import useContainedImageSizes from '../hooks/useContainedImageSizes'
import { loadExplorerViewer, readExplorerViewer } from '../utils/explorerViewer'
import { mediaBeforeDisplayUrl, mediaBeforeSrcSet, mediaDisplayUrl, mediaId, mediaPreviewSrcSet } from '../utils/mediaUrls'
import { photoDescription } from '../utils/mediaAccessibility'
import { markImageReady } from '../utils/imageReadiness'
import { afterImageDecode } from '../utils/viewerImageReadiness'
import { prefetchPhoto } from '../utils/photoPrefetch'

const PHOTO_STYLE = { width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '100%' }
const ACTION_CLASS = 'inline-flex items-center gap-2 rounded-full border border-white/30 px-4 py-2.5 text-sm text-white/80 transition-colors hover:border-white/60 hover:bg-white/10 hover:text-white active:scale-[0.98]'

// The small dialog remains usable while a cold tap downloads the viewer code.
// Photo data and code load in parallel; it can show the warmed photo and accept
// close/next/previous immediately instead of replacing the page with a spinner.
export default function ExplorerPhotoLightbox(props) {
    const [state, setState] = useState(() => ({ Viewer: readExplorerViewer(), error: false, attempt: 0 }))
    const [Viewer, setViewer] = useState(() => readExplorerViewer())
    const [preview, setPreview] = useState({ id: null, ready: null, outgoing: null })
    const [printing, setPrinting] = useState(false)
    const [comparison, setComparison] = useState({ id: null, requested: false, ready: null })
    const closeControl = useRef(null)
    const focusedLabel = useRef(null)
    const lastInput = useRef(0)
    const pointerDown = useRef(false)
    const { containerRef, sizesFor, bounds } = useContainedImageSizes()
    const image = props.images[props.index]
    const imageId = image ? (mediaId(image) || props.index) : null
    const refreshRef = useRef({ image, callback: props.onBeforeRefresh })
    const readyImage = preview.ready?.id
    if (preview.id !== imageId) setPreview({ id: imageId, ready: null, outgoing: preview.ready })
    const beforeUrl = mediaBeforeDisplayUrl(image)
    const beforeSet = mediaBeforeSrcSet(image)
    const beforeKey = JSON.stringify([imageId, beforeUrl, beforeSet])
    const comparisonRequested = comparison.id === imageId && comparison.requested
    const originalReady = comparison.ready === beforeKey
    const showingBefore = comparisonRequested && originalReady && Boolean(beforeUrl)
    const hasComparison = image?.before && ['unresolved', 'ready', 'pending', 'unavailable', 'failed'].includes(image.before.status)
    const unavailable = comparisonRequested && image?.before?.status === 'unavailable'
    const beforeMessage = comparisonRequested && !showingBefore
        ? unavailable ? 'Unable to locate original' : image?.before?.status === 'failed' ? 'Original could not be loaded.' : 'Loading original…'
        : ''

    useEffect(() => {
        if (!preview.outgoing) return undefined
        const outgoing = preview.outgoing
        const timer = window.setTimeout(() => setPreview(current => current.outgoing === outgoing ? { ...current, outgoing: null } : current), 360)
        return () => window.clearTimeout(timer)
    }, [preview.outgoing])

    useEffect(() => {
        if (Viewer || readyImage !== imageId || props.images.length < 2 || !bounds.width || !bounds.height) return undefined
        let release = () => {}
        const timer = window.setTimeout(() => {
            const next = props.images[(props.index + 1) % props.images.length]
            release = prefetchPhoto(next, Number.parseFloat(sizesFor(next)))
        }, 200)
        return () => { window.clearTimeout(timer); release() }
    }, [Viewer, readyImage, imageId, props.images, props.index, bounds.width, bounds.height, sizesFor])

    useEffect(() => {
        let active = true
        loadExplorerViewer({ retry: state.attempt > 0 }).then(Viewer => {
            if (active) setState(current => ({ ...current, Viewer, error: false }))
        }).catch(() => {
            if (active) setState(current => ({ ...current, error: true }))
        })
        return () => { active = false }
    }, [state.attempt])

    useLayoutEffect(() => { refreshRef.current = { image, callback: props.onBeforeRefresh } }, [image, props.onBeforeRefresh])

    useEffect(() => {
        if (!state.Viewer || Viewer) return undefined
        const dialog = closeControl.current?.closest('[role="dialog"]')
        if (!dialog) return undefined
        let timer
        const promote = () => {
            if (dialog.hasAttribute('inert') || printing || pointerDown.current || preview.outgoing
                || dialog.querySelector('.is-zoomed, .is-panning')
                || dialog.querySelector('.linen-lightbox-share')?.textContent.includes('Link Copied')) return
            if (Date.now() - lastInput.current < 200) { schedule(); return }
            const frame = dialog.querySelector('.linen-lightbox-photo-frame:not(.is-hidden):not(.is-outgoing)')
            if (image && (!frame?.classList.contains('is-loaded') || Number(getComputedStyle(frame).opacity || 1) < .99
                || frame.getAnimations?.({ subtree: true }).some(animation => animation.playState === 'running'))) return
            setViewer(() => state.Viewer)
        }
        const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(promote, 200) }
        const observer = new MutationObserver(schedule)
        observer.observe(dialog, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'inert'] })
        dialog.addEventListener('transitionend', schedule)
        dialog.addEventListener('pointerup', schedule)
        dialog.addEventListener('keyup', schedule)
        schedule()
        return () => {
            window.clearTimeout(timer); observer.disconnect()
            dialog.removeEventListener('transitionend', schedule)
            dialog.removeEventListener('pointerup', schedule)
            dialog.removeEventListener('keyup', schedule)
        }
    }, [state.Viewer, Viewer, printing, preview.outgoing, image])

    // Keep the existing bounded original-status cadence if an active zoom or
    // print checkout deliberately postpones the non-disruptive enhancement.
    useEffect(() => {
        if (Viewer || !comparisonRequested || !['unresolved', 'pending'].includes(image?.before?.status)) return undefined
        let active = true, timer
        const expiresAt = Date.now() + 15 * 60_000
        const poll = async () => {
            if (!active || Date.now() >= expiresAt) return
            let delay = document.visibilityState === 'hidden' ? 60_000 : 20_000
            if (document.visibilityState !== 'hidden') {
                const { callback, image: currentImage } = refreshRef.current
                try {
                    const result = await callback?.(undefined, currentImage, { reason: 'original-status' })
                    if (Number.isFinite(result?.retryAfterMs)) delay = Math.max(delay, result.retryAfterMs)
                } catch (error) {
                    if (Number.isFinite(error?.retryAfterMs)) delay = Math.max(delay, error.retryAfterMs)
                }
            }
            if (active) timer = window.setTimeout(poll, delay)
        }
        timer = window.setTimeout(poll, 20_000)
        return () => { active = false; window.clearTimeout(timer) }
    }, [Viewer, comparisonRequested, imageId, image?.before?.status])

    useLayoutEffect(() => {
        const close = closeControl.current
        const dialog = close?.closest('[role="dialog"]')
        if (!Viewer || !dialog || document.activeElement !== document.body || dialog.hasAttribute('inert')) return
        const control = [...dialog.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === focusedLabel.current && !button.disabled)
        const target = control || close
        target?.focus({ preventScroll: true })
    }, [Viewer])

    return (
        <AccessibleLightbox
            explicitTabOrder
            onPointerDownCapture={() => { pointerDown.current = true; lastInput.current = Date.now() }}
            onPointerUpCapture={() => { pointerDown.current = false; lastInput.current = Date.now() }}
            onPointerCancelCapture={() => { pointerDown.current = false }}
            onKeyDownCapture={() => { lastInput.current = Date.now() }}
            onFocusCapture={event => {
                if (event.target === event.currentTarget) {
                    const control = [...event.currentTarget.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === focusedLabel.current && !button.disabled)
                    control?.focus({ preventScroll: true })
                } else focusedLabel.current = event.target.getAttribute('aria-label')
            }}
            ariaLabel={props.ariaLabel}
            onClose={props.onClose}
            onNext={props.images.length > 1 ? props.onNext : undefined}
            onPrevious={props.images.length > 1 ? props.onPrevious : undefined}
            className={`${Viewer ? '' : 'explorer-viewer-pending'} linen-responsive-lightbox linen-photo-lightbox fixed inset-0 z-[1000] bg-charcoal/90 flex flex-col items-center justify-center p-4 md:p-12 mb-0`}
        >
            {Viewer ? <Viewer {...props} embedded initialFocusRef={closeControl} printingState={[printing, setPrinting]}
                initialImageReady={imageId !== null && readyImage === imageId}
                initialComparisonRequested={comparisonRequested} initialOriginalReady={originalReady && Boolean(beforeUrl)} /> : <>
            <button ref={closeControl} type="button" onClick={props.onClose} aria-label="Close photo viewer" title="Close Photo Viewer"
                data-lightbox-initial-focus data-camera-cursor="close"
                className="linen-lightbox-close fixed z-[1001] w-12 h-12 text-white/80 hover:text-white transition-colors cursor-pointer flex items-center justify-center"
                style={{ top: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))', right: 'max(1rem, calc(env(safe-area-inset-right) + 0.5rem))' }}>
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
            <div className={`linen-lightbox-content flex-1 w-full min-h-0 flex flex-col items-center justify-center relative z-0 ${image?.exif ? 'has-photo-metadata' : ''}`}
                onClick={event => {
                    if (event.target.closest('button, a, img, input, select, textarea, [role="button"]')) return
                    event.stopPropagation()
                    props.onClose()
                }}>
                <div className="linen-lightbox-media-stage flex-1 min-h-0 flex items-center justify-center w-full relative">
                    {image ? (
                        <div ref={containerRef} className="linen-lightbox-media absolute inset-0" style={{ gridTemplate: 'minmax(0, 1fr) / minmax(0, 1fr)' }}>
                        {preview.outgoing && <PhotoZoomFrame key={`outgoing-${imageId}`} bounds={bounds} outgoing visible={!showingBefore}
                            src={mediaDisplayUrl(preview.outgoing.image)} srcSet={mediaPreviewSrcSet(preview.outgoing.image) || undefined}
                            sizes={sizesFor(preview.outgoing.image)} width={preview.outgoing.image.width} height={preview.outgoing.image.height}
                            alt="" aria-hidden="true" decoding="async" className="linen-lightbox-photo linen-lightbox-photo-outgoing object-contain relative z-20"
                            style={PHOTO_STYLE} />}
                        <PhotoZoomFrame key={imageId} bounds={bounds} loaded={readyImage === imageId} visible={!showingBefore}
                            src={mediaDisplayUrl(image)} srcSet={mediaPreviewSrcSet(image) || undefined}
                            sizes={sizesFor(image)} width={image.width} height={image.height} decoding="async" fetchPriority="high"
                            alt={photoDescription(image, props.ariaLabel, props.index, props.images.length)}
                            className={`linen-lightbox-photo linen-lightbox-edited object-contain relative z-30 ${readyImage === imageId ? 'is-loaded' : ''}`}
                            style={PHOTO_STYLE}
                            onLoad={event => {
                                const element = event.currentTarget
                                afterImageDecode(element, () => {
                                    setPreview(current => current.id === imageId ? { ...current, ready: { id: imageId, image } } : current)
                                    markImageReady(element.currentSrc || element.src)
                                }, props.onMediaError)
                            }} />
                        {comparisonRequested && beforeUrl && <PhotoZoomFrame key={beforeKey} bounds={bounds}
                            loaded={originalReady} visible={showingBefore} src={beforeUrl} srcSet={beforeSet || undefined}
                            sizes={sizesFor(image.before)} width={image.before.width} height={image.before.height} decoding="async"
                            alt={`Before editing — ${photoDescription(image, props.ariaLabel, props.index, props.images.length)}`}
                            className={`linen-lightbox-photo linen-lightbox-original object-contain relative z-30 ${originalReady ? 'is-loaded' : ''}`}
                            style={PHOTO_STYLE}
                            onLoad={event => afterImageDecode(event.currentTarget, () => setComparison(current => ({ ...current, ready: beforeKey })))}
                            onError={event => { void Promise.resolve(props.onBeforeRefresh?.(event, image, { reason: 'media-error' })).catch(() => {}) }} />}
                        </div>
                    ) : <div className="text-center text-white px-6">
                        {props.loading && <p role="status" className="text-sm tracking-[0.18em] uppercase">{props.loadingMessage || 'Finding random photos…'}</p>}
                        {props.emptyMessage && <p role="alert">{props.emptyMessage}</p>}
                        {props.onRetry && <button type="button" onClick={props.onRetry}>Try again</button>}
                    </div>}
                </div>
            </div>
            <div className="linen-lightbox-footer">
                <PhotoLightboxNavigation image={image} navigable={props.images.length > 1} onPrevious={props.onPrevious} onNext={props.onNext} />
                {image && <div className="linen-lightbox-actions shrink-0 mt-6 flex flex-col items-center gap-2 z-10">
                    <div className="linen-lightbox-action-buttons flex items-center justify-center gap-2">
                        {hasComparison && <button type="button" className={`linen-lightbox-before ${ACTION_CLASS} cursor-pointer touch-manipulation`}
                            aria-label={comparisonRequested ? showingBefore ? 'Show edited photo' : unavailable ? 'Unable to locate original' : 'Cancel loading original' : 'Show original photo'} aria-pressed={showingBefore}
                            onClick={event => {
                                event.stopPropagation()
                                setComparison(current => ({ ...current, id: imageId, requested: !comparisonRequested }))
                                if (!comparisonRequested && image.before.status === 'unresolved') void Promise.resolve(props.onBeforeRefresh?.(event, image)).catch(() => {})
                            }}>
                            <svg className="linen-lightbox-before-indicator h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v18M9 5H5a2 2 0 00-2 2v10a2 2 0 002 2h4m6-14h4a2 2 0 012 2v10a2 2 0 01-2 2h-4M3 16l4-4 2 2m6-3 6 6" /></svg>
                            <span className="linen-lightbox-before-label" aria-hidden="true"><span className="linen-lightbox-before-word" data-label="Before"><span className={showingBefore ? 'is-active' : ''}>Before</span></span><span>/</span><span className="linen-lightbox-before-word" data-label="After"><span className={!showingBefore ? 'is-active' : ''}>After</span></span></span>
                        </button>}
                        <LightboxShareButton media={image} index={props.index} mediaType="photo" shareUrl={props.shareUrl} />
                        {props.onDownload && <button type="button" onClick={event => props.onDownload(event, image, props.index)}
                            className={`linen-lightbox-download ${ACTION_CLASS} cursor-pointer touch-manipulation`} aria-label="Download photo">
                            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg><span>Download</span>
                        </button>}
                        {props.onPrint && <button type="button" disabled={printing} onClick={async event => {
                            event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); setPrinting(true)
                            try { await props.onPrint(event, image, props.index) } finally { setPrinting(false) }
                        }} className={`linen-lightbox-print ${ACTION_CLASS} disabled:cursor-wait disabled:opacity-60 cursor-pointer touch-manipulation`} aria-label="Order a print of this photo">
                            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 9V3h12v6M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2m-12-4h12v7H6v-7z" /></svg><span>{printing ? 'Preparing…' : 'Order a Print'}</span>
                        </button>}
                    </div>
                    {hasComparison && <span className="linen-lightbox-before-status" role="status" aria-live="polite">{showingBefore ? 'Before — Camera JPG' : 'After — Edited'}{beforeMessage ? `. ${beforeMessage}` : ''}</span>}
                    <span className="linen-lightbox-counter text-white/70 text-sm font-medium drop-shadow-md">{props.index + 1} / {props.images.length}</span>
                </div>}
                {state.error && <p role="alert" className="fixed top-4 left-4 text-white text-center" style={{ right: '5rem', zIndex: 1002 }}>
                    Photo controls could not be loaded.{' '}
                    <button type="button" className="underline" onClick={() => setState(current => ({ ...current, error: false, attempt: current.attempt + 1 }))}>Try again</button>
                </p>}
            </div>
            </>}
        </AccessibleLightbox>
    )
}
