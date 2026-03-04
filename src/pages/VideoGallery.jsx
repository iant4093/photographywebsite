import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { fetchAlbum } from '../utils/api'
import { useAuth } from '../context/authContext'
import { motion } from 'framer-motion'
import ProgressiveImage from '../components/ProgressiveImage'
import VideoPlayer from '../components/VideoPlayer'

export default function VideoGallery() {
    const { albumId } = useParams()
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()
    const [album, setAlbum] = useState(null)
    const [images, setImages] = useState([])
    const [loading, setLoading] = useState(true)
    const { getIdToken } = useAuth()

    // Lightbox state — null means gallery view, a number is the index in the player
    const [lightboxIndex, setLightboxIndex] = useState(null)

    useEffect(() => {
        const load = async () => {
            let token = null
            try {
                token = await getIdToken()
            } catch (e) { }

            try {
                const data = await fetchAlbum(albumId, token)
                const fetchedAlbum = data.album || data
                const fetchedImages = data.images || []

                setAlbum(fetchedAlbum)
                setImages(fetchedImages)

                if (searchParams.get('play') === '1' && fetchedImages.length > 0) {
                    setLightboxIndex(0)
                }
            } catch (err) {
                console.error("Failed to load video album:", err)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [albumId, getIdToken])

    const goNext = useCallback(() => {
        setLightboxIndex((i) => (i + 1) % images.length)
    }, [images.length])

    const goPrev = useCallback(() => {
        setLightboxIndex((i) => (i - 1 + images.length) % images.length)
    }, [images.length])

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

    const handleBack = () => {
        navigate(-1)
    }

    const downloadOriginal = async (e) => {
        e.stopPropagation()
        const video = images[lightboxIndex]
        if (!video || !video.rawKey) return

        const rawUrl = `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${video.rawKey}`
        const fileName = video.rawKey.split('/').pop() || 'video.mp4'

        try {
            const urlObj = new URL(rawUrl)
            urlObj.searchParams.set('dl', '1')
            const response = await fetch(urlObj.toString(), { mode: 'cors', cache: 'no-store' })
            const blob = await response.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = fileName
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => URL.revokeObjectURL(url), 100)
        } catch (err) {
            console.error('Download failed, falling back:', err)
            window.location.assign(rawUrl)
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
                <p>Failed to load video album. It may not exist or be private.</p>
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
            className="max-w-7xl mx-auto px-6 py-12 pt-[88px] md:pt-[104px]"
        >
            {/* Gallery View Header */}
            <button
                onClick={handleBack}
                className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8 cursor-pointer"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back
            </button>

            <div className="mb-12">
                <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-4 w-fit">
                    {album.title}
                </h1>
                {album.description && (
                    <p className="text-lg text-warm-gray max-w-2xl leading-relaxed whitespace-pre-wrap">
                        {album.description}
                    </p>
                )}
            </div>

            {/* Thumbnail Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {images.map((img, index) => {
                    const thumbUrl = `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${img.thumbKey}`
                    return (
                        <div
                            key={img.rawKey || index}
                            className="group cursor-pointer rounded-xl overflow-hidden shadow-warm-sm hover:shadow-warm-lg transition-all duration-500 aspect-video relative"
                            onClick={() => setLightboxIndex(index)}
                        >
                            <ProgressiveImage
                                src={thumbUrl}
                                blurhash={img.blurhash}
                                alt={`Video ${index + 1}`}
                                className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-700 ease-out"
                            />
                            {/* Play Button Overlay */}
                            <div className="absolute inset-0 bg-black/20 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                                <div className="w-16 h-16 rounded-full bg-white/30 backdrop-blur-sm flex items-center justify-center text-white shadow-lg group-hover:scale-110 transition-transform">
                                    <svg className="w-8 h-8 ml-1" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M8 5v14l11-7z" />
                                    </svg>
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* Video Lightbox Player */}
            {lightboxIndex !== null && images[lightboxIndex] && (
                <div
                    className="fixed inset-0 z-[100] bg-charcoal/95 backdrop-blur-md flex flex-col items-center justify-center p-4 md:p-12 animate-fade-in"
                >
                    {/* Close button */}
                    <button
                        onClick={() => setLightboxIndex(null)}
                        className="absolute top-6 right-6 text-white/80 hover:text-white transition-colors cursor-pointer z-10"
                        title="Close Player"
                    >
                        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>

                    {/* Navigation Arrows (only if > 1 video) */}
                    {images.length > 1 && (
                        <>
                            <button
                                onClick={goPrev}
                                className="absolute left-4 md:left-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                </svg>
                            </button>
                            <button
                                onClick={goNext}
                                className="absolute right-4 md:right-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/10 hover:bg-white/25 backdrop-blur-sm text-white flex items-center justify-center transition-all cursor-pointer z-10"
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>
                        </>
                    )}

                    {/* React Player Container */}
                    <div className="flex-1 w-full max-w-6xl min-h-0 flex items-center justify-center relative shadow-2xl bg-black rounded-none md:rounded-xl overflow-hidden">
                        <VideoPlayer videoInfo={images[lightboxIndex]} autoplay={true} controls={true} />
                    </div>

                    {/* Download & Counter */}
                    <div className="shrink-0 mt-6 flex flex-col items-center gap-2 z-10">
                        <button
                            onClick={downloadOriginal}
                            className="text-white/60 hover:text-white transition-colors p-4 rounded-full cursor-pointer hover:bg-white/10 active:scale-95 touch-manipulation"
                            title="Download Video"
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
                </div>
            )}
        </motion.div>
    )
}
