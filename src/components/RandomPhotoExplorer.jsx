import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PhotoLightbox from './PhotoLightbox'
import SectionStats from './SectionStats'
import { fetchRandomPhotos, requestAlbumMediaDownload, requestAlbumPrintSession } from '../utils/api'
import {
    mediaFileName,
    mediaDisplayUrl,
    mediaId,
    mediaPreviewSrcSet,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import { trackPhotoDownload } from '../utils/analytics'
import { openPrintOrder } from '../utils/printOrders'
import { cacheRandomPhotoSession, readRandomPhotoSession } from '../utils/randomPhotoSession'
import { shareUrlForAlbumPhoto } from '../utils/share'
import usePhotoOriginalRefresh from '../hooks/usePhotoOriginalRefresh'

const LIGHTBOX_SIZES = '(min-width: 768px) calc(100vw - 12rem), calc(100vw - 2rem)'
const STARTER_PHOTO_LIMIT = 6
const SESSION_PHOTO_LIMIT = 80

function warmStartingPhotos(images) {
    if (typeof Image === 'undefined') return
    images.slice(0, 2).forEach((image, index) => {
        const preload = new Image()
        preload.decoding = 'async'
        preload.fetchPriority = index === 0 ? 'high' : 'low'
        preload.sizes = LIGHTBOX_SIZES
        preload.srcset = mediaPreviewSrcSet(image)
        preload.src = mediaDisplayUrl(image)
        preload.onload = () => { void preload.decode?.().catch(() => {}) }
    })
}

function RandomPhotoSession({ category = '', variant = 'link', showStats = false }) {
    const controllerRef = useRef(null)
    const requestRef = useRef(null)
    const photosRef = useRef([])
    const completeRef = useRef(false)
    const openRef = useRef(false)
    const [photos, setPhotos] = useState([])
    const [index, setIndex] = useState(0)
    const [open, setOpen] = useState(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const { images: lightboxPhotos, refreshOriginal } = usePhotoOriginalRefresh(photos)
    const normalizedCategory = useMemo(() => category.trim(), [category])
    const buttonLabel = normalizedCategory
        ? `Shuffle ${normalizedCategory} photos`
        : 'Explore Random Photos'
    const lightboxLabel = normalizedCategory
        ? `Random photos from ${normalizedCategory}`
        : 'Random photos from Ian Truong Photography'

    const loadSession = useCallback(() => {
        if (photosRef.current.length) return Promise.resolve(photosRef.current)
        if (requestRef.current) return requestRef.current
        const cached = readRandomPhotoSession(normalizedCategory)
        if (cached?.length) {
            photosRef.current = cached
            completeRef.current = true
            warmStartingPhotos(cached)
            return Promise.resolve(cached)
        }

        const controller = new AbortController()
        controllerRef.current = controller
        const request = fetchRandomPhotos({
            category: normalizedCategory || undefined,
            limit: STARTER_PHOTO_LIMIT,
            signal: controller.signal,
        })
            .then((payload) => {
                if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
                const images = payload.images || []
                if (!images.length) {
                    throw new Error(normalizedCategory
                        ? `No public photos are available in ${normalizedCategory} yet.`
                        : 'No public photos are available yet.')
                }
                photosRef.current = images
                completeRef.current = images.length >= SESSION_PHOTO_LIMIT
                    || images.length >= payload.totalPhotos
                    || (!Number.isFinite(payload.totalPhotos) && images.length < STARTER_PHOTO_LIMIT)
                if (completeRef.current) cacheRandomPhotoSession(normalizedCategory, images)
                warmStartingPhotos(images)
                return images
            })
            .finally(() => {
                if (controllerRef.current === controller) controllerRef.current = null
                if (requestRef.current === request) requestRef.current = null
            })
        request.catch(() => {})
        requestRef.current = request
        return request
    }, [normalizedCategory])

    useEffect(() => () => controllerRef.current?.abort(), [])

    // Only expand an opened viewer. Hover/focus warms just the small starter.
    useEffect(() => {
        if (!open || !photos.length || completeRef.current) return undefined
        const controller = new AbortController()
        const request = fetchRandomPhotos({
            category: normalizedCategory || undefined,
            limit: SESSION_PHOTO_LIMIT,
            priority: 'low',
            signal: controller.signal,
        }).then((payload) => {
            if (controller.signal.aborted || !payload.images?.length) return
            // Keep the starter order and current index, even if the pool rotated
            // while the full deck was loading. Identity includes the album.
            const merged = [...photosRef.current]
            const seen = new Set(merged.map((photo) => `${photo.albumId}:${mediaId(photo)}`))
            for (const photo of payload.images) {
                const key = `${photo.albumId}:${mediaId(photo)}`
                if (!seen.has(key)) {
                    seen.add(key)
                    merged.push(photo)
                }
                if (merged.length >= SESSION_PHOTO_LIMIT) break
            }
            completeRef.current = true
            photosRef.current = merged
            cacheRandomPhotoSession(normalizedCategory, merged)
            setPhotos(merged)
        })
        // Background failures leave the starter usable; reopening retries.
        request.catch(() => {})
        return () => controller.abort()
    }, [open, photos.length, normalizedCategory])

    const finishOpening = useCallback(async () => {
        setError('')
        setLoading(true)
        try {
            const images = await loadSession()
            if (!openRef.current) return
            setPhotos(images)
            setIndex(0)
        } catch (requestError) {
            if (requestError?.name !== 'AbortError' && openRef.current) {
                setError(requestError?.message || 'Random photos could not be loaded.')
            }
        } finally {
            if (openRef.current) setLoading(false)
        }
    }, [loadSession])

    const handleOpen = useCallback(() => {
        openRef.current = true
        setOpen(true)
        if (photosRef.current.length) {
            setPhotos(photosRef.current)
            setIndex(0)
            setLoading(false)
            return
        }
        setPhotos([])
        setIndex(0)
        void finishOpening()
    }, [finishOpening])

    const handleRetry = useCallback(() => {
        photosRef.current = []
        completeRef.current = false
        void finishOpening()
    }, [finishOpening])

    const handleClose = useCallback(() => {
        openRef.current = false
        setOpen(false)
        setIndex(0)
        setLoading(false)
    }, [])

    const handleDownload = useCallback(async (event, image) => {
        event.stopPropagation()
        try {
            const downloadUrl = await resolveMediaDownloadUrl(
                () => requestAlbumMediaDownload(image.albumId, mediaId(image)),
                image,
            )
            startBrowserDownload(downloadUrl, mediaFileName(image, 'photo.jpg'))
            trackPhotoDownload(image.albumId)
        } catch (downloadError) {
            console.error('Random photo download failed:', downloadError)
            alert('The photo could not be downloaded. Please try again.')
        }
    }, [])

    const handlePrint = useCallback(async (event, image) => {
        event.stopPropagation()
        try {
            await openPrintOrder(() => requestAlbumPrintSession(image.albumId, mediaId(image)))
        } catch (printError) {
            console.error('Random photo print order failed:', printError)
            alert(printError?.message || 'The print store could not be opened. Please try again.')
        }
    }, [])

    return (
        <>
            {variant === 'icon' ? (
                <button
                    type="button"
                    onClick={handleOpen}
                    onPointerEnter={() => { void loadSession().catch(() => {}) }}
                    onFocus={() => { void loadSession().catch(() => {}) }}
                    className="linen-theme-toggle"
                    aria-label={buttonLabel}
                    title={buttonLabel}
                >
                    <svg className="linen-theme-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 4h3l10 16h3M20 4h-3l-3.5 5.6M4 20h3l3.5-5.6" />
                    </svg>
                </button>
            ) : (
                <button
                    type="button"
                    onClick={handleOpen}
                    onPointerEnter={() => { void loadSession().catch(() => {}) }}
                    onFocus={() => { void loadSession().catch(() => {}) }}
                    className="linen-text-link inline-flex cursor-pointer items-center gap-2 px-1 py-2 text-white font-medium transition-all duration-300"
                >
                    {buttonLabel}
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h3l10 16h3M20 4h-3l-3.5 5.6M4 20h3l3.5-5.6" />
                    </svg>
                </button>
            )}
            {showStats && <SectionStats category={normalizedCategory} />}
            {open && (
                <PhotoLightbox
                    images={lightboxPhotos}
                    index={index}
                    ariaLabel={lightboxLabel}
                    loading={loading}
                    emptyMessage={error}
                    onClose={handleClose}
                    onNext={() => setIndex((current) => (current + 1) % photos.length)}
                    onPrevious={() => setIndex((current) => (current - 1 + photos.length) % photos.length)}
                    onRetry={error ? handleRetry : undefined}
                    onDownload={handleDownload}
                    onPrint={handlePrint}
                    onBeforeRefresh={refreshOriginal}
                    shareUrl={image => shareUrlForAlbumPhoto(image.albumId, mediaId(image))}
                />
            )}
        </>
    )
}

export default function RandomPhotoExplorer(props) {
    const category = (props.category || '').trim()
    return <RandomPhotoSession key={category} {...props} category={category} />
}
