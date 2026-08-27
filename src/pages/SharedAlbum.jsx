import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router'
import { fetchSharedAlbum, requestSharedAlbumZip, requestSharedMediaDownload, requestSharedPrintSession } from '../utils/api'
import ProgressiveImage from '../components/ProgressiveImage'
import VideoPlayer from '../components/VideoPlayer'
import { motion } from 'framer-motion'
import { Turnstile } from '@marsidev/react-turnstile'
import {
    mediaFileName,
    mediaId,
    mediaPreviewSrcSet,
    mediaThumbnailUrl,
    resolveMediaDownloadUrl,
    startBrowserDownload,
} from '../utils/mediaUrls'
import { useMediaExpiryRefresh } from '../utils/useMediaExpiryRefresh'
import { pollZipJob } from '../utils/zipDownload'
import AlbumQrCode from '../components/AlbumQrCode'
import AlbumShareButton from '../components/AlbumShareButton'
import AccessibleLightbox from '../components/AccessibleLightbox'
import PhotoLightbox from '../components/PhotoLightbox'
import { openPrintOrder } from '../utils/printOrders'

export default function SharedAlbum() {
    const { code } = useParams()
    const navigate = useNavigate()

    const [album, setAlbum] = useState(null)
    const [images, setImages] = useState([])
    const [loading, setLoading] = useState(Boolean(code))
    const [downloading, setDownloading] = useState(false)
    const [error, setError] = useState(null)
    const [inputCode, setInputCode] = useState('')
    const [turnstileToken, setTurnstileToken] = useState(null)
    const [accessMessage, setAccessMessage] = useState('')
    const [zipError, setZipError] = useState('')
    const [zipStatus, setZipStatus] = useState('')
    const zipControllerRef = useRef(null)

    // Lightbox
    const [lightboxIndex, setLightboxIndex] = useState(null)

    // Attempt to load album if code is present in URL
    useEffect(() => {
        if (!code || !turnstileToken) {
            return undefined
        }

        const controller = new AbortController()
        Promise.resolve().then(() => {
            if (controller.signal.aborted) return null
            setLoading(true)
            setError(null)
            return fetchSharedAlbum(code, turnstileToken, { signal: controller.signal })
        }).then(data => {
            if (!data) return
            setAlbum(data.album || data)
            setImages(data.images || [])
            setAccessMessage('')
            setLoading(false)
        }).catch(err => {
            if (err?.name !== 'AbortError') {
                setError(err.message || 'The gallery could not be loaded. Please check your connection or try again later.')
                setLoading(false)
            }
        })
        return () => controller.abort()
    }, [code, turnstileToken])

    useEffect(() => () => zipControllerRef.current?.abort(), [])

    const requireFreshVerification = useCallback(() => {
        setAccessMessage('The gallery session expired. Complete a new security check to refresh its protected media links.')
        setTurnstileToken(null)
        setAlbum(null)
        setImages([])
        setLightboxIndex(null)
        setLoading(false)
    }, [])
    const requestMediaRefresh = useMediaExpiryRefresh(images, requireFreshVerification)

    const handleManualSubmit = (e) => {
        e.preventDefault()
        let val = inputCode.trim()
        if (val) {
            setLoading(true)
            setError(null)
            // Handle full URL pastes naturally
            const parts = val.split('/').filter(Boolean)
            if (parts.length > 0) {
                val = parts[parts.length - 1]
            }
            navigate(`/sharedalbum/${val}`)
        }
    }

    // Lightbox navigation
    const goNext = useCallback(() => {
        setLightboxIndex((i) => (i + 1) % images.length)
    }, [images.length])

    const goPrev = useCallback(() => {
        setLightboxIndex((i) => (i - 1 + images.length) % images.length)
    }, [images.length])
    const closeLightbox = useCallback(() => setLightboxIndex(null), [])

    // Download a single image
    const downloadImage = async (e) => {
        e.stopPropagation()
        const img = images[lightboxIndex]
        if (!img) return

        try {
            const downloadUrl = await resolveMediaDownloadUrl(
                () => requestSharedMediaDownload(code, mediaId(img)),
                img,
            )
            startBrowserDownload(downloadUrl, mediaFileName(img, 'photo.jpg'))
        } catch (err) {
            console.error('Download failed:', err)
            alert('The file could not be downloaded. Please try again.')
        }
    }

    const printImage = async (event, image) => {
        event.stopPropagation()
        if (!image) return
        try {
            await openPrintOrder(() => requestSharedPrintSession(code, mediaId(image)))
        } catch (printError) {
            console.error('Print order failed:', printError)
            alert(printError?.message || 'The print store could not be opened. Please try again.')
        }
    }

    // Download all photos in the album as a ZIP file (Using Backend Generator)
    async function downloadAll() {
        if (!images.length || !album || !code || album.type === 'video') return
        zipControllerRef.current?.abort()
        const controller = new AbortController()
        zipControllerRef.current = controller
        setDownloading(true)
        setZipError('')
        setZipStatus('starting')
        try {
            const url = await pollZipJob({
                jobKey: `shared:${code}`,
                request: ({ signal }) => requestSharedAlbumZip(code, { signal }),
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

    const pageVariants = {
        initial: { opacity: 0, y: 15 },
        animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
        exit: { opacity: 0, y: -15, transition: { duration: 0.3, ease: "easeIn" } }
    }

    // State 1: No code in URL, show manual entry
    if (!code) {
        return (
            <motion.div
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="linen-shared-gate max-w-md mx-auto px-6 py-24 text-center pt-[112px]"
            >
                <svg className="w-16 h-16 mx-auto text-amber mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <h1 className="font-serif text-3xl font-semibold text-charcoal mb-4">View Shared Album</h1>
                <p className="text-warm-gray mb-8">Enter the unique access code provided to you.</p>

                <form onSubmit={handleManualSubmit} className="flex flex-col gap-3">
                    <input
                        type="text"
                        placeholder="e.g. xY7bQk9P"
                        value={inputCode}
                        onChange={(e) => setInputCode(e.target.value)}
                        className="w-full px-6 py-4 rounded-xl border border-warm-border bg-charcoal/5 text-charcoal text-center text-xl tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all shadow-inner"
                    />
                    <button type="submit" disabled={!inputCode.trim() || !turnstileToken} className="shared-album-submit w-full py-4 rounded-xl bg-charcoal text-white font-medium hover:bg-charcoal-light transition-colors duration-300 shadow-warm disabled:opacity-50">
                        Access Gallery
                    </button>
                </form>
                <div className="mt-8 flex justify-center">
                    <Turnstile
                        siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY}
                        onSuccess={(token) => setTurnstileToken(token)}
                        onExpire={() => setTurnstileToken(null)}
                        onError={() => setTurnstileToken(null)}
                        options={{ theme: 'light', action: 'shared_album' }}
                    />
                </div>
            </motion.div>
        )
    }

    // A pasted/bookmarked share URL must obtain its own purpose-bound token
    // before the album request is made.
    if (code && !turnstileToken && !error) {
        return (
            <motion.div
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="linen-shared-gate max-w-md mx-auto px-6 py-24 text-center pt-[112px]"
            >
                <h1 className="font-serif text-3xl font-semibold text-charcoal mb-4">Verify Access</h1>
                <p className="text-warm-gray mb-8">{accessMessage || 'Complete the security check to open this shared gallery.'}</p>
                <div className="flex justify-center">
                    <Turnstile
                        siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY}
                        onSuccess={(token) => setTurnstileToken(token)}
                        onExpire={() => setTurnstileToken(null)}
                        onError={() => setError('The security check could not be loaded. Please try again.')}
                        options={{ theme: 'light', action: 'shared_album' }}
                    />
                </div>
            </motion.div>
        )
    }

    // State 2: Error loading or bad code
    if (error) {
        return (
            <motion.div
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="linen-shared-gate max-w-md mx-auto px-6 py-24 text-center pt-[112px]"
            >
                <svg className="w-16 h-16 mx-auto text-red-400 mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <h1 className="font-serif text-2xl font-semibold text-charcoal mb-3">Link Invalid</h1>
                <p className="text-warm-gray mb-8">{error}</p>
                <button
                    onClick={() => {
                        setTurnstileToken(null)
                        setError(null)
                        navigate('/sharedalbum')
                    }}
                    className="inline-flex items-center gap-2 px-6 py-2.5 bg-white border border-warm-border rounded-xl text-charcoal font-medium hover:bg-cream-dark transition-colors"
                >
                    Try another code
                </button>
            </motion.div>
        )
    }

    // State 3: Loading album
    if (loading || !album) {
        return (
            <motion.div
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="flex flex-col flex-1 items-center justify-center py-32 pt-[88px] md:pt-[104px]"
            >
                <div className="w-12 h-12 border-4 border-amber border-t-transparent rounded-full animate-spin"></div>
                <p className="mt-4 text-warm-gray font-medium">Accessing gallery...</p>
            </motion.div>
        )
    }

    // State 4: Album Loaded — Render Grid
    return (
        <motion.div
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="linen-gallery-page max-w-7xl mx-auto px-6 py-12 pt-[100px]"
        >
            <div className="animate-fade-in">
                {/* Album header */}
                <div className="linen-gallery-header mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-warm-gray/10">
                    <div>
                        <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-4">
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
                            <AlbumShareButton albumTitle={album.title} />
                            <AlbumQrCode
                                albumTitle={album.title}
                                qrCodeUrl={album.qrCodeUrl}
                                onLoadError={requireFreshVerification}
                            />
                            {images.length > 0 && (
                                <button
                                    onClick={downloadAll}
                                    disabled={downloading}
                                    className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium transition-all duration-300 shadow-warm-sm border border-transparent disabled:opacity-70 disabled:cursor-not-allowed bg-amber text-white hover:bg-amber-dark cursor-pointer"
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

                {zipError && (
                    <div role="alert" className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {zipError}
                    </div>
                )}

                {/* Image grid */}
                <div className="linen-media-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {images.map((img, index) => {
                        const thumbUrl = mediaThumbnailUrl(img)

                        return (
                            <button
                                data-page-scroll-media
                                type="button"
                                key={mediaId(img) || index}
                                className="linen-media-frame group cursor-pointer rounded-xl overflow-hidden shadow-warm-sm hover:shadow-warm-lg transition-all duration-500 aspect-[4/3] relative text-left"
                                onClick={() => setLightboxIndex(index)}
                                aria-label={`Open item ${index + 1} from ${album.title}`}
                            >
                                <div
                                    className="w-full h-full relative"
                                >
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
                                </div>
                                {album.type === 'video' && (
                                    <div className="absolute inset-0 bg-black/20 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                                        <div className="w-16 h-16 rounded-full bg-white/30 backdrop-blur-sm flex items-center justify-center text-white shadow-lg group-hover:scale-110 transition-transform">
                                            <svg className="w-8 h-8 ml-1" fill="currentColor" viewBox="0 0 24 24">
                                                <path d="M8 5v14l11-7z" />
                                            </svg>
                                        </div>
                                    </div>
                                )}
                            </button>
                        )
                    })}
                </div>

                {/* Empty state */}
                {images.length === 0 && (
                    <div className="text-center py-20 text-warm-gray">
                        <p className="text-lg">No photos in this album yet.</p>
                    </div>
                )}
            </div>

            {lightboxIndex !== null && images[lightboxIndex] && album.type !== 'video' && (
                <PhotoLightbox
                    images={images}
                    index={lightboxIndex}
                    ariaLabel={`Photo viewer for ${album.title}`}
                    onClose={closeLightbox}
                    onNext={goNext}
                    onPrevious={goPrev}
                    onDownload={downloadImage}
                    onPrint={printImage}
                    shareTitle={`${album.title} — Ian Truong Photography`}
                    onMediaError={() => requestMediaRefresh('media-error')}
                />
            )}

            {lightboxIndex !== null && images[lightboxIndex] && album.type === 'video' && (
                <AccessibleLightbox
                    ariaLabel={`Video player for ${album.title}`}
                    onClose={closeLightbox}
                    onNext={images.length > 1 ? goNext : undefined}
                    onPrevious={images.length > 1 ? goPrev : undefined}
                    className="linen-responsive-lightbox linen-video-lightbox fixed inset-0 z-[1000] bg-charcoal/90 flex flex-col items-center justify-center p-4 md:p-12"
                >
                        <button type="button" onClick={closeLightbox} className="linen-lightbox-close fixed z-[1001] w-12 h-12 text-white/80 hover:text-white transition-colors cursor-pointer flex items-center justify-center" aria-label="Close video player" data-lightbox-initial-focus>
                            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>

                        {images.length > 1 && (
                            <nav className="linen-lightbox-nav" aria-label="Video navigation">
                                <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); goPrev() }}
                                    className="linen-lightbox-previous absolute left-4 md:left-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                                    aria-label="Previous video"
                                >
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                </button>
                                <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); goNext() }}
                                    className="linen-lightbox-next absolute right-4 md:right-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                                    aria-label="Next video"
                                >
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                </button>
                            </nav>
                        )}

                        <div className="linen-lightbox-content flex-1 w-full max-w-6xl min-h-0 flex items-center justify-center relative shadow-2xl bg-black overflow-hidden" onClick={(e) => e.stopPropagation()}>
                            <VideoPlayer
                                videoInfo={images[lightboxIndex]}
                                autoplay={true}
                                controls={true}
                                onMediaError={requestMediaRefresh}
                            />
                        </div>

                        <div className="linen-lightbox-actions shrink-0 mt-6 flex flex-col items-center gap-2 z-10" onClick={(e) => e.stopPropagation()}>
                            <button
                                type="button"
                                onClick={downloadImage}
                                className="text-white/60 hover:text-white transition-colors p-4 rounded-full cursor-pointer hover:bg-white/10 active:scale-95 touch-manipulation"
                                title="Download Video"
                                aria-label="Download video"
                            >
                                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                            </button>
                            <span className="text-white/70 text-sm font-medium drop-shadow-md">
                                {lightboxIndex + 1} / {images.length}
                            </span>
                        </div>
                </AccessibleLightbox>
            )}
        </motion.div>
    )
}
