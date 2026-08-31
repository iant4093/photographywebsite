import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router'
import { fetchAlbum, requestAlbumMediaDownload, requestAlbumZip } from '../utils/api'
import { useAuth } from '../context/auth'
import { motion } from 'framer-motion'
import ProgressiveImage from '../components/ProgressiveImage'
import VideoPlayer from '../components/VideoPlayer'
import AccessibleLightbox from '../components/AccessibleLightbox'
import LightboxShareButton from '../components/LightboxShareButton'
import AlbumQrCode from '../components/AlbumQrCode'
import AlbumShareButton from '../components/AlbumShareButton'
import {
    mediaFileName,
    mediaId,
    mediaThumbnailUrl,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import { useMediaExpiryRefresh } from '../utils/useMediaExpiryRefresh'
import { navigateBackOr } from '../utils/navigation'
import { pollZipJob } from '../utils/zipDownload'
import { trackAlbumView, trackZipRequest } from '../utils/analytics'
import { shareUrlForAlbumVideo } from '../utils/share'

export default function VideoGallery() {
    const { albumId } = useParams()
    const navigate = useNavigate()
    const [searchParams, setSearchParams] = useSearchParams()
    const [album, setAlbum] = useState(null)
    const [images, setImages] = useState([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [mediaError, setMediaError] = useState('')
    const [downloadingAll, setDownloadingAll] = useState(false)
    const [zipError, setZipError] = useState('')
    const [zipStatus, setZipStatus] = useState('')
    const { getIdToken } = useAuth()
    const autoPlayFirst = searchParams.get('play') === '1'
    const initialSharedVideoIdRef = useRef(searchParams.get('video'))
    const trackedAlbumRef = useRef(null)
    const zipControllerRef = useRef(null)

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
            if (!background) {
                const requestedIndex = initialSharedVideoIdRef.current
                    ? fetchedImages.findIndex(video => mediaId(video) === initialSharedVideoIdRef.current)
                    : -1
                if (requestedIndex >= 0) setLightboxIndex(requestedIndex)
                else if (autoPlayFirst && fetchedImages.length > 0) setLightboxIndex(0)
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

    useEffect(() => () => zipControllerRef.current?.abort(), [])

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

    const closeLightbox = useCallback(() => {
        setLightboxIndex(null)
        if (!searchParams.get('video')) return
        const nextParams = new URLSearchParams(searchParams)
        nextParams.delete('video')
        setSearchParams(nextParams, { replace: true, preventScrollReset: true })
    }, [searchParams, setSearchParams])

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

    const downloadAll = async () => {
        if (!images.length || !album) return
        zipControllerRef.current?.abort()
        const controller = new AbortController()
        zipControllerRef.current = controller
        setDownloadingAll(true)
        setZipError('')
        setZipStatus('starting')
        if (album.visibility === 'public') trackZipRequest(albumId)
        try {
            let token = null
            try { token = await getIdToken() } catch { /* public album */ }
            const url = await pollZipJob({
                jobKey: `album:${albumId}`,
                request: ({ signal }) => requestAlbumZip(albumId, token, { signal }),
                signal: controller.signal,
                onStatus: setZipStatus,
            })
            startBrowserDownload(url, `${album.title || 'video-album'}.zip`)
        } catch (error) {
            if (error?.name !== 'AbortError') {
                console.error('Video ZIP download failed:', error)
                setZipError(error?.message || 'The ZIP could not be generated. Please try again later.')
            }
        } finally {
            if (zipControllerRef.current === controller) {
                zipControllerRef.current = null
                setDownloadingAll(false)
                setZipStatus('')
            }
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
                <div className="flex flex-col items-stretch gap-3 shrink-0 mb-1">
                    {album.visibility === 'public' && <AlbumShareButton albumTitle={album.title} />}
                    <AlbumQrCode albumTitle={album.title} qrCodeUrl={album.qrCodeUrl} />
                    {images.length > 0 && (
                        <button
                            type="button"
                            onClick={downloadAll}
                            disabled={downloadingAll}
                            className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium transition-all duration-300 shadow-warm-sm border border-transparent disabled:opacity-70 disabled:cursor-not-allowed bg-amber text-white hover:bg-amber-dark hover:scale-105 active:scale-95 cursor-pointer"
                        >
                            {downloadingAll ? (
                                <>
                                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    {zipStatus === 'rate_limited' ? 'Waiting...' : 'Preparing...'}
                                </>
                            ) : (
                                <>
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
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
                    className="linen-responsive-lightbox linen-video-lightbox fixed inset-0 z-[1000] bg-charcoal/90 flex flex-col items-center justify-center p-4 md:p-12"
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

                    {/* Share, download & counter */}
                    <div className="linen-lightbox-actions shrink-0 mt-6 flex flex-col items-center gap-2 z-10">
                        <div className="linen-lightbox-action-buttons flex items-center justify-center gap-2">
                            {album.visibility === 'public' && (
                                <LightboxShareButton
                                    media={images[lightboxIndex]}
                                    index={lightboxIndex}
                                    mediaType="video"
                                    shareTitle={`${album.title} — Ian Truong Photography`}
                                    shareUrl={video => shareUrlForAlbumVideo(albumId, mediaId(video))}
                                />
                            )}
                            <button
                                type="button"
                                onClick={downloadOriginal}
                                className="linen-lightbox-download inline-flex items-center gap-2 rounded-full border border-white/30 px-4 py-2.5 text-sm text-white/80 transition-colors hover:border-white/60 hover:bg-white/10 hover:text-white active:scale-[0.98] cursor-pointer touch-manipulation"
                                title="Download Video"
                                aria-label="Download video"
                            >
                                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                                <span>Download</span>
                            </button>
                        </div>
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
