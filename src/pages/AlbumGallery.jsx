import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { fetchAlbum } from '../utils/api'
import { useAuth } from '../context/authContext'
import JSZip from 'jszip'
import { motion, AnimatePresence } from 'framer-motion'
import ProgressiveImage from '../components/ProgressiveImage'
import SkeletonGrid from '../components/SkeletonGrid'



// Album gallery page — displays all images in a masonry-like grid
function AlbumGallery() {
    const { albumId } = useParams()
    const navigate = useNavigate()
    const [album, setAlbum] = useState(null)
    const [images, setImages] = useState([])
    const [loading, setLoading] = useState(true)
    const [downloading, setDownloading] = useState(false)
    const { getIdToken } = useAuth()
    // Lightbox state — store index for prev/next navigation
    const [lightboxIndex, setLightboxIndex] = useState(null)

    // Fetch album data on mount
    useEffect(() => {
        const load = async () => {
            let token = null
            try {
                token = await getIdToken()
            } catch (e) {
                // Not logged in, token stays null
            }
            try {
                const data = await fetchAlbum(albumId, token)
                setAlbum(data.album || data)
                setImages(data.images || [])
            } catch (err) {
                console.error("Failed to load album:", err)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [albumId, getIdToken])

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

        const isLegacyOrDemo = typeof img === 'string' || !img.thumbKey
        const urlToDownload = isLegacyOrDemo ? (img.url || img) : `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${img.rawKey}`
        const keyString = isLegacyOrDemo ? (typeof img === 'string' ? img : img.key) : img.rawKey
        const fileName = keyString ? keyString.split('/').pop() : 'photo.jpg'

        try {
            // Reverted back to cache: no-store instead of dynamic timestamps because iOS Safari 
            // natively parses this correctly into a View/Download prompt, while dynamic urls throw CORS errors and get popup blocked.
            const urlObj = new URL(urlToDownload)
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
            console.error('Download failed, falling back to direct navigation:', err)
            // window.open() inside an async catch block is heavily blocked by iOS Safari popup blockers.
            // Using window.location.assign gracefully navigates the user directly to the image where they can save it.
            window.location.assign(urlToDownload)
        }
    }

    // Download all photos in the album as a ZIP file
    async function downloadAll() {
        if (!images.length) return
        setDownloading(true)
        try {
            const zip = new JSZip()
            const folderName = album?.title || 'album'
            const folder = zip.folder(folderName)

            // Process images in batches to prevent memory exhaustion during fetch
            const BATCH_SIZE = 5;
            for (let i = 0; i < images.length; i += BATCH_SIZE) {
                const batch = images.slice(i, i + BATCH_SIZE);
                const fetchPromises = batch.map(async (img, indexInBatch) => {
                    const index = i + indexInBatch;
                    try {
                        const isLegacyOrDemo = typeof img === 'string' || !img.thumbKey
                        const rawUrl = isLegacyOrDemo ? (img.url || img) : `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${img.rawKey}`
                        const urlObj = new URL(rawUrl)
                        urlObj.searchParams.set('dl', '1')

                        const response = await fetch(urlObj.toString(), { mode: 'cors', cache: 'no-store' })
                        if (!response.ok) throw new Error(`HTTP error ${response.status}`)
                        const blob = await response.blob()
                        // Handle objects vs raw strings for demo images
                        const keyString = isLegacyOrDemo ? (typeof img === 'string' ? img : img.key) : img.rawKey
                        const fileName = keyString ? keyString.split('/').pop() : `photo-${index + 1}.jpg`
                        folder.file(fileName, blob)
                    } catch (err) {
                        console.error('Failed to fetch image for zip:', err)
                    }
                })

                // Wait for the current batch to finish before starting the next
                await Promise.all(fetchPromises)
            }

            const zipBlob = await zip.generateAsync({ type: 'blob' })
            const url = URL.createObjectURL(zipBlob)
            const a = document.createElement('a')
            a.href = url
            a.download = `${folderName}.zip`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
        } catch (err) {
            console.error('ZIP Download failed:', err)
        } finally {
            setDownloading(false)
        }
    }

    const pageVariants = {
        initial: { opacity: 0, y: 15 },
        animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
        exit: { opacity: 0, y: -15, transition: { duration: 0.3, ease: "easeIn" } }
    }

    return (
        <motion.div
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex-1 bg-cream animate-fade-in pb-16"
        >
            <div className="max-w-7xl mx-auto px-6 pt-8 md:pt-12">
                {/* Back link — uses browser back to preserve scroll position */}
                <button
                    onClick={() => navigate(-1)}
                    className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8 cursor-pointer"
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

                {/* Album content */}
                {!loading && album && (
                    <div>
                        {/* Album header with slide-up animation */}
                        <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-warm-gray/10 animate-fade-in">
                            <div className="animate-slide-up">
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
                                            Zipping...
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

                        {/* Image grid */}
                        <div className="mb-12">
                            {loading ? (
                                <SkeletonGrid count={6} type="photo" />
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {images.slice(0, 100).map((img, index) => {
                                        const isLegacyOrDemo = typeof img === 'string' || !img.thumbKey
                                        const thumbUrl = isLegacyOrDemo
                                            ? (img.url || img)
                                            : `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${img.thumbKey}`

                                        return (
                                            <motion.div
                                                key={img.key || img.rawKey || index}
                                                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                                                whileInView={{ opacity: 1, scale: 1, y: 0 }}
                                                viewport={{ once: true, margin: "100px" }}
                                                transition={{ duration: 0.5, ease: "easeOut", delay: (index % 6) * 0.08 }}
                                                className="group cursor-pointer rounded-xl overflow-hidden shadow-warm-sm hover:shadow-warm-lg transition-shadow duration-500 aspect-[4/3] relative"
                                                onClick={() => setLightboxIndex(index)}
                                            >
                                                <div className="relative w-full h-full">
                                                    <ProgressiveImage
                                                        layoutId={`photo-${img.rawKey || index}`}
                                                        src={thumbUrl}
                                                        blurhash={img.blurhash}
                                                        alt={`Item ${index + 1} from ${album.title}`}
                                                        className="w-full h-full group-hover:scale-[1.02] transition-transform duration-700 ease-out"
                                                    />
                                                    {/* Warm overlay on hover */}
                                                    <div className="absolute inset-0 bg-gradient-to-t from-charcoal/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                                                </div>
                                            </motion.div>
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
                        <AnimatePresence>
                            {lightboxIndex !== null && images[lightboxIndex] && (
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="fixed inset-0 z-[100] bg-charcoal/95 backdrop-blur-md flex flex-col items-center justify-center p-4 md:p-12"
                                    onClick={() => setLightboxIndex(null)}
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
                                    <div className="flex-1 w-full min-h-0 flex flex-col items-center justify-center relative z-0" onClick={(e) => e.stopPropagation()}>
                                        {(() => {
                                            const activeImg = images[lightboxIndex]
                                            const isLegacyOrDemo = typeof activeImg === 'string' || !activeImg.thumbKey
                                            const activeRawUrl = isLegacyOrDemo ? (activeImg.url || activeImg) : `https://${import.meta.env.VITE_CLOUDFRONT_DOMAIN}/${activeImg.rawKey}`
                                            return (
                                                <>
                                                    <div className="flex-1 min-h-0 flex items-center justify-center w-full">
                                                        <motion.img
                                                            layoutId={`photo-${activeImg.rawKey || lightboxIndex}`}
                                                            src={activeRawUrl}
                                                            alt="Full size preview"
                                                            className="max-w-full max-h-full object-contain rounded-lg shadow-warm-xl"
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
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                )}
            </div>
        </motion.div>
    )
}

export default AlbumGallery
