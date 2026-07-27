import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useNavigationType } from 'react-router'
import { fetchAlbum, requestAlbumMediaDownload, requestAlbumZip } from '../utils/api'
import { useAuth } from '../context/auth'
import ProgressiveImage from '../components/ProgressiveImage'
import SkeletonGrid from '../components/SkeletonGrid'
import { useScrollRestoration } from '../utils/scroll'
import { useLocation } from 'react-router'
import {
    mediaDisplayUrl,
    mediaFileName,
    mediaId,
    mediaPreviewSrcSet,
    mediaThumbnailUrl,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import { useMediaExpiryRefresh } from '../utils/useMediaExpiryRefresh'
import { pollZipJob } from '../utils/zipDownload'



// Album gallery page — displays all images in a masonry-like grid
function AlbumGallery() {
    const { albumId } = useParams()
    const navigate = useNavigate()
    const navType = useNavigationType()
    const location = useLocation()

    // Manage scroll memory for this page (saves position for when user returns from a photo or deep link)
    useScrollRestoration(location.pathname, navType === 'POP')

    const [album, setAlbum] = useState(null)
    const [images, setImages] = useState([])
    const [loading, setLoading] = useState(true)
    const [downloading, setDownloading] = useState(false)
    const [loadError, setLoadError] = useState('')
    const [mediaError, setMediaError] = useState('')
    const [zipError, setZipError] = useState('')
    const [zipStatus, setZipStatus] = useState('')
    const zipControllerRef = useRef(null)
    const { getIdToken } = useAuth()
    // Lightbox state — store index for prev/next navigation
    const [lightboxIndex, setLightboxIndex] = useState(null)

    const loadAlbum = useCallback(async ({ signal, background = false } = {}) => {
        if (!background) setLoading(true)
        try {
            let token = null
            try {
                token = await getIdToken()
            } catch {
                // Not logged in, token stays null
            }
            const data = await fetchAlbum(albumId, token, { signal })
            setAlbum(data.album || data)
            setImages(data.images || [])
            setLoadError('')
            setMediaError('')
            return data
        } catch (err) {
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
            if (!background && !signal?.aborted) setLoading(false)
        }
    }, [albumId, getIdToken])

    // Fetch album data on mount and clear stale content when the route changes.
    useEffect(() => {
        const controller = new AbortController()
        Promise.resolve().then(() => {
            if (controller.signal.aborted) return
            setAlbum(null)
            setImages([])
            setLightboxIndex(null)
            setLoadError('')
            setMediaError('')
            return loadAlbum({ signal: controller.signal })
        }).catch(() => {})
        return () => controller.abort()
    }, [albumId, loadAlbum])

    useEffect(() => () => zipControllerRef.current?.abort(), [])

    const refreshMedia = useCallback(
        () => loadAlbum({ background: true }),
        [loadAlbum],
    )
    const requestMediaRefresh = useMediaExpiryRefresh(images, refreshMedia)

    // Lightbox navigation — wraps around at ends
    const goNext = useCallback(() => {
        setLightboxIndex((i) => (i + 1) % images.length)
    }, [images.length])

    const goPrev = useCallback(() => {
        setLightboxIndex((i) => (i - 1 + images.length) % images.length)
    }, [images.length])

    // Keyboard navigation for lightbox
    useEffect(() => {
        if (lightboxIndex === null) return
        function handleKey(e) {
            if (e.key === 'ArrowRight') goNext()
            if (e.key === 'ArrowLeft') goPrev()
            if (e.key === 'Escape') setLightboxIndex(null)
        }
        window.addEventListener('keydown', handleKey)
        return () => window.removeEventListener('keydown', handleKey)
    }, [lightboxIndex, goNext, goPrev])

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
        } catch (err) {
            console.error('Download failed:', err)
            alert('The photo could not be downloaded. Please try again.')
        }
    }

    // Download all photos in the album as a ZIP file (Using Backend Generator)
    async function downloadAll() {
        if (!images.length || !album) return
        zipControllerRef.current?.abort()
        const controller = new AbortController()
        zipControllerRef.current = controller
        setDownloading(true)
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
        <div className="linen-gallery-page flex-1 animate-fade-in pb-16 pt-[88px] md:pt-[104px]">
            <div className="max-w-7xl mx-auto px-6 pt-8 md:pt-12">
                {/* Back link — uses browser back to preserve scroll position */}
                <button
                    onClick={() => navigate(-1)}
                    className="linen-gallery-back inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8 cursor-pointer"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Albums
                </button>

                {/* Loading state */}
                {loading && (
                    <div className="flex justify-center py-32">
                        <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
                    </div>
                )}

                {!loading && !album && (
                    <div className="py-24 text-center">
                        <p className="text-warm-gray">{loadError || 'This album could not be loaded.'}</p>
                        <button onClick={() => navigate(-1)} className="mt-4 text-amber hover:underline">Go Back</button>
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

                            {/* Download All Button */}
                            {images.length > 0 && (
                                <button
                                    onClick={downloadAll}
                                    disabled={downloading}
                                    className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium transition-all duration-300 shadow-warm-sm border border-transparent disabled:opacity-70 disabled:cursor-not-allowed bg-amber text-white hover:bg-amber-dark hover:scale-105 active:scale-95 shrink-0 mb-1"
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

                        {/* Lightbox Overlay */}
                        {lightboxIndex !== null && images[lightboxIndex] && (
                                <div
                                    className="fixed inset-0 z-[100] bg-charcoal/95 backdrop-blur-md flex flex-col items-center justify-center p-4 md:p-12 mb-0 animate-fade-in"
                                    onClick={() => setLightboxIndex(null)}
                                    role="dialog"
                                    aria-modal="true"
                                    aria-label="Photo viewer"
                                >
                                    {/* Close button */}
                                    <button onClick={() => setLightboxIndex(null)} className="absolute top-6 right-6 text-white/80 hover:text-white transition-colors cursor-pointer z-10">
                                        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                    </button>

                                    {/* Previous arrow */}
                                    <button
                                        onClick={(e) => { e.stopPropagation(); goPrev() }}
                                        className="absolute left-4 md:left-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                                    >
                                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                        </svg>
                                    </button>

                                    {/* Next arrow */}
                                    <button
                                        onClick={(e) => { e.stopPropagation(); goNext() }}
                                        className="absolute right-4 md:right-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                                    >
                                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                        </svg>
                                    </button>

                                    {/* Image Wrapper */}
                                    <div
                                        className="flex-1 w-full min-h-0 flex flex-col items-center justify-center relative z-0"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {(() => {
                                            const activeImg = images[lightboxIndex]
                                            const isLegacyOrDemo = typeof activeImg === 'string'
                                            const thumbUrl = mediaThumbnailUrl(activeImg)
                                            const activeRawUrl = mediaDisplayUrl(activeImg)

                                            return (
                                                <>
                                                    <div className="flex-1 min-h-0 flex items-center justify-center w-full relative">
                                                        {/* High-res image with faded-in loading */}
                                                        <img
                                                            key={`high-${mediaId(activeImg) || lightboxIndex}`}
                                                            src={activeRawUrl}
                                                            alt="Full size preview"
                                                            onError={() => requestMediaRefresh('media-error')}
                                                            width={activeImg.width}
                                                            height={activeImg.height}
                                                            decoding="async"
                                                            className="max-w-full max-h-full object-contain rounded-lg shadow-warm-xl relative z-20 animate-fade-in"
                                                        />

                                                        {/* Placeholder thumbnail for instant visual feedback */}
                                                        <img
                                                            src={thumbUrl}
                                                            alt=""
                                                            className="absolute inset-0 w-full h-full object-contain blur-sm scale-95 opacity-50 z-10 pointer-events-none"
                                                        />
                                                    </div>

                                                    {/* EXIF Data Overlay */}
                                                    {!isLegacyOrDemo && activeImg.exif && (
                                                        <div className="shrink-0 mt-4 text-center animate-fade-in max-w-2xl px-4">
                                                            {activeImg.exif.model && (
                                                                <p className="text-white font-medium text-sm md:text-base drop-shadow-md">
                                                                    {activeImg.exif.model}
                                                                </p>
                                                            )}
                                                            {activeImg.exif.lens && (
                                                                <p className="text-white/80 text-xs md:text-sm drop-shadow-md mb-1">
                                                                    {activeImg.exif.lens}
                                                                </p>
                                                            )}
                                                            <div className="flex items-center justify-center gap-4 text-white/70 text-xs md:text-sm font-light tracking-wide italic mt-2">
                                                                {activeImg.exif.focalLength && <span>{activeImg.exif.focalLength}</span>}
                                                                {activeImg.exif.focalRatio && <span>{activeImg.exif.focalRatio}</span>}
                                                                {activeImg.exif.shutterSpeed && <span>{activeImg.exif.shutterSpeed}</span>}
                                                                {activeImg.exif.iso && <span>{activeImg.exif.iso}</span>}
                                                            </div>
                                                        </div>
                                                    )}
                                                </>
                                            )
                                        })()}
                                    </div>

                                    {/* Download & Image counter */}
                                    <div className="shrink-0 mt-6 flex flex-col items-center gap-2 z-10" onClick={(e) => e.stopPropagation()}>
                                        <button
                                            onClick={downloadImage}
                                            className="text-white/60 hover:text-white transition-colors p-4 rounded-full cursor-pointer hover:bg-white/10 active:scale-95 touch-manipulation"
                                            title="Download Photo"
                                        >
                                            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                            </svg>
                                        </button>
                                        <span className="text-white/70 text-sm font-medium drop-shadow-md">
                                            {lightboxIndex + 1} / {images.length}
                                        </span>
                                    </div>
                                </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}

export default AlbumGallery
