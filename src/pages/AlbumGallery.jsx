import usePhotoSections from '../hooks/usePhotoSections'
import AlbumPhotoSections from '../components/AlbumPhotoSections'
import usePhotoOriginalRefresh from '../hooks/usePhotoOriginalRefresh'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router'
import { fetchAlbumForViewing, requestAlbumMediaDownload, requestAlbumPrintSession, requestAlbumZip } from '../utils/api'
import { useAuth } from '../context/auth'
import AlbumLoadingSkeleton from '../components/AlbumLoadingSkeleton'
import PhotoLightbox from '../components/PhotoLightbox'
import AlbumQrCode from '../components/AlbumQrCode'
import AlbumShareButton from '../components/AlbumShareButton'
import AlbumStats from '../components/AlbumStats'
import ExploreMoreAlbums from '../components/ExploreMoreAlbums'
import { useLocation } from 'react-router'
import {
    mediaFileName,
    mediaId,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import { useMediaExpiryRefresh } from '../utils/useMediaExpiryRefresh'
import { reuseOriginalPreviews } from '../utils/originalPreviewReuse'
import { pollZipJob } from '../utils/zipDownload'
import { navigateBackOr } from '../utils/navigation'
import { openPrintOrder } from '../utils/printOrders'
import { trackAlbumView, trackPhotoDownload, trackZipRequest } from '../utils/analytics'
import { shareUrlForAlbumPhoto } from '../utils/share'



// The route owns navigation and document scroll memory. The same album content
// can also live inside the museum without reading or changing its URL.
function AlbumGallery() {
    const { albumId } = useParams()
    const navigate = useNavigate()
    const location = useLocation()

    const clearSharedPhoto = useCallback(() => {
        const params = new URLSearchParams(location.search)
        if (!params.has('photo')) return
        params.delete('photo')
        navigate({ pathname: location.pathname, search: params.toString() ? `?${params}` : '' }, {
            replace: true,
            preventScrollReset: true,
        })
    }, [location.pathname, location.search, navigate])
    const handleBack = useCallback(
        () => navigateBackOr(navigate, '/#photo-albums'),
        [navigate],
    )

    return <AlbumGalleryContent
        albumId={albumId}
        initialPhotoId={new URLSearchParams(location.search).get('photo') || ''}
        onSharedPhotoClose={clearSharedPhoto}
        onBack={handleBack}
    />
}

export function AlbumGalleryContent({ albumId, embedded = false, onBack, initialPhotoId = '', onSharedPhotoClose }) {
    const initialSharedPhotoIdRef = useRef({ albumId, photoId: embedded ? '' : initialPhotoId })

    const [album, setAlbum] = useState(null)
    const [images, setImages] = useState([])
    const [loading, setLoading] = useState(true)
    const [downloading, setDownloading] = useState(false)
    const [loadError, setLoadError] = useState('')
    const [mediaError, setMediaError] = useState('')
    const [zipError, setZipError] = useState('')
    const [zipStatus, setZipStatus] = useState('')
    const zipControllerRef = useRef(null)
    const trackedAlbumRef = useRef(null)
    const albumRequestScopeRef = useRef(null)
    const { getIdToken } = useAuth()
    // Start the first grid row immediately at the current column breakpoint.
    const eagerImageCount = window.matchMedia?.('(min-width: 1024px)').matches ? 3
        : window.matchMedia?.('(min-width: 640px)').matches ? 2 : 1
    // Each photo section owns its lightbox navigation.
    const { sections, activeImages, lightboxIndex, openPhoto, resetLightbox, goNext, goPrev } = usePhotoSections(images)

    const loadAlbum = useCallback(async ({ signal, background = false, openPhotoId = '', reuseOriginals = true } = {}) => {
        const scope = albumRequestScopeRef.current
        if (!signal && (!scope || scope.albumId !== albumId)) return undefined
        const requestSignal = signal || scope.controller.signal
        if (requestSignal.aborted) return undefined
        if (!background) setLoading(true)
        try {
            const data = await fetchAlbumForViewing(albumId, getIdToken, { signal: requestSignal, force: background })
            // A background original-status request can finish after navigation,
            // including when a provider has already delivered its response.
            if (requestSignal.aborted) return undefined
            setAlbum(data.album || data)
            const nextImages = data.images || []
            setImages(current => background && reuseOriginals
                ? reuseOriginalPreviews(current, nextImages, { albumId }) : nextImages)
            if (!background && openPhotoId) {
                const requestedIndex = nextImages.findIndex(image => mediaId(image) === openPhotoId)
                if (requestedIndex >= 0) openPhoto(nextImages[requestedIndex])
            }
            setLoadError('')
            setMediaError('')
            return data
        } catch (err) {
            if (requestSignal.aborted) return undefined
            if (err?.name !== 'AbortError') {
                console.error("Failed to load album:", err)
                const message = background
                    ? 'Some photo links expired and could not be refreshed. Check your connection and try again.'
                    : 'This album could not be loaded. It may not exist or you may not have access.'
                if (background) setMediaError(message)
                else setLoadError(message)
            }
            throw err
        } finally {
            if (!background && !requestSignal.aborted) setLoading(false)
        }
    }, [albumId, getIdToken, openPhoto])

    // Fetch album data on mount and clear stale content when the route changes.
    useEffect(() => {
        const controller = new AbortController()
        albumRequestScopeRef.current = { albumId, controller }
        Promise.resolve().then(() => {
            if (controller.signal.aborted) return
            setAlbum(null)
            setImages([])
            resetLightbox()
            setLoadError('')
            setMediaError('')
            setDownloading(false)
            setZipError('')
            setZipStatus('')
            const sharedPhoto = initialSharedPhotoIdRef.current
            return loadAlbum({
                signal: controller.signal,
                openPhotoId: sharedPhoto.albumId === albumId ? sharedPhoto.photoId : '',
            })
        }).catch(() => {})
        return () => {
            controller.abort()
            if (albumRequestScopeRef.current?.controller === controller) albumRequestScopeRef.current = null
        }
    }, [albumId, loadAlbum, resetLightbox])

    useEffect(() => () => zipControllerRef.current?.abort(), [albumId])

    useEffect(() => {
        if (album?.visibility === 'public' && trackedAlbumRef.current !== albumId) {
            trackedAlbumRef.current = albumId
            trackAlbumView(albumId)
        }
    }, [album, albumId])

    const refreshMedia = useCallback(
        reason => loadAlbum({ background: true, reuseOriginals: reason !== 'media-error' }),
        [loadAlbum],
    )
    const requestMediaRefresh = useMediaExpiryRefresh(images, refreshMedia)
    const handleMediaError = useCallback(() => requestMediaRefresh('media-error'), [requestMediaRefresh])
    const { images: lightboxImages, refreshOriginal } = usePhotoOriginalRefresh(activeImages, { albumId, getIdToken })

    const closeLightbox = useCallback(() => {
        resetLightbox()
        initialSharedPhotoIdRef.current.photoId = null
        if (!embedded) onSharedPhotoClose?.()
    }, [embedded, onSharedPhotoClose, resetLightbox])

    // Download current lightbox image
    const downloadImage = async (e) => {
        e.stopPropagation()
        const img = activeImages[lightboxIndex]
        if (!img) return

        try {
            let token = null
            try { token = await getIdToken() } catch { /* public album */ }
            const downloadUrl = await resolveMediaDownloadUrl(
                () => requestAlbumMediaDownload(albumId, mediaId(img), token),
                img,
            )
            startBrowserDownload(downloadUrl, mediaFileName(img, 'photo.jpg'))
            if (album?.visibility === 'public') trackPhotoDownload(albumId)
        } catch (err) {
            console.error('Download failed:', err)
            alert('The photo could not be downloaded. Please try again.')
        }
    }

    const printImage = async (event, image) => {
        event.stopPropagation()
        if (!image) return
        try {
            let token = null
            try { token = await getIdToken() } catch { /* public album */ }
            await openPrintOrder(() => requestAlbumPrintSession(albumId, mediaId(image), token))
        } catch (error) {
            console.error('Print order failed:', error)
            alert(error?.message || 'The print store could not be opened. Please try again.')
        }
    }

    // Download all photos in the album as a ZIP file (Using Backend Generator)
    async function downloadAll() {
        if (!images.length || !album) return
        zipControllerRef.current?.abort()
        const controller = new AbortController()
        zipControllerRef.current = controller
        setDownloading(true)
        if (album.visibility === 'public') trackZipRequest(albumId)
        setZipError('')
        setZipStatus('starting')
        try {
            let token = null
            try {
                token = await getIdToken()
            } catch {
                // Not logged in, token stays null — ZIP endpoint doesn't require auth
            }

            const url = await pollZipJob({
                jobKey: `album:${albumId}`,
                request: ({ signal }) => requestAlbumZip(albumId, token, { signal }),
                signal: controller.signal,
                onStatus: setZipStatus,
            })
            if (controller.signal.aborted) return
            startBrowserDownload(url, `${album.title || 'album'}.zip`)
        } catch (err) {
            if (err?.name !== 'AbortError') {
                console.error('ZIP Download failed:', err)
                setZipError(err?.message || 'The ZIP could not be generated. Please try again later.')
            }
        } finally {
            if (zipControllerRef.current === controller) {
                zipControllerRef.current = null
                setDownloading(false)
                setZipStatus('')
            }
        }
    }



    return (
        <div aria-busy={loading} className={`linen-gallery-page flex-1 animate-fade-in ${embedded ? 'linen-gallery-page--embedded pb-8' : 'min-h-screen pb-16 pt-[88px] md:pt-[104px]'}`}>
            <div className="max-w-7xl mx-auto px-6 pt-8 md:pt-12">
                {/* Back link — uses browser back to preserve scroll position */}
                {onBack && <button
                    onClick={onBack}
                    className="linen-gallery-back inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8 cursor-pointer"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    {embedded ? 'Back to Gallery' : 'Back to Albums'}
                </button>}

                {/* Loading state */}
                {loading && <AlbumLoadingSkeleton />}

                {!loading && !album && (
                    <div className="py-24 text-center">
                        <p className="text-warm-gray">{loadError || 'This album could not be loaded.'}</p>
                        {onBack && <button onClick={onBack} className="mt-4 text-amber hover:underline">Go Back</button>}
                    </div>
                )}

                {/* Album content */}
                {!loading && album && (
                    <div>
                        {/* Album header with slide-up animation */}
                        <div className="linen-gallery-header mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-warm-gray/10 animate-fade-in">
                            <div className="min-w-0 animate-slide-up">
                                <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-4 w-fit">
                                    {album.title}
                                </h1>
                                {album.description && (
                                    <p className="text-lg text-warm-gray max-w-2xl leading-relaxed whitespace-pre-wrap">
                                        {album.description}
                                    </p>
                                )}
                                <p className="text-sm text-warm-gray/70 mt-4 uppercase tracking-wider font-medium">
                                    {new Date(album.createdAt).toLocaleDateString('en-US', {
                                        year: 'numeric',
                                        month: 'long',
                                        day: 'numeric',
                                    })}
                                </p>
                                <AlbumStats images={images} />
                            </div>

                            <div className="flex flex-col items-stretch gap-3 shrink-0 mb-1">
                                    {album.visibility === 'public' && <AlbumShareButton albumTitle={album.title} url={embedded ? shareUrlForAlbumPhoto(albumId) : undefined} />}
                                    <AlbumQrCode albumTitle={album.title} qrCodeUrl={album.qrCodeUrl} />
                                    {images.length > 0 && (
                                        <button
                                            onClick={downloadAll}
                                            disabled={downloading}
                                            className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium transition-all duration-300 shadow-warm-sm border border-transparent disabled:opacity-70 disabled:cursor-not-allowed bg-amber text-white hover:bg-amber-dark hover:scale-105 active:scale-95"
                                        >
                                            {downloading ? (
                                                <>
                                                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                                    {zipStatus === 'rate_limited' ? 'Waiting...' : 'Preparing...'}
                                                </>
                                            ) : (
                                                <>
                                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                                    </svg>
                                                    Download All
                                                </>
                                            )}
                                        </button>
                                    )}
                            </div>
                        </div>

                        {(mediaError || zipError) && (
                            <div role="alert" className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                                {mediaError || zipError}
                            </div>
                        )}

                        {/* Image grid */}
                        <div className="mb-12">
                            <AlbumPhotoSections sections={sections} albumTitle={album.title} onOpen={openPhoto}
                                eagerImageCount={eagerImageCount} onMediaError={handleMediaError} prioritizeViewport />

                            {/* Empty state */}
                            {!loading && images.length === 0 && (
                                <div className="text-center py-20 text-warm-gray">
                                    <p className="text-lg">No photos in this album yet.</p>
                                </div>
                            )}
                        </div>

                        {!embedded && <ExploreMoreAlbums album={album} mediaType="photo" />}

                        {/* Lightbox Overlay */}
                        {lightboxIndex !== null && activeImages[lightboxIndex] && (
                            <PhotoLightbox
                                images={lightboxImages}
                                index={lightboxIndex}
                                ariaLabel={`Photo viewer for ${album.title}`}
                                onClose={closeLightbox}
                                onNext={goNext}
                                onPrevious={goPrev}
                                onDownload={downloadImage}
                                onPrint={printImage}
                                canShare={album.visibility === 'public'}
                                shareTitle={`${album.title} — Ian Truong Photography`}
                                shareUrl={image => shareUrlForAlbumPhoto(albumId, mediaId(image))}
                                onBeforeRefresh={refreshOriginal}
                                onMediaError={handleMediaError}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}

export default AlbumGallery
