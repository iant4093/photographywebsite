import usePhotoOriginalRefresh from '../hooks/usePhotoOriginalRefresh'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useNavigationType } from 'react-router'
import { fetchAlbumForViewing, requestAlbumMediaDownload, requestAlbumPrintSession, requestAlbumZip } from '../utils/api'
import { useAuth } from '../context/auth'
import ProgressiveImage from '../components/ProgressiveImage'
import SkeletonGrid from '../components/SkeletonGrid'
import PhotoLightbox from '../components/PhotoLightbox'
import AlbumQrCode from '../components/AlbumQrCode'
import AlbumShareButton from '../components/AlbumShareButton'
import ExploreMoreAlbums from '../components/ExploreMoreAlbums'
import { useScrollRestoration } from '../utils/scroll'
import { useLocation } from 'react-router'
import {
    mediaFileName,
    mediaId,
    mediaPreviewSrcSet,
    mediaThumbnailUrl,
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
    const navType = useNavigationType()
    const location = useLocation()
    useScrollRestoration(location.pathname, navType === 'POP')

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
    // Lightbox state — store index for prev/next navigation
    const [lightboxIndex, setLightboxIndex] = useState(null)

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
                if (requestedIndex >= 0) setLightboxIndex(requestedIndex)
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
    }, [albumId, getIdToken])

    // Fetch album data on mount and clear stale content when the route changes.
    useEffect(() => {
        const controller = new AbortController()
        albumRequestScopeRef.current = { albumId, controller }
        Promise.resolve().then(() => {
            if (controller.signal.aborted) return
            setAlbum(null)
            setImages([])
            setLightboxIndex(null)
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
    }, [albumId, loadAlbum])

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
    const { images: lightboxImages, refreshOriginal } = usePhotoOriginalRefresh(images, { albumId, getIdToken })

    // Lightbox navigation — wraps around at ends
    const goNext = useCallback(() => {
        setLightboxIndex((i) => (i + 1) % images.length)
    }, [images.length])

    const goPrev = useCallback(() => {
        setLightboxIndex((i) => (i - 1 + images.length) % images.length)
    }, [images.length])

    const closeLightbox = useCallback(() => {
        setLightboxIndex(null)
        initialSharedPhotoIdRef.current.photoId = null
        if (!embedded) onSharedPhotoClose?.()
    }, [embedded, onSharedPhotoClose])

    // Download current lightbox image
    const downloadImage = async (e) => {
        e.stopPropagation()
        const img = images[lightboxIndex]
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
        <div className={`linen-gallery-page flex-1 animate-fade-in ${embedded ? 'linen-gallery-page--embedded pb-8' : 'pb-16 pt-[88px] md:pt-[104px]'}`}>
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
                {loading && (
                    <div className="flex justify-center py-32" role="status" aria-label="Loading album">
                        <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                    </div>
                )}

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
                            <div className="animate-slide-up">
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
                            {loading ? (
                                <SkeletonGrid count={6} type="photo" />
                            ) : (
                                <div className="linen-media-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {images.map((img, index) => {
                                        const thumbUrl = mediaThumbnailUrl(img)

                                        return (
                                            <button
                                                data-page-scroll-media
                                                type="button"
                                                key={mediaId(img) || index}
                                                className="linen-media-frame linen-photo-frame group cursor-pointer rounded-xl overflow-hidden transition-shadow duration-500 aspect-[4/3] relative text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
                                                onClick={() => setLightboxIndex(index)}
                                                aria-label={`Open item ${index + 1} from ${album.title}`}
                                            >
                                                <div className="linen-photo-viewport">
                                                    <ProgressiveImage
                                                        src={thumbUrl}
                                                        eager={index < eagerImageCount}
                                                        srcSet={mediaPreviewSrcSet(img) || undefined}
                                                        blurhash={img.blurhash}
                                                        width={img.width}
                                                        height={img.height}
                                                        sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                                                        alt={`Item ${index + 1} from ${album.title}`}
                                                        onError={() => requestMediaRefresh('media-error')}
                                                        className="w-full h-full"
                                                    />
                                                    {/* Warm overlay on hover */}
                                                    <div className="absolute inset-0 bg-gradient-to-t from-charcoal/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                                                </div>
                                            </button>
                                        )
                                    })}
                                </div>
                            )}

                            {/* Empty state */}
                            {!loading && images.length === 0 && (
                                <div className="text-center py-20 text-warm-gray">
                                    <p className="text-lg">No photos in this album yet.</p>
                                </div>
                            )}
                        </div>

                        {!embedded && <ExploreMoreAlbums album={album} mediaType="photo" />}

                        {/* Lightbox Overlay */}
                        {lightboxIndex !== null && images[lightboxIndex] && (
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
                                onMediaError={() => requestMediaRefresh('media-error')}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}

export default AlbumGallery
