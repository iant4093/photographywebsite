import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router'
import { fetchAlbum, requestAlbumMediaDownload } from '../utils/api'
import { useAuth } from '../context/auth'
import { motion } from 'framer-motion'
import ProgressiveImage from '../components/ProgressiveImage'
import VideoPlayer from '../components/VideoPlayer'
import AccessibleLightbox from '../components/AccessibleLightbox'
import AlbumQrCode from '../components/AlbumQrCode'
import {
    mediaFileName,
    mediaId,
    mediaThumbnailUrl,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import { useMediaExpiryRefresh } from '../utils/useMediaExpiryRefresh'
import { navigateBackOr } from '../utils/navigation'
import { trackAlbumView } from '../utils/analytics'

export default function VideoGallery() {
    const { albumId } = useParams()
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()
    const [album, setAlbum] = useState(null)
    const [images, setImages] = useState([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [mediaError, setMediaError] = useState('')
    const { getIdToken } = useAuth()
    const autoPlayFirst = searchParams.get('play') === '1'
    const trackedAlbumRef = useRef(null)

    // Lightbox state — null means gallery view, a number is the index in the player
    const [lightboxIndex, setLightboxIndex] = useState(null)

    const loadAlbum = useCallback(async ({ signal, background = false } = {}) => {
        if (!background) setLoading(true)
        try {
            let token = null
            try {
                token = await getIdToken()
            } catch {
                // Public albums do not require a user token.
            }

            const data = await fetchAlbum(albumId, token, { signal })
            const fetchedAlbum = data.album || data
            const fetchedImages = data.images || []
            setAlbum(fetchedAlbum)
            setImages(fetchedImages)
            setLoadError('')
            setMediaError('')
            if (!background && autoPlayFirst && fetchedImages.length > 0) {
                setLightboxIndex(0)
            }
            return data
        } catch (err) {
            if (err?.name !== 'AbortError') {
                console.error("Failed to load video album:", err)
                const message = background
                    ? 'The video link expired and could not be refreshed. Check your connection and try again.'
                    : 'Failed to load video album. It may not exist or be private.'
                if (background) setMediaError(message)
                else setLoadError(message)
            }
            throw err
        } finally {
            if (!background && !signal?.aborted) setLoading(false)
        }
    }, [albumId, autoPlayFirst, getIdToken])

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

    const refreshMedia = useCallback(
        () => loadAlbum({ background: true }),
        [loadAlbum],
    )
    const requestMediaRefresh = useMediaExpiryRefresh(images, refreshMedia)

    useEffect(() => {
        if (album?.visibility === 'public' && trackedAlbumRef.current !== albumId) {
            trackedAlbumRef.current = albumId
            trackAlbumView(albumId)
        }
    }, [album, albumId])

    const goNext = useCallback(() => {
        setLightboxIndex((i) => (i + 1) % images.length)
    }, [images.length])

    const goPrev = useCallback(() => {
        setLightboxIndex((i) => (i - 1 + images.length) % images.length)
    }, [images.length])

    const closeLightbox = useCallback(() => setLightboxIndex(null), [])

    const handleBack = () => {
        navigateBackOr(navigate, '/videos')
    }

    const downloadOriginal = async (e) => {
        e.stopPropagation()
        const video = images[lightboxIndex]
        if (!video) return

        try {
            let token = null
            try { token = await getIdToken() } catch { /* public album */ }
            const downloadUrl = await resolveMediaDownloadUrl(
                () => requestAlbumMediaDownload(albumId, mediaId(video), token),
                video,
            )
            startBrowserDownload(downloadUrl, mediaFileName(video, 'video.mp4'))
        } catch (err) {
            console.error('Download failed:', err)
            alert('The video could not be downloaded. Please try again.')
        }
    }

    const pageVariants = {
        initial: { opacity: 0, y: 15 },
        animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
        exit: { opacity: 0, y: -15, transition: { duration: 0.3, ease: "easeIn" } }
    }

    if (loading) {
        return (
            <motion.div
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="max-w-7xl mx-auto px-6 flex justify-center py-32"
            >
                <div className="w-10 h-10 border-3 border-amber border-t-transparent rounded-full animate-spin" />
            </motion.div>
        )
    }

    if (!album) {
        return (
            <motion.div
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="max-w-7xl mx-auto px-6 py-12 text-center text-warm-gray"
            >
                <p>{loadError || 'Failed to load video album. It may not exist or be private.'}</p>
                <button onClick={handleBack} className="mt-4 text-amber hover:underline">Go Back</button>
            </motion.div>
        )
    }

    return (
        <motion.div
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="linen-gallery-page max-w-7xl mx-auto px-6 py-12 pt-[100px]"
        >
            {/* Gallery View Header */}
            <button
                onClick={handleBack}
                className="linen-gallery-back inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8 cursor-pointer"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back to Videos
            </button>

            <div className="linen-gallery-header mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-warm-gray/10">
                <div>
                    <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-4 w-fit">
                        {album.title}
                    </h1>
                    {album.description && (
                        <p className="text-lg text-warm-gray max-w-2xl leading-relaxed whitespace-pre-wrap">
                            {album.description}
                        </p>
                    )}
                </div>
                <AlbumQrCode albumTitle={album.title} qrCodeUrl={album.qrCodeUrl} />
            </div>

            {mediaError && (
                <div role="alert" className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {mediaError}
                </div>
            )}

            {/* Thumbnail Grid */}
            <div className="linen-media-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {images.map((img, index) => {
                    const thumbUrl = mediaThumbnailUrl(img)
                    return (
                        <button
                            data-page-scroll-media
                            type="button"
                            key={mediaId(img) || index}
                            className="linen-media-frame group cursor-pointer rounded-xl overflow-hidden shadow-warm-sm hover:shadow-warm-lg transition-all duration-500 aspect-video relative text-left"
                            onClick={() => setLightboxIndex(index)}
                            aria-label={`Open video ${index + 1} from ${album.title}`}
                        >
                            <ProgressiveImage
                                src={thumbUrl}
                                blurhash={img.blurhash}
                                width={img.width}
                                height={img.height}
                                sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                                alt={`Video ${index + 1}`}
                                onError={() => requestMediaRefresh('media-error')}
                                className="w-full h-full object-cover"
                            />
                            {/* Play Button Overlay */}
                            <div className="absolute inset-0 bg-black/20 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                                <div className="w-16 h-16 rounded-full bg-white/30 backdrop-blur-sm flex items-center justify-center text-white shadow-lg group-hover:scale-110 transition-transform">
                                    <svg className="w-8 h-8 ml-1" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M8 5v14l11-7z" />
                                    </svg>
                                </div>
                            </div>
                        </button>
                    )
                })}
            </div>

            {/* Video Lightbox Player */}
            {lightboxIndex !== null && images[lightboxIndex] && (
                <AccessibleLightbox
                    ariaLabel={`Video player for ${album.title}`}
                    onClose={closeLightbox}
                    onNext={images.length > 1 ? goNext : undefined}
                    onPrevious={images.length > 1 ? goPrev : undefined}
                    className="linen-responsive-lightbox linen-video-lightbox fixed inset-0 z-[1000] bg-charcoal/95 backdrop-blur-md flex flex-col items-center justify-center p-4 md:p-12 animate-fade-in"
                >
                    {/* Close button */}
                    <button
                        type="button"
                        onClick={closeLightbox}
                        className="linen-lightbox-close fixed z-[1001] w-12 h-12 text-white/80 hover:text-white transition-colors cursor-pointer flex items-center justify-center"
                        style={{
                            top: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))',
                            right: 'max(1rem, calc(env(safe-area-inset-right) + 0.5rem))',
                        }}
                        title="Close Player"
                        aria-label="Close video player"
                        data-lightbox-initial-focus
                    >
                        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>

                    {/* Navigation Arrows (only if > 1 video) */}
                    {images.length > 1 && (
                        <nav className="linen-lightbox-nav" aria-label="Video navigation">
                            <button
                                onClick={goPrev}
                                className="linen-lightbox-previous absolute left-4 md:left-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                                aria-label="Previous video"
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                </svg>
                            </button>
                            <button
                                onClick={goNext}
                                className="linen-lightbox-next absolute right-4 md:right-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                                aria-label="Next video"
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>
                        </nav>
                    )}

                    {/* React Player Container */}
                    <div className="linen-lightbox-content flex-1 w-full max-w-6xl min-h-0 flex items-center justify-center relative shadow-2xl bg-black rounded-none md:rounded-xl overflow-hidden">
                        <VideoPlayer
                            videoInfo={images[lightboxIndex]}
                            autoplay={true}
                            controls={true}
                            onMediaError={requestMediaRefresh}
                        />
                    </div>

                    {/* Download & Counter */}
                    <div className="linen-lightbox-actions shrink-0 mt-6 flex flex-col items-center gap-2 z-10">
                        <button
                            onClick={downloadOriginal}
                            className="text-white/60 hover:text-white transition-colors p-4 rounded-full cursor-pointer hover:bg-white/10 active:scale-95 touch-manipulation"
                            title="Download Video"
                            aria-label="Download video"
                        >
                            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                        </button>
                        {images.length > 1 && (
                            <span className="text-white/70 text-sm font-medium drop-shadow-md">
                                {lightboxIndex + 1} / {images.length}
                            </span>
                        )}
                    </div>
                </AccessibleLightbox>
            )}
        </motion.div>
    )
}
